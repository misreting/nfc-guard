# nfc-guard

Catches Unicode normalization bugs at the filesystem boundary: a filename
that string equality sees as two different files but the filesystem may (or
may not) treat as one.

```
1. The base asymmetry (JS string identity)
   Both spellings print as "café.txt" and look identical. Their bytes don't:
     nfc hex: 636166c3a92e747874  (8 code units — composed "é")
     nfd hex: 63616665cc812e747874  (9 code units — "e" + combining acute)
   nfc === nfd (JS string equality):  false
   Set.has(nfd) after adding nfc:      false   <- the textbook bug
   NormalizedSet.has(nfd):              true   <- fixed

2. What the filesystem actually does (real files, this machine)
   wrote "café.txt" (NFC)
   existsSync(NFC form)?  true
   existsSync(NFD form)?  true   <- fs matches both spellings
   sameFile(nfc, nfd):    true  (platform default: darwin)
```

That's `node examples/collision-demo.ts`, run on this machine. Full output
below. The gap: JS string logic says these are two different files; the
filesystem says they're one.

## The problem

A filename with an accented or otherwise composable character has more than
one valid Unicode encoding. `"café.txt"` can be:

- **NFC** (composed) — `café.txt`, 8 code points, `é` is one character (U+00E9)
- **NFD** (decomposed) — `café.txt`, 9 code points, `é` is `e` + a combining
  acute accent (U+0301)

They render identically. Nothing in a terminal, an editor, or this README
can show you which one you're looking at — you have to check the bytes.
`String#normalize()` converts between them, but nothing forces any particular
tool, OS, or library to pick one, and plenty of code never normalizes at all.

JavaScript string equality, `Set`, `Map`, `Array#includes`, and JSON diffing
all compare code points. They see two different strings. Whether the
*filesystem* also sees two different files depends on the platform — and
that's the part most code gets wrong, because it's usually written and
tested on one platform and shipped to run on another.

This is the class of bug behind long-running issues in webpack, Broccoli,
and git's `core.precomposeunicode` — a build tool hashes or diffies filenames
as strings, two spellings of the same name slip past a "have I seen this
file" check, and something either gets processed twice, silently skipped, or
silently overwritten.

### Why "just normalize everything" isn't a complete fix

Normalizing every path to NFC before comparing is *often* right, but it
quietly changes what a comparison means depending on where it runs:

- On a normalization-insensitive filesystem (macOS/APFS), NFC and NFD really
  are the same file, so normalizing before comparing gives the correct
  answer.
- On a byte-exact filesystem (Linux), NFC and NFD are two **different,
  independently-existing files**. Normalizing before comparing makes your
  code treat two real, distinct files as one — which is its own bug (a
  manifest diff that says "nothing changed" when a file was actually added).

There is no single normalization policy that is correct on every platform.
The only fix is to know which rule applies where, and to be deliberate about
which one your code is using — see `sameFile()` below.

### The platform split (the part worth getting right)

| Platform | Filesystem | Normalization behavior | Verified here? |
| --- | --- | --- | --- |
| macOS | APFS (default since 10.13), HFS+ (legacy) | **Insensitive but preserving**: NFC and NFD spellings name the *same* directory entry; whichever spelling created it is kept in the listing, but any equivalent spelling reads/writes/opens it. | **Yes — Darwin, this machine.** See evidence below. |
| Linux | ext4, xfs, btrfs, … | **Byte-exact**: filenames are opaque byte strings. NFC and NFD spellings are two unrelated files that coexist. | No — documented POSIX filesystem behavior, not measured on this machine. |
| Windows | NTFS | **Byte-exact for normalization** (case-insensitive via an uppercase table, but no Unicode canonical folding) — closer to Linux than to macOS for this specific question, though individual apps/APIs may normalize before ever calling into the filesystem. | No — documented, not measured on this machine. |

The same code can be correct on macOS and silently wrong on Linux, or vice
versa, depending on which of these rules it assumes. `nfc-guard` makes the
assumption explicit instead of implicit: `platformSensitivity()` names it,
`sameFile()` takes it as a parameter, and the scanner reports what it found
against a stated rule rather than a hidden one.

### Real evidence (this machine — Darwin/APFS)

```
3. The genuinely dangerous case: writing the *other* spelling next
   wrote "café.txt" (NFD, hex 63616665cc812e747874) into the same directory
   directory listing now:  ["café.txt"]  (hex: 636166c3a92e747874)
   -> 1 file(s), not 2. The second write silently overwrote the first;
      reading it back gives: "second write, NFD spelling"
   On Linux (ext4/xfs/btrfs) this same sequence produces TWO files. This
   machine is Darwin/APFS, so only the "one file, data silently lost" side
   of the story could be run here — see README for the honest caveat.
```

Two `fs.writeFile` calls, two different byte sequences for the filename,
**one file on disk** — the second write silently overwrote the first (note
the directory listing keeps the *first* spelling's bytes, `636166...`, even
though the *second* write used the other spelling: APFS is preserving, not
just insensitive). On Linux, that same pair of writes produces two files
that both persist. This package cannot demonstrate the Linux side on this
machine — see **What it does not do**.

Because a real colliding pair generally can't be made to coexist on this
machine's filesystem, the scanner's collision-detection logic is verified
directly against plain string lists (see `groupByNormalizedForm` and its
tests) rather than against fabricated on-disk fixtures — and, more usefully,
against a **manifest that expects two files where the disk (correctly, for
this platform) only has one**:

```
5. The star case: a manifest that lists two spellings this platform can only ever store as one
   manifest (as if recorded on Linux, or hand-written): ["café.txt", "café.txt"]
     manifest entry hexes: 636166c3a92e747874, 63616665cc812e747874  <- different bytes, same rendering
   disk (this machine) actually has: ["café.txt"]  (hex: 636166c3a92e747874)
   exitCode: 1
   [manifest-disk-mismatch] café.txt — manifest records "café.txt" but disk has "café.txt" — same file under insensitive rules, different bytes. A cache key, checksum lookup, or diff keyed on the manifest spelling will not find this file.
   [manifest-would-collide] café.txt — manifest records 2 distinct spellings of the same name (café.txt , café.txt) that collide into one file under insensitive rules. If this manifest came from a byte-exact filesystem, materializing it here loses data.
```

This is the practically dangerous scenario from the spec: a lockfile,
manifest, or `git status`-style record built on Linux (or by hand) lists two
byte-different filenames. Check that same manifest against a macOS checkout
and at most one of them can physically exist — `nfc-guard` catches the
mismatch from the manifest alone, without needing an impossible fixture.

Full, unedited output of `node examples/collision-demo.ts` is in
[Real output](#real-output) at the bottom of this file.

## Install

```sh
npm install nfc-guard
```

Node >= 20.6. No runtime dependencies.

## Use

### Comparing two names

```ts
import { sameFile, platformSensitivity } from 'nfc-guard';

const nfc = 'café.txt'.normalize('NFC');
const nfd = 'café.txt'.normalize('NFD');

sameFile(nfc, nfd); // true on macOS (default: current platform's rules)
sameFile(nfc, nfd, { sensitivity: 'sensitive' }); // "would this collide on Linux?" -> false
platformSensitivity();          // 'insensitive' | 'sensitive', for process.platform
platformSensitivity('linux');   // ask about a platform other than the one you're running on
```

### A Set/Map that won't get fooled by normalization

```ts
import { NormalizedSet } from 'nfc-guard';

const processed = new NormalizedSet(); // sensitivity defaults to the current platform
processed.add(nfcSpelling);
processed.has(nfdSpelling); // true on macOS — a plain Set would say false
```

`NormalizedMap<V>` works the same way for a cache keyed on filenames.

### Scanning a tree

```ts
import { scan } from 'nfc-guard';

const report = await scan('./dist', {
  manifest: JSON.parse(await fs.readFile('./manifest.json', 'utf8')),
});

report.exitCode;   // 0 clean, 1 findings, 2 handled via a thrown ScanError instead
report.findings;   // Finding[] — see below
```

### CLI

```sh
npx nfc-guard <dir> [--manifest <file.json>] [--json]
```

Real runs of `dist/cli.js` on this machine, against a clean dir, a dir
containing one NFD-named file, and a dir that doesn't exist:

```
$ node dist/cli.js /tmp/nfcg-demo/clean; echo "exit: $?"
nfc-guard: scanned 1 entries under /tmp/nfcg-demo/clean
  platform sensitivity: insensitive
  no findings.
exit: 0

$ node dist/cli.js /tmp/nfcg-demo/dirty; echo "exit: $?"
nfc-guard: scanned 1 entries under /tmp/nfcg-demo/dirty
  platform sensitivity: insensitive
  1 finding(s):

  [non-nfc-name] café.txt
    stored in NFD (decomposed) form, not NFC. Byte-identical to no NFC string; string comparisons and caches keyed by the NFC spelling will miss it.

exit: 1

$ node dist/cli.js /tmp/nfcg-demo/does-not-exist; echo "exit: $?"
nfc-guard: could not analyse — root "/tmp/nfcg-demo/does-not-exist" does not exist or is not accessible
exit: 2
```

## API

| Export | What it does |
| --- | --- |
| `platformSensitivity(platform?)` | `'insensitive'` (macOS) or `'sensitive'` (Linux, Windows) for the given/current platform. |
| `sameFile(a, b, { sensitivity? })` | Whether `a` and `b` name the same file under the given (or current-platform) rules. |
| `detectForm(name)` | `'NFC'` \| `'NFD'` \| `'both'` (no ambiguity, e.g. ASCII) \| `'other'` (non-canonical). |
| `normalizePath(name, form?)` | `name.normalize(form)`, default `'NFC'`. |
| `NormalizedSet` / `NormalizedMap<V>` | `Set`/`Map` keyed on `sameFile` identity instead of code-point identity. |
| `groupByNormalizedForm(names)` | Groups strings by NFC key; a group with >1 entry is a collision. Used internally by `scan`; exported because a real colliding pair can't always be constructed on disk to test against (see above). |
| `scan(root, options?)` | Walks `root`, returns a `ScanReport`. Throws `ScanError` if the tree (or manifest) can't be read. |

### `scan()` options

| Option | Default | What it does |
| --- | --- | --- |
| `manifest` | — | Paths (relative to `root`, forward-slash separated) a lockfile/manifest records. When given, disk is checked against it. |
| `ignore(name, relPath)` | skips `.git`, `node_modules` | Return `true` to skip an entry (and, for a directory, everything under it). |
| `sensitivity` | current platform | Override which collision rules to check against — e.g. run on macOS but ask "would this collide on Linux?". |

### Finding kinds

- `collision-pair` — sibling entries on disk whose names normalize to the same form (see caveat above: not reachable in a real fixture on an insensitive filesystem).
- `non-nfc-name` — a filename not in NFC (NFD or another non-canonical form).
- `inconsistent-tree-normalization` — the tree mixes NFC-only and NFD-only (or other) names instead of using one form consistently.
- `manifest-missing` — a manifest entry matches no file on disk, even allowing for normalization.
- `manifest-disk-mismatch` — a manifest entry doesn't byte-match disk, but does match once normalized (recorded and actual spellings differ).
- `manifest-would-collide` — two manifest entries collide into one file under the platform rules being checked.

### Exit codes

`0` clean · `1` findings · `2` could not analyse (bad root, unreadable directory, or invalid manifest — a thrown `ScanError` in the library, `process.exit(2)` in the CLI).

## What it does not do

- **Doesn't touch the filesystem.** It reports; it never renames, dedupes, or
  "fixes" a file. Acting on a finding is a decision only the caller can make
  (which spelling is "correct" is not always obvious).
- **Only Linux/Windows behavior is documented, not measured.** Everything
  claimed about non-Darwin platforms in this README comes from filesystem
  documentation, not a run on this machine. If you can confirm or refute any
  of it on Linux or Windows, that's more valuable than anything else this
  package could add.
- **Can't construct a real colliding on-disk pair on an insensitive
  filesystem** — by definition, the second write collapses into the first.
  The collision-detection logic (`groupByNormalizedForm`) is tested directly
  against string lists instead; `scan()`'s manifest check is the practical
  way to catch this class of bug from this machine.
- **Only canonical forms (NFC/NFD).** Compatibility forms (NFKC/NFKD) and
  Unicode confusables/homoglyphs (e.g. Cyrillic `а` vs Latin `a`) are a
  different bug class and out of scope.
- **Doesn't follow symlinks** while walking, and doesn't detect symlink
  cycles (it doesn't need to, since it never follows one far enough to
  loop).
- **Manifest input is a flat JSON array of paths**, nothing fancier — no
  glob/gitignore patterns, no reading `git ls-files` or a package lockfile's
  own format for you.
- **Not a general Unicode linter.** It only looks at filenames, not file
  contents, and only checks normalization, not encoding validity or any
  other Unicode well-formedness question.

## Develop

Tests are TypeScript run directly by Node's test runner — no build, no install:

```sh
node --test "test/*.test.ts"        # full suite, needs node 24+ for type stripping
node examples/collision-demo.ts     # the evidence pasted above

npm run build && npm run test:dist  # what CI runs against node 20 and 22
```

## License

MIT

## Real output

Unedited output of `node examples/collision-demo.ts` on this machine (macOS,
Darwin, APFS):

```
platform: darwin

1. The base asymmetry (JS string identity)
   Both spellings print as "café.txt" and look identical. Their bytes don't:
     nfc hex: 636166c3a92e747874  (8 code units — composed "é")
     nfd hex: 63616665cc812e747874  (9 code units — "e" + combining acute)
   nfc === nfd (JS string equality):  false
   Set.has(nfd) after adding nfc:      false   <- the textbook bug
   NormalizedSet.has(nfd):              true   <- fixed

2. What the filesystem actually does (real files, this machine)
   wrote "café.txt" (NFC)
   existsSync(NFC form)?  true
   existsSync(NFD form)?  true   <- fs matches both spellings
   sameFile(nfc, nfd):    true  (platform default: darwin)

3. The genuinely dangerous case: writing the *other* spelling next
   wrote "café.txt" (NFD, hex 63616665cc812e747874) into the same directory
   directory listing now:  ["café.txt"]  (hex: 636166c3a92e747874)
   -> 1 file(s), not 2. The second write silently overwrote the first;
      reading it back gives: "second write, NFD spelling"
   On Linux (ext4/xfs/btrfs) this same sequence produces TWO files. This
   machine is Darwin/APFS, so only the "one file, data silently lost" side
   of the story could be run here — see README for the honest caveat.

4. The scanner catching a stray non-NFC filename
   scan(dir) on a directory containing one NFD-named file:
   exitCode: 1
   [non-nfc-name] café.txt — stored in NFD (decomposed) form, not NFC. Byte-identical to no NFC string; string comparisons and caches keyed by the NFC spelling will miss it.

5. The star case: a manifest that lists two spellings this platform can only ever store as one
   manifest (as if recorded on Linux, or hand-written): ["café.txt", "café.txt"]
     manifest entry hexes: 636166c3a92e747874, 63616665cc812e747874  <- different bytes, same rendering
   disk (this machine) actually has: ["café.txt"]  (hex: 636166c3a92e747874)
   exitCode: 1
   [manifest-disk-mismatch] café.txt — manifest records "café.txt" but disk has "café.txt" — same file under insensitive rules, different bytes. A cache key, checksum lookup, or diff keyed on the manifest spelling will not find this file.
   [manifest-would-collide] café.txt — manifest records 2 distinct spellings of the same name (café.txt , café.txt) that collide into one file under insensitive rules. If this manifest came from a byte-exact filesystem, materializing it here loses data.
```
