import { platformSensitivity } from './normalize.ts';
import type { FsSensitivity } from './normalize.ts';

export interface NormalizedCollectionOptions {
  /** Default: the current platform's rules. See {@link platformSensitivity}. */
  sensitivity?: FsSensitivity;
}

function keyFor(name: string, sensitivity: FsSensitivity): string {
  return sensitivity === 'insensitive' ? name.normalize('NFC') : name;
}

/**
 * A `Set<string>` of filenames keyed on "same file" identity instead of code
 * point identity.
 *
 * A plain `Set` is the textbook version of this bug: `set.add(nfc)` followed
 * by `set.has(nfd)` returns `false` even on a filesystem where the two names
 * are the same file, because `Set` hashes by string content. `NormalizedSet`
 * hashes by {@link sameFile} identity instead, so a "have I already processed
 * this file" check gives the answer that matches the filesystem it's checking
 * against.
 *
 * The first spelling added for a given identity is the one kept in
 * {@link values}; adding an equivalent spelling again is a no-op for
 * iteration purposes (matching the fact that only one directory entry exists
 * on an insensitive filesystem).
 */
export class NormalizedSet {
  #sensitivity: FsSensitivity;
  #entries = new Map<string, string>();

  constructor(entries: Iterable<string> = [], opts: NormalizedCollectionOptions = {}) {
    this.#sensitivity = opts.sensitivity ?? platformSensitivity();
    for (const e of entries) this.add(e);
  }

  add(name: string): this {
    const key = keyFor(name, this.#sensitivity);
    if (!this.#entries.has(key)) this.#entries.set(key, name);
    return this;
  }

  has(name: string): boolean {
    return this.#entries.has(keyFor(name, this.#sensitivity));
  }

  delete(name: string): boolean {
    return this.#entries.delete(keyFor(name, this.#sensitivity));
  }

  get size(): number {
    return this.#entries.size;
  }

  /** The spellings actually stored (first-seen spelling per identity). */
  values(): IterableIterator<string> {
    return this.#entries.values();
  }

  [Symbol.iterator](): IterableIterator<string> {
    return this.values();
  }
}

/**
 * A `Map<string, V>` keyed on "same file" identity instead of code point
 * identity. See {@link NormalizedSet} for the motivating bug.
 */
export class NormalizedMap<V> {
  #sensitivity: FsSensitivity;
  #entries = new Map<string, [string, V]>();

  constructor(entries: Iterable<[string, V]> = [], opts: NormalizedCollectionOptions = {}) {
    this.#sensitivity = opts.sensitivity ?? platformSensitivity();
    for (const [k, v] of entries) this.set(k, v);
  }

  set(name: string, value: V): this {
    const key = keyFor(name, this.#sensitivity);
    const existing = this.#entries.get(key);
    this.#entries.set(key, [existing ? existing[0] : name, value]);
    return this;
  }

  get(name: string): V | undefined {
    return this.#entries.get(keyFor(name, this.#sensitivity))?.[1];
  }

  has(name: string): boolean {
    return this.#entries.has(keyFor(name, this.#sensitivity));
  }

  delete(name: string): boolean {
    return this.#entries.delete(keyFor(name, this.#sensitivity));
  }

  get size(): number {
    return this.#entries.size;
  }

  *entries(): IterableIterator<[string, V]> {
    yield* this.#entries.values();
  }

  [Symbol.iterator](): IterableIterator<[string, V]> {
    return this.entries();
  }
}
