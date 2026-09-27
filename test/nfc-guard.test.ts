import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test, describe, before, after } from 'node:test';

import {
  detectForm,
  normalizePath,
  platformSensitivity,
  sameFile,
  NormalizedSet,
  NormalizedMap,
  scan,
  ScanError,
  groupByNormalizedForm,
} from '../src/index.ts';

const NFC = 'café.txt'.normalize('NFC');
const NFD = 'café.txt'.normalize('NFD');

describe('the asymmetry this package exists to catch', () => {
  test('NFC and NFD spellings of the same name are different JS strings', () => {
    assert.notEqual(NFC, NFD);
    assert.equal(NFC.length, 8); // c a f é . t x t
    assert.equal(NFD.length, 9); // c a f e ´ . t x t  (combining acute is its own code unit)
  });

  test('a plain Set misses the file — the textbook bug', () => {
    const naive = new Set<string>();
    naive.add(NFC);
    assert.equal(naive.has(NFD), false);
  });

  test('APFS (this machine, Darwin) really does fold the two spellings into one file', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nfc-guard-'));
    try {
      await fs.writeFile(path.join(dir, NFC), 'first');
      assert.equal(await fs.readFile(path.join(dir, NFC), 'utf8'), 'first');
      // Reading back via the *other* spelling finds the same file, unlike the Set above.
      assert.equal(await fs.readFile(path.join(dir, NFD), 'utf8'), 'first');

      // Writing the NFD spelling overwrites the same directory entry rather
      // than creating a second one: only one name ever shows up in the listing.
      await fs.writeFile(path.join(dir, NFD), 'second');
      const listing = await fs.readdir(dir);
      assert.equal(listing.length, 1, `expected one directory entry, got ${JSON.stringify(listing)}`);
      assert.equal(await fs.readFile(path.join(dir, NFC), 'utf8'), 'second');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('normalize helpers', () => {
  test('platformSensitivity: darwin is insensitive, linux and win32 are sensitive', () => {
    assert.equal(platformSensitivity('darwin'), 'insensitive');
    assert.equal(platformSensitivity('linux'), 'sensitive');
    assert.equal(platformSensitivity('win32'), 'sensitive');
  });

  test('platformSensitivity defaults to the running platform', () => {
    assert.equal(platformSensitivity(), platformSensitivity(process.platform));
  });

  test('normalizePath converts between forms', () => {
    assert.equal(normalizePath(NFD, 'NFC'), NFC);
    assert.equal(normalizePath(NFC, 'NFD'), NFD);
  });

  test('detectForm identifies NFC-only, NFD-only, both (ASCII), and other', () => {
    assert.equal(detectForm(NFC), 'NFC');
    assert.equal(detectForm(NFD), 'NFD');
    assert.equal(detectForm('plain-ascii-name.txt'), 'both');
    // A combining sequence in non-canonical order is neither canonical form:
    // acute (combining class 230) before dot-below (class 220) is backwards:
    // NFC recomposes+reorders to "ẹ́" (U+1EB9 U+0301), NFD reorders to
    // U+0065 U+0323 U+0301 — neither matches this string's own code points.
    const other = 'ẹ́';
    assert.equal(detectForm(other), 'other');
  });

  test('sameFile: insensitive rules treat NFC/NFD spellings as the same file', () => {
    assert.equal(sameFile(NFC, NFD, { sensitivity: 'insensitive' }), true);
  });

  test('sameFile: sensitive rules (Linux/NTFS) treat them as two different files', () => {
    assert.equal(sameFile(NFC, NFD, { sensitivity: 'sensitive' }), false);
  });

  test('sameFile defaults to this platform (Darwin => insensitive)', () => {
    assert.equal(sameFile(NFC, NFD), true);
  });
});

describe('NormalizedSet / NormalizedMap', () => {
  test('NormalizedSet fixes the textbook bug under insensitive rules', () => {
    const set = new NormalizedSet([], { sensitivity: 'insensitive' });
    set.add(NFC);
    assert.equal(set.has(NFD), true);
    assert.equal(set.size, 1);
  });

  test('NormalizedSet keeps them distinct under sensitive rules (Linux semantics)', () => {
    const set = new NormalizedSet([], { sensitivity: 'sensitive' });
    set.add(NFC);
    assert.equal(set.has(NFD), false);
    set.add(NFD);
    assert.equal(set.size, 2);
  });

  test('NormalizedSet.values() returns the first-seen spelling, not a normalized one', () => {
    const set = new NormalizedSet([], { sensitivity: 'insensitive' });
    set.add(NFD);
    set.add(NFC); // same identity, second spelling is dropped for iteration
    assert.deepEqual([...set.values()], [NFD]);
  });

  test('NormalizedSet.delete removes by identity', () => {
    const set = new NormalizedSet([NFC], { sensitivity: 'insensitive' });
    assert.equal(set.delete(NFD), true);
    assert.equal(set.size, 0);
  });

  test('NormalizedMap looks values up by identity, keeping the first-seen key', () => {
    const map = new NormalizedMap<number>([], { sensitivity: 'insensitive' });
    map.set(NFC, 1);
    map.set(NFD, 2); // same file: overwrites the value, keeps the NFC key
    assert.equal(map.get(NFD), 2);
    assert.equal(map.size, 1);
    assert.deepEqual([...map.entries()], [[NFC, 2]]);
  });
});

describe('groupByNormalizedForm (the collision-pair primitive)', () => {
  test('groups two byte-different spellings of the same visible name together', () => {
    const groups = groupByNormalizedForm([NFC, NFD, 'unrelated.txt']);
    assert.equal(groups.size, 2);
    assert.deepEqual(groups.get(NFC), [NFC, NFD]);
  });
});

describe('scan()', () => {
  let dir: string;
  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nfc-guard-scan-'));
  });
  after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('a clean, ASCII-only tree scans clean', async () => {
    const clean = path.join(dir, 'clean');
    await fs.mkdir(clean);
    await fs.writeFile(path.join(clean, 'a.txt'), 'x');
    await fs.writeFile(path.join(clean, 'b.txt'), 'x');

    const report = await scan(clean);
    assert.deepEqual(report.findings, []);
    assert.equal(report.exitCode, 0);
    assert.equal(report.filesScanned, 2);
  });

  test('does NOT flag a filename already in NFC form, even with diacritics', async () => {
    const target = path.join(dir, 'nfc-name');
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, NFC), 'x');

    const report = await scan(target);
    assert.deepEqual(report.findings, []);
    assert.equal(report.exitCode, 0);
  });

  test('flags a filename stored in NFD form', async () => {
    const target = path.join(dir, 'nfd-name');
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, NFD), 'x');

    const report = await scan(target);
    assert.equal(report.exitCode, 1);
    const finding = report.findings.find((f) => f.kind === 'non-nfc-name');
    assert.ok(finding, 'expected a non-nfc-name finding');
    assert.equal(finding!.path, NFD);
  });

  test('flags a tree that mixes NFC-only and NFD-only names', async () => {
    const target = path.join(dir, 'mixed');
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, NFC), 'x');
    await fs.writeFile(path.join(target, 'blasé'.normalize('NFD')), 'x');

    const report = await scan(target);
    assert.ok(report.findings.some((f) => f.kind === 'inconsistent-tree-normalization'));
  });

  test('rejects with ScanError when the root does not exist (exit 2 territory)', async () => {
    await assert.rejects(scan(path.join(dir, 'does-not-exist')), ScanError);
  });

  test('rejects with ScanError when the root is a file, not a directory', async () => {
    const file = path.join(dir, 'a-file');
    await fs.writeFile(file, 'x');
    await assert.rejects(scan(file), ScanError);
  });

  test('ignore() can skip entries (default skips .git and node_modules)', async () => {
    const target = path.join(dir, 'ignored');
    await fs.mkdir(path.join(target, 'node_modules'), { recursive: true });
    await fs.writeFile(path.join(target, 'node_modules', NFD), 'x'); // would otherwise flag
    await fs.writeFile(path.join(target, 'clean.txt'), 'x');

    const report = await scan(target);
    assert.equal(report.exitCode, 0);
    assert.equal(report.filesScanned, 1); // node_modules itself and its contents are skipped entirely
  });

  describe('manifest vs. disk', () => {
    test('flags a manifest entry recorded in a different normalization form than disk has', async () => {
      const target = path.join(dir, 'manifest-mismatch');
      await fs.mkdir(target);
      await fs.writeFile(path.join(target, NFC), 'x'); // disk has NFC

      const report = await scan(target, { manifest: [NFD] }); // manifest recorded NFD
      assert.equal(report.exitCode, 1);
      assert.equal(report.findings.length, 1, `expected exactly one finding, got ${JSON.stringify(report.findings)}`);
      const finding = report.findings[0]!;
      assert.equal(finding.kind, 'manifest-disk-mismatch');
      assert.equal(finding.path, NFD);
      assert.deepEqual(finding.related, [NFC]);
    });

    test('flags a manifest entry with no matching file at all', async () => {
      const target = path.join(dir, 'manifest-missing');
      await fs.mkdir(target);
      await fs.writeFile(path.join(target, 'a.txt'), 'x');

      const report = await scan(target, { manifest: ['ghost.txt'] });
      assert.ok(report.findings.some((f) => f.kind === 'manifest-missing' && f.path === 'ghost.txt'));
    });

    test('THE STAR CASE: a manifest recording two spellings that can only ever be one file here', async () => {
      // This is the scenario from the spec: a manifest/lockfile built on Linux
      // (or just hand-written) can legitimately list two byte-different
      // entries for what looks like the same name. Checked against a real
      // directory on this machine (Darwin/APFS), at most one of them can
      // exist — writing both, as shown in the top-level test above, silently
      // collapses to a single file. The scanner catches this from the
      // manifest alone, without needing the impossible on-disk fixture.
      const target = path.join(dir, 'would-collide');
      await fs.mkdir(target);
      await fs.writeFile(path.join(target, NFC), 'whatever ended up on disk');

      const report = await scan(target, { manifest: [NFC, NFD] });
      // Two findings, both correct: the NFD manifest entry doesn't byte-match
      // the NFC file that's actually on disk (a manifest-disk-mismatch), *and*
      // the two manifest entries collide with each other under this platform's
      // rules regardless of what's on disk (manifest-would-collide).
      assert.equal(report.findings.length, 2, `expected exactly two findings, got ${JSON.stringify(report.findings)}`);
      const collide = report.findings.find((f) => f.kind === 'manifest-would-collide');
      assert.ok(collide, 'expected a manifest-would-collide finding');
      assert.deepEqual([collide!.path, ...(collide!.related ?? [])].sort(), [NFC, NFD].sort());
      assert.ok(
        report.findings.some((f) => f.kind === 'manifest-disk-mismatch'),
        'expected a manifest-disk-mismatch finding',
      );
      assert.equal(report.exitCode, 1);
    });

    test('does not flag manifest entries that byte-match disk exactly', async () => {
      const target = path.join(dir, 'manifest-clean');
      await fs.mkdir(target);
      await fs.writeFile(path.join(target, 'a.txt'), 'x');

      const report = await scan(target, { manifest: ['a.txt'] });
      assert.equal(report.exitCode, 0);
    });
  });
});
