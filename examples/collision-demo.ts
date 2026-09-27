/**
 * Runs the asymmetry live on this machine and shows nfc-guard catching it.
 * Everything printed here is real output, not illustration — see the README,
 * which pastes this script's actual run.
 *
 *   node examples/collision-demo.ts
 */
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { detectForm, sameFile, NormalizedSet, scan } from '../src/index.ts';

const NFC = 'café.txt'.normalize('NFC');
const NFD = 'café.txt'.normalize('NFD');
const hex = (s: string): string => Buffer.from(s, 'utf8').toString('hex');

console.log(`\nplatform: ${process.platform}\n`);

console.log('1. The base asymmetry (JS string identity)');
console.log(`   Both spellings print as "café.txt" and look identical. Their bytes don't:`);
console.log(`     nfc hex: ${hex(NFC)}  (${NFC.length} code units — composed "é")`);
console.log(`     nfd hex: ${hex(NFD)}  (${NFD.length} code units — "e" + combining acute)`);
console.log(`   nfc === nfd (JS string equality):  ${NFC === NFD}`);

const naiveSet = new Set<string>();
naiveSet.add(NFC);
console.log(`   Set.has(nfd) after adding nfc:      ${naiveSet.has(NFD)}   <- the textbook bug`);

const guardedSet = new NormalizedSet();
guardedSet.add(NFC);
console.log(`   NormalizedSet.has(nfd):              ${guardedSet.has(NFD)}   <- fixed`);

console.log('\n2. What the filesystem actually does (real files, this machine)');
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nfc-guard-demo-'));
await fs.writeFile(path.join(dir, NFC), 'first write, NFC spelling');

console.log(`   wrote "${NFC}" (NFC)`);
console.log(`   existsSync(NFC form)?  ${existsSync(path.join(dir, NFC))}`);
console.log(`   existsSync(NFD form)?  ${existsSync(path.join(dir, NFD))}   <- fs matches both spellings`);
console.log(`   sameFile(nfc, nfd):    ${sameFile(NFC, NFD)}  (platform default: ${process.platform})`);

console.log('\n3. The genuinely dangerous case: writing the *other* spelling next');
await fs.writeFile(path.join(dir, NFD), 'second write, NFD spelling');
const listing = await fs.readdir(dir);
console.log(`   wrote "${NFD}" (NFD, hex ${hex(NFD)}) into the same directory`);
console.log(`   directory listing now:  ${JSON.stringify(listing)}  (hex: ${listing.map(hex).join(', ')})`);
console.log(
  `   -> ${listing.length} file(s), not 2. The second write silently overwrote the first;`,
);
console.log(`      reading it back gives: ${JSON.stringify(await fs.readFile(path.join(dir, NFC), 'utf8'))}`);
console.log(`   On Linux (ext4/xfs/btrfs) this same sequence produces TWO files. This`);
console.log(`   machine is Darwin/APFS, so only the "one file, data silently lost" side`);
console.log(`   of the story could be run here — see README for the honest caveat.`);

await fs.rm(dir, { recursive: true, force: true });

console.log('\n4. The scanner catching a stray non-NFC filename');
const scanDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nfc-guard-demo-scan-'));
await fs.writeFile(path.join(scanDir, NFD), 'x');
const scanReport = await scan(scanDir);
console.log(`   scan(dir) on a directory containing one NFD-named file:`);
console.log(`   exitCode: ${scanReport.exitCode}`);
for (const f of scanReport.findings) console.log(`   [${f.kind}] ${f.path} — ${f.detail}`);
await fs.rm(scanDir, { recursive: true, force: true });

console.log('\n5. The star case: a manifest that lists two spellings this platform can only ever store as one');
const manifestDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nfc-guard-demo-manifest-'));
await fs.writeFile(path.join(manifestDir, NFC), 'whatever ended up on disk after the collision');
const manifestReport = await scan(manifestDir, { manifest: [NFC, NFD] });
console.log(`   manifest (as if recorded on Linux, or hand-written): ["${NFC}", "${NFD}"]`);
console.log(`     manifest entry hexes: ${hex(NFC)}, ${hex(NFD)}  <- different bytes, same rendering`);
const onDisk = await fs.readdir(manifestDir);
console.log(`   disk (this machine) actually has: ${JSON.stringify(onDisk)}  (hex: ${onDisk.map(hex).join(', ')})`);
console.log(`   exitCode: ${manifestReport.exitCode}`);
for (const f of manifestReport.findings) console.log(`   [${f.kind}] ${f.path} — ${f.detail}`);
await fs.rm(manifestDir, { recursive: true, force: true });

console.log();
