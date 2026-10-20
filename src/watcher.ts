import * as fs from 'fs';
import * as path from 'path';
import { nativePath, errorMessage } from './core/io';
import { SyncEngine } from './core/sync';
import { SAVE_TARGETS, keyForTarget, localPathForKey } from './core/targets';
import { Logger, RootKey } from './core/types';

interface WatchEntry {
  watcher: fs.FSWatcher;
  watchPath: string;
  recursive: boolean;
}

/**
 * The launcher has no "game closed" event and no "Flashpoint quitting" event
 * for extensions. Watching the save folders catches writes as they happen,
 * which covers both cases (including saves written when a game exits).
 */
export class SaveDataWatcher {
  private readonly watchEntries = new Map<string, WatchEntry>();
  private readonly roots: Record<RootKey, string>;
  private readonly pendingPaths = new Set<string>();
  private fullResync = false;
  private backupTimer: NodeJS.Timeout | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private disposed = false;

  constructor(
    private readonly engine: SyncEngine,
    roots: Record<RootKey, string>,
    private readonly logger: Logger,
    private readonly debounceMs = 2500,
    /** Called after a watcher-driven backup, so cloud sync can follow it. */
    private readonly onBackedUp?: () => void,
  ) {
    this.roots = roots;
  }

  start(): void {
    void this.refresh();
    this.refreshTimer = setInterval(() => void this.refresh(), 60_000);
    this.refreshTimer.unref?.();
  }

  /**
   * Add watchers for folders that exist now. Folders are often created by the
   * first game that writes to them, so this is repeated on an interval.
   */
  async refresh(): Promise<void> {
    if (this.disposed) {
      return;
    }
    for (const target of SAVE_TARGETS) {
      const fullPath = localPathForKey(this.roots, keyForTarget(target));
      let stat: fs.Stats;
      try {
        stat = fs.statSync(nativePath(fullPath));
      } catch {
        continue;
      }

      const key = keyForTarget(target);
      const isFile = stat.isFile();
      const watchPath = isFile ? path.dirname(fullPath) : fullPath;
      const recursive = !isFile;
      const existing = this.watchEntries.get(key);
      if (existing && existing.watchPath === watchPath && existing.recursive === recursive) {
        continue;
      }
      if (existing) {
        existing.watcher.close();
        this.watchEntries.delete(key);
      }

      try {
        const watcher = fs.watch(nativePath(watchPath), { recursive, persistent: false }, (_event, filename) => {
          if (filename === null) {
            // Without a name there is no safe incremental scope.
            this.scheduleBackup();
            return;
          }
          this.scheduleBackup(path.join(watchPath, filename.toString()));
        });
        watcher.on('error', error => {
          this.logger.debug(`Watcher for ${key} stopped: ${errorMessage(error)}`);
          watcher.close();
          this.watchEntries.delete(key);
        });
        this.watchEntries.set(key, { watcher, watchPath, recursive });
      } catch (error) {
        // A missing parent or a permission problem is retried on the next refresh.
        this.logger.debug(`Could not watch ${watchPath}: ${errorMessage(error)}`);
      }
    }
  }

  private scheduleBackup(changedPath?: string): void {
    if (this.disposed) {
      return;
    }
    if (changedPath) {
      this.pendingPaths.add(changedPath);
      // A very large burst is cheaper to reconcile as one full scan than as
      // thousands of overlapping per-file scans.
      if (this.pendingPaths.size > 2000) {
        this.pendingPaths.clear();
        this.fullResync = true;
      }
    } else {
      this.fullResync = true;
    }
    if (this.backupTimer) {
      clearTimeout(this.backupTimer);
    }
    // Games tend to write several files in a burst; wait until the burst ends.
    this.backupTimer = setTimeout(() => {
      this.backupTimer = null;
      const paths = [...this.pendingPaths];
      const fullResync = this.fullResync;
      this.pendingPaths.clear();
      this.fullResync = false;
      const sync = fullResync || paths.length === 0
        ? this.engine.syncAll('backup')
        : this.engine.syncChanges(paths, 'backup');
      void sync
        .catch(error => {
          this.logger.error(`Backup after file change failed: ${errorMessage(error)}`);
        })
        .finally(() => {
          // The Flashpoint copy may now be ahead of the cloud copy. Cloud sync
          // is debounced separately so it never races this backup.
          this.onBackedUp?.();
        });
    }, this.debounceMs);
  }

  dispose(): void {
    this.disposed = true;
    if (this.backupTimer) {
      clearTimeout(this.backupTimer);
      this.backupTimer = null;
    }
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    for (const entry of this.watchEntries.values()) {
      entry.watcher.close();
    }
    this.watchEntries.clear();
    this.pendingPaths.clear();
    this.fullResync = false;
  }
}
