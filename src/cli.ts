#!/usr/bin/env node
import fs from 'node:fs/promises';

import { scan, ScanError } from './scanner.ts';
import type { Finding } from './scanner.ts';

const USAGE = `nfc-guard [dir] [--manifest <file>] [--json]

Scan a directory tree for filenames whose Unicode normalization form is
inconsistent, sibling names that only differ by normalization (a silent
collision waiting to happen on a normalization-insensitive filesystem), and
mismatches between a manifest/lockfile and what's actually on disk.

  dir              directory to scan (default: .)
  --manifest <f>   JSON file containing an array of paths (relative to dir,
                   forward-slash separated) that a manifest/lockfile records
  --json           print the full report as JSON instead of a text summary

Exit codes: 0 clean, 1 findings, 2 could not analyse.
`;

interface Args {
  root: string;
  manifest?: string;
  json: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { root: '.', json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--json') args.json = true;
    else if (a === '--manifest') args.manifest = argv[++i];
    else if (a && !a.startsWith('-')) args.root = a;
    else throw new Error(`unrecognized argument: ${a}`);
  }
  return args;
}

async function loadManifest(file: string): Promise<string[]> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err) {
    throw new ScanError(`could not read manifest "${file}"`, { cause: err });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ScanError(`manifest "${file}" is not valid JSON`, { cause: err });
  }
  if (!Array.isArray(parsed) || !parsed.every((p) => typeof p === 'string')) {
    throw new ScanError(`manifest "${file}" must be a JSON array of path strings`);
  }
  return parsed;
}

function printText(report: Awaited<ReturnType<typeof scan>>): void {
  console.log(`nfc-guard: scanned ${report.filesScanned} entries under ${report.root}`);
  console.log(`  platform sensitivity: ${report.sensitivity}`);
  if (report.findings.length === 0) {
    console.log('  no findings.');
    return;
  }
  console.log(`  ${report.findings.length} finding(s):\n`);
  for (const f of report.findings) {
    printFinding(f);
  }
}

function printFinding(f: Finding): void {
  console.log(`  [${f.kind}] ${f.path}`);
  console.log(`    ${f.detail}`);
  if (f.related?.length) console.log(`    related: ${f.related.join(', ')}`);
  console.log();
}

async function main(): Promise<void> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`nfc-guard: ${(err as Error).message}\n\n${USAGE}`);
    process.exit(2);
  }

  if (args.help) {
    console.log(USAGE);
    process.exit(0);
  }

  try {
    const manifest = args.manifest ? await loadManifest(args.manifest) : undefined;
    const report = await scan(args.root, { manifest });
    if (args.json) console.log(JSON.stringify(report, null, 2));
    else printText(report);
    process.exit(report.exitCode);
  } catch (err) {
    const message = err instanceof ScanError ? err.message : `unexpected error: ${(err as Error).message}`;
    console.error(`nfc-guard: could not analyse — ${message}`);
    process.exit(2);
  }
}

main();
