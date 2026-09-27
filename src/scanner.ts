import fs from 'node:fs/promises';
import path from 'node:path';

import { detectForm, platformSensitivity, sameFile } from './normalize.ts';
import type { FsSensitivity } from './normalize.ts';

/** Thrown when the tree (or a manifest) could not be read at all — exit code 2 territory. */
export class ScanError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

export type FindingKind =
  | 'collision-pair'
  | 'non-nfc-name'
  | 'inconsistent-tree-normalization'
  | 'manifest-missing'
  | 'manifest-disk-mismatch'
  | 'manifest-would-collide';

export interface Finding {
  kind: FindingKind;
  /** The path (relative to the scanned root) this finding is primarily about. */
  path: string;
  /** Human-readable explanation. */
  detail: string;
  /** Other paths involved, for pair/group findings. */
  related?: string[];
}

export interface ScanOptions {
  /**
   * Filenames a manifest/lockfile records for this tree (paths relative to
   * `root`, forward-slash separated). When given, the scan also checks disk
   * reality against what the manifest expects.
   */
  manifest?: string[];
  /** Return `true` to skip a directory entry (name is the basename). Default skips `.git` and `node_modules`. */
  ignore?: (name: string, relPath: string) => boolean;
  /** Assume this platform's collision rules instead of the current one. */
  sensitivity?: FsSensitivity;
}

export interface ScanReport {
  root: string;
  sensitivity: FsSensitivity;
  filesScanned: number;
  findings: Finding[];
  exitCode: 0 | 1 | 2;
}

const DEFAULT_IGNORE = (name: string): boolean => name === '.git' || name === 'node_modules';

/**
 * Group `names` by their NFC-normalized form. Any group with more than one
 * entry is a set of spellings that are byte-different but name the same
 * thing once normalized — the "collision pair" case, whether those names are
 * sibling files on disk or entries in a manifest.
 *
 * Exported (and used by {@link scan} internally) so the detection logic can
 * be exercised directly against a plain list of strings: on a
 * normalization-insensitive filesystem (this development machine's APFS) two
 * such names generally cannot be made to coexist as real sibling files in
 * the first place — the second write overwrites the first instead of
 * creating a second entry — so a synthetic list is how this logic gets
 * tested here. See the README and tests for the verified detail.
 */
export function groupByNormalizedForm(names: Iterable<string>): Map<string, string[]> {
  const byKey = new Map<string, string[]>();
  for (const name of names) {
    const key = name.normalize('NFC');
    const bucket = byKey.get(key);
    if (bucket) bucket.push(name);
    else byKey.set(key, [name]);
  }
  return byKey;
}

interface WalkEntry {
  relPath: string;
  name: string;
}

interface WalkResult {
  entries: WalkEntry[];
  /** Groups of sibling paths (same directory) whose names share an NFC key. */
  collisionGroups: string[][];
}

async function walk(
  root: string,
  ignore: (name: string, relPath: string) => boolean,
): Promise<WalkResult> {
  const entries: WalkEntry[] = [];
  const collisionGroups: string[][] = [];

  async function recurse(dir: string, relDir: string): Promise<void> {
    let dirents;
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      throw new ScanError(`could not read directory "${relDir || '.'}"`, { cause: err });
    }

    // Collision pairs are a same-directory phenomenon: group siblings by
    // their NFC-normalized name and flag any group with more than one
    // distinct byte-for-byte spelling.
    const names: string[] = [];
    const pathOf = new Map<string, string>();

    for (const d of dirents) {
      const name = d.name;
      const relPath = relDir ? `${relDir}/${name}` : name;
      if (ignore(name, relPath)) continue;

      entries.push({ relPath, name });
      names.push(name);
      pathOf.set(name, relPath);

      if (d.isDirectory()) {
        await recurse(path.join(dir, name), relPath);
      }
    }

    for (const group of groupByNormalizedForm(names).values()) {
      if (group.length > 1) collisionGroups.push(group.map((n) => pathOf.get(n)!));
    }
  }

  try {
    await recurse(root, '');
  } catch (err) {
    if (err instanceof ScanError) throw err;
    throw new ScanError(`could not walk "${root}"`, { cause: err });
  }

  return { entries, collisionGroups };
}

/**
 * Walk `root` and report:
 *
 *  - **collision pairs**: two sibling entries whose names differ only by
 *    Unicode normalization. On a byte-exact filesystem (Linux, and NTFS for
 *    this purpose) both coexist; syncing the tree to a normalization-folding
 *    filesystem (macOS/APFS) silently merges them into one file.
 *  - **non-NFC names**: individual filenames not in NFC, the form every
 *    normalization-insensitive filesystem and the web platform (URLs, HTML)
 *    standardize on.
 *  - **inconsistent tree normalization**: the tree mixes NFC-only and
 *    NFD-only (or other) filenames rather than using one consistently.
 *  - **manifest vs. disk mismatches**, when `options.manifest` is given.
 *
 * Resolves to a report with `exitCode`: `0` clean, `1` findings, and rejects
 * with {@link ScanError} (callers should treat that as exit code `2`, "could
 * not analyse") if the tree or manifest could not be read.
 */
export async function scan(root: string, options: ScanOptions = {}): Promise<ScanReport> {
  const sensitivity = options.sensitivity ?? platformSensitivity();
  const ignore = options.ignore ?? DEFAULT_IGNORE;

  const stat = await fs.stat(root).catch((err) => {
    throw new ScanError(`root "${root}" does not exist or is not accessible`, { cause: err });
  });
  if (!stat.isDirectory()) {
    throw new ScanError(`root "${root}" is not a directory`);
  }

  const { entries, collisionGroups } = await walk(root, ignore);
  const findings: Finding[] = [];

  // --- collision pairs -----------------------------------------------------
  for (const group of collisionGroups) {
    findings.push({
      kind: 'collision-pair',
      path: group[0]!,
      related: group.slice(1),
      detail:
        `${group.length} sibling names normalize to the same NFC form ` +
        `(${group.join(' , ')}). These coexist as distinct files on a byte-exact ` +
        `filesystem (Linux, NTFS) but collide into one on a normalization-insensitive ` +
        `one (macOS/APFS) — copying this tree there silently drops all but one.`,
    });
  }

  // --- per-file form + tree-wide consistency -------------------------------
  const formsSeen = new Set<'NFC' | 'NFD' | 'other'>();
  for (const { relPath, name } of entries) {
    const form = detectForm(name);
    if (form === 'both') continue; // plain ASCII etc. — nothing normalization touches
    formsSeen.add(form); // tracked for the tree-wide consistency check below, even 'NFC'

    if (form === 'NFC') continue; // already the canonical target form — not itself a finding
    findings.push({
      kind: 'non-nfc-name',
      path: relPath,
      detail:
        form === 'NFD'
          ? `stored in NFD (decomposed) form, not NFC. Byte-identical to no NFC string; ` +
            `string comparisons and caches keyed by the NFC spelling will miss it.`
          : `stored in a non-canonical Unicode form (neither NFC nor NFD).`,
    });
  }
  if (formsSeen.size > 1) {
    findings.push({
      kind: 'inconsistent-tree-normalization',
      path: root,
      detail:
        `this tree mixes filenames in more than one normalization form ` +
        `(${[...formsSeen].sort().join(', ')}). Pick one (NFC is the interchange default ` +
        `used by the web platform) and normalize the rest.`,
    });
  }

  // --- manifest vs. disk -----------------------------------------------------
  if (options.manifest) {
    const onDisk = entries.map((e) => e.relPath);
    const onDiskSet = new Set(onDisk);

    for (const recorded of options.manifest) {
      if (onDiskSet.has(recorded)) continue; // byte-exact match, nothing to report

      const normalizedMatch = onDisk.find((d) => sameFile(recorded, d, { sensitivity }));
      if (normalizedMatch) {
        findings.push({
          kind: 'manifest-disk-mismatch',
          path: recorded,
          related: [normalizedMatch],
          detail:
            `manifest records "${recorded}" but disk has "${normalizedMatch}" — same file ` +
            `under ${sensitivity} rules, different bytes. A cache key, checksum lookup, or ` +
            `diff keyed on the manifest spelling will not find this file.`,
        });
      } else {
        findings.push({
          kind: 'manifest-missing',
          path: recorded,
          detail: `manifest records "${recorded}" but no file on disk matches it, even allowing for normalization.`,
        });
      }
    }

    // Would two *manifest* entries collide once materialized on this platform?
    // Under 'sensitive' rules distinct strings never collide, so skip the grouping.
    const groups =
      sensitivity === 'insensitive'
        ? groupByNormalizedForm(options.manifest).values()
        : [];
    for (const group of groups) {
      if (group.length > 1) {
        findings.push({
          kind: 'manifest-would-collide',
          path: group[0]!,
          related: group.slice(1),
          detail:
            `manifest records ${group.length} distinct spellings of the same name ` +
            `(${group.join(' , ')}) that collide into one file under ${sensitivity} rules. ` +
            `If this manifest came from a byte-exact filesystem, materializing it here loses data.`,
        });
      }
    }
  }

  return {
    root,
    sensitivity,
    filesScanned: entries.length,
    findings,
    exitCode: findings.length > 0 ? 1 : 0,
  };
}
