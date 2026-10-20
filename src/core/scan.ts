import * as os from 'os';
import * as path from 'path';
import { FileEntry, Logger, RootKey, SaveTarget, ScannedFile } from './types';
import { hashFile, isErrno, readDir, statOrNull } from './io';

/** Identity is case-insensitive because Windows paths are case-insensitive. */
export type FileIndex = Map<string, ScannedFile>;

export interface ScanOptions {
  targets: readonly SaveTarget[];
  roots: Record<RootKey, string>;
  /**
   * Absolute folder the scan starts from. Local scans pass the roots, archive
   * scans pass the profile folder (so the key path is appended below it).
   */
  basePath: (target: SaveTarget) => string;
  /** Last known state, used to avoid re-hashing unchanged files. */
  baseEntries: Map<string, FileEntry>;
  logger: Logger;
}

/**
 * Names that Windows creates on its own. They are not game data and syncing
 * them only produces noise and conflicts.
 */
const IGNORED_NAMES = new Set(['desktop.ini', 'thumbs.db', '.ds_store']);
const MAX_DEPTH = 64;

export function isIgnoredName(name: string): boolean {
  return IGNORED_NAMES.has(name.toLowerCase());
}
const SCAN_CONCURRENCY = Math.max(
  4,
  Math.min(32, (os.availableParallelism?.() ?? os.cpus().length) * 2),
);

interface ScanJob {
  absolute: string;
  key: string;
  depth: number;
}

export async function scanSaveData(options: ScanOptions): Promise<FileIndex> {
  const initial: ScanJob[] = options.targets.map(target => ({
    absolute: path.join(options.basePath(target), ...target.relative.split('/')),
    key: `${target.root}/${target.relative}`,
    depth: 0,
  }));
  return scanJobs(initial, options.baseEntries, options.logger);
}

/**
 * Scan exactly one file or folder. Used by incremental sync so a change to a
 * single save does not require walking the rest of the save-data tree.
 */
export async function scanPath(
  absolute: string,
  key: string,
  baseEntries: Map<string, FileEntry>,
  logger: Logger,
  /** Optional folder-name filter, used to skip data cloud sync does not own. */
  shouldSkip?: (name: string) => boolean,
): Promise<FileIndex> {
  if (isIgnoredName(path.basename(absolute))) {
    return new Map();
  }
  return scanJobs([{ absolute, key, depth: 0 }], baseEntries, logger, shouldSkip);
}

async function scanJobs(
  initial: ScanJob[],
  baseEntries: Map<string, FileEntry>,
  logger: Logger,
  shouldSkip?: (name: string) => boolean,
): Promise<FileIndex> {
  const files: FileIndex = new Map();
  const queue = initial.slice();
  let active = 0;

  await new Promise<void>(resolve => {
    const pump = (): void => {
      while (active < SCAN_CONCURRENCY && queue.length > 0) {
        const job = queue.shift();
        if (!job) {
          break;
        }
        active++;
        void processJob(job)
          .catch(error => {
            logger.warn(`Could not scan ${job.absolute}: ${(error as Error).message}`);
          })
          .finally(() => {
            active--;
            pump();
          });
      }
      if (active === 0 && queue.length === 0) {
        resolve();
      }
    };
    pump();
  });

  return files;

  async function processJob(job: ScanJob): Promise<void> {
    if (job.depth > MAX_DEPTH) {
      logger.warn(`Skipping ${job.absolute}: folder nesting is deeper than ${MAX_DEPTH} levels.`);
      return;
    }

    let stat;
    try {
      stat = await statOrNull(job.absolute);
    } catch (error) {
      logger.warn(`Could not stat ${job.absolute}: ${(error as Error).message}`);
      return;
    }
    if (!stat) {
      return;
    }

    if (stat.isFile()) {
      try {
        const entry = await entryFor(
          job.absolute,
          job.key,
          stat.size,
          stat.mtimeMs,
          baseEntries,
        );
        files.set(job.key.toLowerCase(), { key: job.key, absPath: job.absolute, entry });
      } catch (error) {
        // A file being written or locked by a running game must not abort the
        // scan of the whole folder; the next pass will pick it up.
        logger.warn(`Could not read ${job.absolute}: ${(error as Error).message}`);
      }
      return;
    }

    if (!stat.isDirectory()) {
      return;
    }

    let entries;
    try {
      entries = await readDir(job.absolute);
    } catch (error) {
      if (!isErrno(error, 'EACCES') && !isErrno(error, 'EPERM')) {
        throw error;
      }
      logger.warn(`Skipping unreadable folder ${job.absolute}: ${(error as Error).message}`);
      return;
    }

    for (const entry of entries) {
      if (isIgnoredName(entry.name) || shouldSkip?.(entry.name)) {
        continue;
      }
      if (entry.isSymbolicLink()) {
        logger.debug(`Skipping symbolic link ${path.join(job.absolute, entry.name)}`);
        continue;
      }
      if (!entry.isDirectory() && !entry.isFile()) {
        continue;
      }
      queue.push({
        absolute: path.join(job.absolute, entry.name),
        key: `${job.key}/${entry.name}`,
        depth: job.depth + 1,
      });
    }
  }
}

async function entryFor(
  absolute: string,
  key: string,
  size: number,
  mtimeMs: number,
  baseEntries: Map<string, FileEntry>,
): Promise<FileEntry> {
  const previous = baseEntries.get(key.toLowerCase());
  // A 2ms tolerance covers the difference between NTFS 100ns timestamps and
  // the millisecond values JavaScript exposes.
  if (previous && previous.size === size && Math.abs(previous.mtimeMs - mtimeMs) < 2) {
    return previous;
  }
  return {
    hash: await hashFile(absolute),
    size,
    mtimeMs,
  };
}

/**
 * Resolve a manifest's file table into a case-insensitive lookup while keeping
 * the original key for display/writing.
 */
export function indexManifestFiles(files: Record<string, FileEntry> | undefined): {
  entries: Map<string, FileEntry>;
  keys: Map<string, string>;
} {
  const entries = new Map<string, FileEntry>();
  const keys = new Map<string, string>();
  if (!files) {
    return { entries, keys };
  }
  for (const [key, entry] of Object.entries(files)) {
    if (!isFileEntry(entry)) {
      continue;
    }
    const lower = key.toLowerCase();
    entries.set(lower, entry);
    keys.set(lower, key);
  }
  return { entries, keys };
}

export function isFileEntry(value: unknown): value is FileEntry {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const entry = value as Partial<FileEntry>;
  return (
    typeof entry.hash === 'string' &&
    typeof entry.size === 'number' &&
    Number.isFinite(entry.size) &&
    typeof entry.mtimeMs === 'number' &&
    Number.isFinite(entry.mtimeMs)
  );
}
