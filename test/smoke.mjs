/**
 * Plain-JS checks against the built package, so they run on every Node version
 * in `engines` — the TypeScript suite needs type stripping and only runs on 24+.
 *
 *   npm run build && node --test test/smoke.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test, { after, before } from 'node:test';

const run = promisify(execFile);

const {
  detectForm,
  sameFile,
  NormalizedSet,
  scan,
} = await import('../dist/index.js');

const NFC = 'café.txt'.normalize('NFC');
const NFD = 'café.txt'.normalize('NFD');

let dir;
before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nfc-guard-smoke-'));
});
after(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

test('core exports work from the built dist', () => {
  assert.equal(detectForm(NFD), 'NFD');
  assert.equal(sameFile(NFC, NFD, { sensitivity: 'insensitive' }), true);
  assert.equal(sameFile(NFC, NFD, { sensitivity: 'sensitive' }), false);

  const set = new NormalizedSet([], { sensitivity: 'insensitive' });
  set.add(NFC);
  assert.equal(set.has(NFD), true);
});

test('scan() finds a real NFD-named file on disk', async () => {
  const target = path.join(dir, 'nfd');
  await fs.mkdir(target);
  await fs.writeFile(path.join(target, NFD), 'x');

  const report = await scan(target);
  assert.equal(report.exitCode, 1);
  assert.ok(report.findings.some((f) => f.kind === 'non-nfc-name'));
});

test('scan() catches a manifest that would collide, clean tree exits 0', async () => {
  const clean = path.join(dir, 'clean');
  await fs.mkdir(clean);
  await fs.writeFile(path.join(clean, 'plain.txt'), 'x');
  const cleanReport = await scan(clean);
  assert.equal(cleanReport.exitCode, 0);

  const collide = path.join(dir, 'collide');
  await fs.mkdir(collide);
  await fs.writeFile(path.join(collide, NFC), 'x');
  const collideReport = await scan(collide, { manifest: [NFC, NFD] });
  assert.equal(collideReport.exitCode, 1);
  assert.ok(collideReport.findings.some((f) => f.kind === 'manifest-would-collide'));
});

test('CLI exits 0 on a clean tree, 1 on findings, 2 on a missing root', async () => {
  const clean = path.join(dir, 'cli-clean');
  await fs.mkdir(clean);
  await fs.writeFile(path.join(clean, 'plain.txt'), 'x');
  const cliPath = path.join(import.meta.dirname, '..', 'dist', 'cli.js');

  const ok = await run('node', [cliPath, clean]);
  assert.match(ok.stdout, /no findings/);

  const dirty = path.join(dir, 'cli-dirty');
  await fs.mkdir(dirty);
  await fs.writeFile(path.join(dirty, NFD), 'x');
  await assert.rejects(run('node', [cliPath, dirty]), (err) => {
    assert.equal(err.code, 1);
    return true;
  });

  await assert.rejects(run('node', [cliPath, path.join(dir, 'nope')]), (err) => {
    assert.equal(err.code, 2);
    return true;
  });
});
