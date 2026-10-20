import * as path from 'path';
import { FileEntry, Logger, ManifestData } from './types';
import { loadManifest, saveManifestState } from './manifest';
import { indexManifestFiles } from './scan';
import { statOrNull } from './io';

/** Case-insensitive lookup plus the original key, built once per load. */
export interface ManifestIndex {
  entries: Map<string, FileEntry>;
  keys: Map<string, string>;
}

export interface ManifestBundle {
  data: ManifestData | null;
  corrupt: boolean;
  /** Built once per load and reused by every call site until the file changes. */
  index: ManifestIndex;
}

interface DiskState {
  mtimeMs: number;
  size: number;
}

interface Cached {
  bundle: ManifestBundle;
  disk: DiskState | null;
  lastUsed: number;
  /** Cheap summary of the entry table, used to skip writes that change nothing. */
  fingerprint: string;
}

export interface ManifestStoreOptions {
  /**
   * Upper bound on the total number of entries kept in memory. Each entry costs
   * roughly 150-250 bytes once it has a key string and a map slot, so this also
   * bounds the memory a resident manifest set can take. When the bound is
   * exceeded the least recently used manifests are dropped; they are a cache, so
   * the next load simply reads them from disk again.
   */
  maxEntries?: number;
}

const DEFAULT_MAX_ENTRIES = 1_000_000;

/**
 * In-memory manifests for one sync engine.
 *
 * The manifest is a cache over the filesystem, so it is safe to keep it resident
 * and to throw it away at any point: the worst case is that the next sync
 * re-reads the file (or, for a lost write, re-verifies the data it describes).
 *
 * Two rules keep this correct:
 *
 *  - Every `load` is validated against the file's size and mtime, so another
 *    process (the CLI) writing a manifest is always noticed.
 *  - `save` writes to disk before it updates the cache, so a cache hit never
 *    describes state that was not persisted.
 *
 * The returned index maps are the live working state used by the sync loop; the
 * engine serialises all operations, so only one operation mutates them at a
 * time. Any failed operation must call `invalidateAll`, otherwise a partially
 * applied mutation would survive into the next operation.
 */
export class ManifestStore {
  private readonly cache = new Map<string, Cached>();
  private readonly loading = new Map<string, Promise<ManifestBundle>>();
  private readonly maxEntries: number;
  private clock = 0;
  private skipped = 0;

  constructor(
    private readonly logger: Logger,
    options: ManifestStoreOptions = {},
  ) {
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  /** Load a manifest, reusing the parsed table and index when it is unchanged. */
  async load(filePath: string, profile: string): Promise<ManifestBundle> {
    const key = cacheKey(filePath);
    const disk = await diskState(filePath);
    const cached = this.cache.get(key);
    if (cached && sameDisk(cached.disk, disk)) {
      cached.lastUsed = ++this.clock;
      return cached.bundle;
    }

    const pending = this.loading.get(key);
    if (pending) {
      return pending;
    }
    const promise = this.read(filePath, profile, key).finally(() => {
      this.loading.delete(key);
    });
    this.loading.set(key, promise);
    return promise;
  }

  /** Convenience for the many callers that only need the index. */
  async index(filePath: string, profile: string): Promise<ManifestIndex> {
    return (await this.load(filePath, profile)).index;
  }

  /**
   * Persist the given state and adopt it as the resident copy. The maps are
   * taken by reference: they are the same objects the sync loop mutates.
   */
  async save(
    filePath: string,
    profile: string,
    entries: Map<string, FileEntry>,
    keys: Map<string, string>,
  ): Promise<void> {
    const key = cacheKey(filePath);
    const fingerprint = fingerprintOf(entries);
    const cached = this.cache.get(key);

    // A sync writes both manifests whenever *anything* changed, even though the
    // side that changed may be the other one. Re-serialising an unchanged table
    // is the most expensive thing this class does, so prove it first: same
    // contents in memory and same file on disk means there is nothing to write.
    if (cached && cached.disk !== null && cached.fingerprint === fingerprint) {
      const disk = await diskState(filePath);
      if (sameDisk(cached.disk, disk)) {
        this.skipped++;
        cached.lastUsed = ++this.clock;
        this.logger.debug(
          `Left ${path.basename(filePath)} untouched: ${entries.size} entries unchanged.`,
        );
        return;
      }
    }

    const data = await saveManifestState(filePath, profile, entries, keys);
    const disk = await diskState(filePath);
    this.cache.set(key, {
      bundle: { data, corrupt: false, index: { entries, keys } },
      disk,
      lastUsed: ++this.clock,
      fingerprint,
    });
  }

  /** How many writes were skipped because nothing had changed. */
  get skippedWrites(): number {
    return this.skipped;
  }

  /** Forget one manifest, e.g. after it was deleted or rewritten by hand. */
  invalidate(filePath: string): void {
    this.cache.delete(cacheKey(filePath));
  }

  /** Forget everything. Called when a sync fails after mutating the indexes. */
  invalidateAll(): void {
    this.cache.clear();
  }

  /** Total entries currently held in memory. */
  get residentEntries(): number {
    let total = 0;
    for (const cached of this.cache.values()) {
      total += cached.bundle.index.entries.size;
    }
    return total;
  }

  /** Number of resident manifests, for logging and tests. */
  get residentManifests(): number {
    return this.cache.size;
  }

  /**
   * Apply the memory bound. Called at the end of an operation, never in the
   * middle of one, so a manifest that is being used cannot be evicted.
   */
  settle(): void {
    if (this.residentEntries <= this.maxEntries) {
      return;
    }
    const victims = [...this.cache.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    let total = this.residentEntries;
    for (const [key, cached] of victims) {
      if (total <= this.maxEntries) {
        break;
      }
      total -= cached.bundle.index.entries.size;
      this.cache.delete(key);
      this.logger.debug(
        `Dropped ${path.basename(key)} from memory (${cached.bundle.index.entries.size} entries); ` +
          `${total} of ${this.maxEntries} entries resident.`,
      );
    }
  }

  private async read(filePath: string, profile: string, key: string): Promise<ManifestBundle> {
    const result = await loadManifest(filePath, profile, this.logger);
    const disk = await diskState(filePath);
    const bundle: ManifestBundle = {
      data: result.data,
      corrupt: result.corrupt,
      index: indexManifestFiles(result.data?.files),
    };
    this.cache.set(key, {
      bundle,
      disk,
      lastUsed: ++this.clock,
      fingerprint: fingerprintOf(bundle.index.entries),
    });
    return bundle;
  }
}

function cacheKey(filePath: string): string {
  // Resolve only. Case is deliberately preserved: on a case-sensitive volume
  // two manifests can differ by case alone, and folding them would hand one
  // file's contents to the other.
  return path.resolve(filePath);
}

async function diskState(filePath: string): Promise<DiskState | null> {
  const stat = await statOrNull(filePath);
  return stat ? { mtimeMs: stat.mtimeMs, size: stat.size } : null;
}

/**
 * Summarise the entry table. Two tables with the same count, total size and
 * total modification time are treated as identical. A collision would only cost
 * a stale manifest, which the filesystem scan corrects on the next pass, so a
 * cheap summary is the right trade here.
 */
function fingerprintOf(entries: Map<string, FileEntry>): string {
  let count = 0;
  let sizeSum = 0;
  let mtimeSum = 0;
  for (const entry of entries.values()) {
    count++;
    sizeSum = (sizeSum + entry.size) % 1e12;
    mtimeSum = (mtimeSum + (entry.mtimeMs % 1e9)) % 1e12;
  }
  return `${count}:${sizeSum}:${mtimeSum}`;
}

function sameDisk(a: DiskState | null, b: DiskState | null): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return a.size === b.size && a.mtimeMs === b.mtimeMs;
}
