/**
 * Normalization helpers for the filesystem boundary.
 *
 * A filename with combining characters or precomposed accents has more than
 * one valid Unicode encoding. `"café.txt"` can be:
 *
 *   NFC (composed):    c a f é       — 5 code points, "é" is U+00E9
 *   NFD (decomposed):  c a f e ́     — 6 code points, "e" + U+0301 (combining acute)
 *
 * Both render identically. JavaScript string equality (`===`), `Set`, `Map`,
 * and `Array.includes` all compare code points, so they see two different
 * strings. Whether the *filesystem* also sees two different files depends on
 * the platform — that mismatch is the whole problem this package exists to
 * catch. See the README for which behaviours below are verified on this
 * machine versus documented from platform vendor docs.
 */

export type FsSensitivity = 'insensitive' | 'sensitive';

export type NormalizationForm = 'NFC' | 'NFD';

/**
 * Whether a platform's default filesystem treats two differently-normalized
 * spellings of the same characters as the same directory entry.
 *
 * - `darwin` (macOS): APFS, the default since High Sierra (10.13), and the
 *   legacy HFS+ before it, are both **normalization-insensitive**: writing
 *   the NFD spelling and then the NFC spelling of the same name overwrites
 *   the same file rather than creating a second one. **Verified on this
 *   machine** — see README for the actual command and output.
 * - `linux`: ext4, xfs, btrfs and friends store filenames as opaque byte
 *   strings. No normalization or folding happens, so NFC and NFD spellings
 *   are two unrelated, coexisting files. **Documented, not verified here**
 *   (this machine is Darwin) — this is standard, widely-documented POSIX
 *   filesystem behaviour, not a guess.
 * - `win32`: NTFS is case-insensitive but, like Linux, does **not** perform
 *   Unicode normalization on filenames — it compares UTF-16 code units after
 *   an uppercase mapping, not canonical equivalence. Two differently
 *   normalized spellings are distinct entries, the same as Linux, though
 *   individual Windows APIs/apps sometimes normalize before calling the
 *   filesystem. **Documented, not verified here.**
 *
 * Everything except the `darwin` case is taken from platform documentation,
 * not measured by this package.
 */
export function platformSensitivity(platform: NodeJS.Platform = process.platform): FsSensitivity {
  return platform === 'darwin' ? 'insensitive' : 'sensitive';
}

/** Normalize a path or filename to a single Unicode form. Default `NFC`. */
export function normalizePath(name: string, form: NormalizationForm = 'NFC'): string {
  return name.normalize(form);
}

/**
 * Which single normalization form `name` is already in.
 *
 * `'both'` means the string has no combining marks or precomposed characters
 * that normalization would touch (plain ASCII, for example) — NFC and NFD
 * agree trivially, so there is nothing to flag. `'other'` means the string is
 * in neither canonical form (e.g. NFKC/NFKD-only, or a non-canonical
 * combining-mark order) — unusual, and worth a closer look wherever it shows up.
 */
export function detectForm(name: string): 'NFC' | 'NFD' | 'both' | 'other' {
  const isNFC = name === name.normalize('NFC');
  const isNFD = name === name.normalize('NFD');
  if (isNFC && isNFD) return 'both';
  if (isNFC) return 'NFC';
  if (isNFD) return 'NFD';
  return 'other';
}

/**
 * Whether `a` and `b` name the *same file* under a given filesystem's rules.
 *
 * Defaults to the current platform's rules via {@link platformSensitivity}.
 * Pass `sensitivity` explicitly to ask "would this collide on Linux?" while
 * running on macOS, or vice versa — useful for the scanner, and for tests
 * that want to check both answers without a second machine.
 */
export function sameFile(
  a: string,
  b: string,
  opts: { sensitivity?: FsSensitivity } = {},
): boolean {
  const sensitivity = opts.sensitivity ?? platformSensitivity();
  if (sensitivity === 'insensitive') return a.normalize('NFC') === b.normalize('NFC');
  return a === b;
}
