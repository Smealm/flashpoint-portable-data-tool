import * as path from 'path';
import {
  ConflictPolicy,
  CopyProfileResult,
  DeleteProfileResult,
  DeleteSystemResult,
  FileEntry,
  Logger,
  ManifestData,
  PartitionStatus,
  ProfileSummary,
  SaveTarget,
  ScannedFile,
  SyncAllResult,
  SyncEngineOptions,
  SyncMode,
  SyncResult,
  SyncStatus,
  WarmupStep,
} from './types';
import {
  archivePathForKey,
  assertProfileName,
  localPathForKey,
  matchLocalPath,
  sanitizeProfileName,
  SAVE_TARGETS,
} from './targets';
import { FileIndex, isIgnoredName, scanPath, scanSaveData } from './scan';
import { manifestPath } from './manifest';
import { ManifestStore } from './manifest-store';
import {
  copyDirRecursive,
  copyFilePreserve,
  ensureDir,
  errorMessage,
  exists,
  isErrno,
  listDirNames,
  pruneEmptyParents,
  readDir,
  readJson,
  removeDir,
  removeIfExists,
  statOrNull,
  writeJsonAtomic,
} from './io';

interface Side {
  files: FileIndex;
  base: Map<string, FileEntry>;
  keys: Map<string, string>;
}

interface SyncOptions {
  /**
   * Treat the archive as authoritative for every file it contains, regardless
   * of manifests. Used by the explicit "deploy profile" action.
   */
  forceRemote?: boolean;
  /** Keys whose first-sync overlay failed and must be retried as downloads. */
  restoreKeys?: Set<string>;
}

interface ChangedPath {
  absolute: string;
  key: string;
}

const CONFLICTS_DIR = '.conflicts';
const SYNC_CONCURRENCY = 8;

/**
 * Folder name for the system-level partition. It is dot-prefixed on purpose:
 * profile names are sanitized by stripping leading dots, so no Windows account
 * can ever produce this name. It also lives outside the `profiles` root.
 */
export const SYSTEM_DIR_NAME = '.global';
const SYSTEM_MANIFEST_ID = '.global';

type PartitionKind = 'profile' | 'system';

interface Partition {
  id: string;
  archiveDir: string;
  localManifestPath: string;
  targets: readonly SaveTarget[];
  label: string;
}

export class SyncEngine {
  private readonly logger: Logger;
  private readonly archiveRoot: string;
  private readonly systemRoot: string;
  private readonly stateDir: string;
  private readonly roots: Record<'R' | 'LL' | 'PD', string>;
  private readonly targets = SAVE_TARGETS;
  private safetyBackups: boolean;
  private conflictPolicy: ConflictPolicy;
  private readonly store: ManifestStore;

  private _profile: string;
  private queue: Promise<unknown> = Promise.resolve();
  private programDataHintLogged = false;

  constructor(options: SyncEngineOptions) {
    this.logger = options.logger;
    this.archiveRoot = options.archiveRoot;
    this.systemRoot = options.systemRoot;
    assertSeparatePartitions(options.archiveRoot, options.systemRoot);
    this.stateDir = options.stateDir;
    this.roots = options.roots;
    this.safetyBackups = options.safetyBackups;
    this.conflictPolicy = options.conflictPolicy;
    this._profile = sanitizeProfileName(options.profile);
    // One resident manifest set per engine: sync, status and cloud sync all hit
    // the same files repeatedly, so they share this instead of re-reading them.
    this.store = new ManifestStore(options.logger);
    if (options.targets) {
      this.targets = options.targets;
    }
  }

  get profile(): string {
    return this._profile;
  }

  get profilesRoot(): string {
    return this.archiveRoot;
  }

  get profileDir(): string {
    return path.join(this.archiveRoot, this._profile);
  }

  get localStatePath(): string {
    return this.localManifestPath(this._profile);
  }

  get systemDir(): string {
    return this.systemRoot;
  }

  get systemLocalStatePath(): string {
    return path.join(this.stateDir, `${SYSTEM_DIR_NAME}.json`);
  }

  setProfile(profile: string): void {
    this._profile = sanitizeProfileName(profile);
  }

  setConflictPolicy(policy: ConflictPolicy): void {
    this.conflictPolicy = policy;
  }

  setSafetyBackups(enabled: boolean): void {
    this.safetyBackups = enabled;
  }

  /** Sync the active Windows-account profile (Roaming + LocalLow). */
  sync(mode: SyncMode = 'full'): Promise<SyncResult> {
    return this.run(() => this.syncPartition('profile', mode));
  }

  /** Sync the system-level partition (ProgramData only). */
  syncSystem(mode: SyncMode = 'full'): Promise<SyncResult> {
    return this.run(() => this.syncPartition('system', mode));
  }

  /** Sync both partitions under one lock. Used at startup and before launch. */
  syncAll(mode: SyncMode = 'full'): Promise<SyncAllResult> {
    return this.run(async () => {
      // The partitions are disjoint, so scanning and copying them in parallel
      // is safe and keeps startup from waiting for one side after the other.
      const [profile, system] = await Promise.all([
        this.syncPartition('profile', mode),
        this.syncPartition('system', mode),
      ]);
      return { profile, system };
    });
  }

  /**
   * Sync only the files or folders reported by the filesystem watcher. This is
   * the fast path used while Flashpoint is running: a single save change does
   * not trigger a scan of every save file on the machine.
   */
  syncChanges(paths: Iterable<string>, mode: SyncMode = 'backup'): Promise<SyncAllResult> {
    const changed = [...new Set(paths)];
    if (changed.length === 0) {
      return Promise.resolve({ profile: emptyResult(), system: emptyResult() });
    }
    return this.run(async () => {
      const matches: Record<PartitionKind, ChangedPath[]> = { profile: [], system: [] };
      for (const absolute of changed) {
        const match = matchLocalPath(this.roots, this.targets, absolute);
        if (!match) {
          continue;
        }
        const partition: PartitionKind = match.target.root === 'PD' ? 'system' : 'profile';
        matches[partition].push({ absolute, key: match.key });
      }
      return {
        profile: await this.syncChangedPartition('profile', matches.profile, mode),
        system: await this.syncChangedPartition('system', matches.system, mode),
      };
    });
  }

  /**
   * Apply a profile from the archive to this machine, with the archive always
   * winning. Used when moving save data between accounts/machines. This never
   * touches the system partition.
   */
  deploy(profile: string): Promise<SyncResult> {
    const name = assertProfileName(profile);
    return this.run(async () => {
      const profileDir = path.join(this.archiveRoot, name);
      if (!(await exists(profileDir))) {
        throw new Error(`Profile "${name}" does not exist in the archive. Use Copy profile to create it first.`);
      }
      this._profile = name;
      return this.syncPartition('profile', 'full', { forceRemote: true });
    });
  }

  /** Apply the archived ProgramData partition over this machine's live data. */
  deploySystem(): Promise<SyncResult> {
    return this.run(async () => {
      if (!(await exists(this.systemRoot))) {
        throw new Error('No archived system data yet. Run a system sync first.');
      }
      return this.syncPartition('system', 'full', { forceRemote: true });
    });
  }

  private run<T>(task: () => Promise<T>): Promise<T> {
    // All operations share one queue: a backup must never scan a half-applied sync.
    const guarded = async (): Promise<T> => {
      try {
        const value = await task();
        this.store.settle();
        return value;
      } catch (error) {
        // The resident indexes may have been mutated before the failure. Drop
        // them so the next operation starts from what is actually on disk.
        this.store.invalidateAll();
        throw error;
      }
    };
    const next = this.queue.then(guarded, guarded);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /**
   * Manifests this engine can pre-load at startup. Loading them here means the
   * first sync and the first manager redraw find everything already parsed.
   */
  warmSteps(): WarmupStep[] {
    const profile = this.partition('profile');
    const system = this.partition('system');
    const load = (filePath: string, id: string) => async (): Promise<number> =>
      (await this.store.load(filePath, id)).index.entries.size;
    return [
      {
        label: `profile data (${profile.id})`,
        run: load(manifestPath(profile.archiveDir), profile.id),
      },
      {
        label: `profile local state (${profile.id})`,
        run: load(profile.localManifestPath, profile.id),
      },
      {
        label: 'system data',
        run: load(manifestPath(system.archiveDir), system.id),
      },
      {
        label: 'system local state',
        run: load(system.localManifestPath, system.id),
      },
    ];
  }

  /** Resident manifest counts, for diagnostics and tests. */
  get manifestCacheStats(): { manifests: number; entries: number } {
    return { manifests: this.store.residentManifests, entries: this.store.residentEntries };
  }

  /** Manifest writes that were skipped because nothing had changed. */
  get skippedManifestWrites(): number {
    return this.store.skippedWrites;
  }

  private localManifestPath(profile: string): string {
    return path.join(this.stateDir, `${profile}.json`);
  }

  private partition(kind: PartitionKind): Partition {
    if (kind === 'system') {
      return {
        id: SYSTEM_MANIFEST_ID,
        archiveDir: this.systemRoot,
        localManifestPath: this.systemLocalStatePath,
        targets: this.targets.filter(target => target.root === 'PD'),
        label: 'system data (ProgramData)',
      };
    }
    return {
      id: this._profile,
      archiveDir: this.profileDir,
      localManifestPath: this.localManifestPath(this._profile),
      targets: this.targets.filter(target => target.root !== 'PD'),
      label: `profile "${this._profile}"`,
    };
  }

  private syncPartition(kind: PartitionKind, mode: SyncMode, options: SyncOptions = {}): Promise<SyncResult> {
    return this.syncNow(this.partition(kind), mode, options);
  }

  private async syncNow(
    partition: Partition,
    mode: SyncMode,
    options: SyncOptions = {},
  ): Promise<SyncResult> {
    const result = emptyResult();
    const profile = partition.id;
    const profileDir = partition.archiveDir;

    const remoteLoaded = await this.store.load(manifestPath(profileDir), profile);
    const localLoaded = await this.store.load(partition.localManifestPath, profile);
    const firstSync = localLoaded.data === null;
    result.firstSync = firstSync;

    if (firstSync && mode === 'backup' && !options.forceRemote) {
      this.logger.info('Skipping backup: no local manifest for this machine yet. A full sync is required first.');
      return result;
    }

    const remoteIndex = remoteLoaded.index;
    const localIndex = localLoaded.index;
    const specialSync = firstSync || options.forceRemote === true;

    const [localFiles, remoteFiles] = await Promise.all([
      scanSaveData({
        targets: partition.targets,
        roots: this.roots,
        basePath: target => this.roots[target.root],
        // On a first sync the local manifest does not exist, so hash everything.
        baseEntries: specialSync ? new Map() : new Map(localIndex.entries),
        logger: this.logger,
      }),
      scanSaveData({
        targets: partition.targets,
        roots: this.roots,
        basePath: target => path.join(profileDir, target.root),
        baseEntries: remoteIndex.entries,
        logger: this.logger,
      }),
    ]);

    const local: Side = { files: localFiles, base: localIndex.entries, keys: localIndex.keys };
    const remote: Side = { files: remoteFiles, base: remoteIndex.entries, keys: remoteIndex.keys };

    if (firstSync && !options.forceRemote) {
      // "No manifest for this machine's user data folder -> the archive wins."
      // Overlay the archive first, then continue with normal matching. Local-only
      // files are uploaded during the same pass, so nothing is stranded.
      const failedOverlay = await this.overlayRemote(profileDir, local, remote, result);
      // The archive is now the agreed base for the files we just laid down.
      local.base.clear();
      local.keys.clear();
      remote.base.clear();
      remote.keys.clear();
      for (const [lower, file] of remote.files) {
        if (failedOverlay.has(lower)) {
          continue;
        }
        local.base.set(lower, file.entry);
        remote.base.set(lower, file.entry);
        local.keys.set(lower, local.files.get(lower)?.key ?? file.key);
        remote.keys.set(lower, file.key);
      }
      if (failedOverlay.size > 0) {
        options = { ...options, restoreKeys: failedOverlay };
      }
    }

    const allKeys = new Set<string>([
      ...local.files.keys(),
      ...remote.files.keys(),
      ...local.base.keys(),
      ...remote.base.keys(),
    ]);

    await forEachConcurrent([...allKeys], SYNC_CONCURRENCY, async lower => {
      try {
        await this.syncKey(lower, local, remote, profileDir, mode, options, result);
      } catch (error) {
        result.errors++;
        this.logger.error(`Failed to sync ${lower}: ${errorMessage(error)}`);
        this.logProgramDataHint(lower, error);
      }
    });

    if (mode === 'full' || result.firstSync || hasChanges(result)) {
      await ensureDir(profileDir);
      await this.store.save(manifestPath(profileDir), profile, remote.base, remote.keys);
      await this.store.save(partition.localManifestPath, profile, local.base, local.keys);
    }

    const summary = `Sync (${mode}) for ${partition.label}: ${result.uploaded} uploaded, ${result.downloaded} downloaded, ` +
      `${result.conflicts} conflicts, ${result.deferred} deferred, ${result.errors} errors`;
    if (hasChanges(result) || result.firstSync) {
      this.logger.info(summary);
    } else {
      this.logger.debug(summary);
    }

    return result;
  }

  private async syncChangedPartition(
    kind: PartitionKind,
    paths: ChangedPath[],
    mode: SyncMode,
  ): Promise<SyncResult> {
    const result = emptyResult();
    if (paths.length === 0) {
      return result;
    }

    const partition = this.partition(kind);
    const profile = partition.id;
    const profileDir = partition.archiveDir;
    const remoteLoaded = await this.store.load(manifestPath(profileDir), profile);
    const localLoaded = await this.store.load(partition.localManifestPath, profile);

    // A first sync needs the full archive-wins pass. The watcher normally
    // starts after that, but activation and startup sync can overlap.
    if (localLoaded.data === null) {
      return this.syncNow(partition, mode);
    }

    const remoteIndex = remoteLoaded.index;
    const localIndex = localLoaded.index;
    const localFiles: FileIndex = new Map();
    const remoteFiles: FileIndex = new Map();
    const localScans = new Map<string, string>();
    const remoteScans = new Map<string, string>();
    const candidateKeys = new Set<string>();

    for (const changed of paths) {
      if (isIgnoredName(path.basename(changed.absolute))) {
        continue;
      }
      let stat = null;
      try {
        stat = await statOrNull(changed.absolute);
      } catch (error) {
        this.logger.warn(`Could not inspect changed path ${changed.absolute}: ${errorMessage(error)}`);
        continue;
      }
      const lowerKey = changed.key.toLowerCase();
      const exactKeyKnown = localIndex.keys.has(lowerKey) || remoteIndex.keys.has(lowerKey);
      const nestedKeys = stat === null && !exactKeyKnown &&
        (hasKeysAtOrUnder(localIndex.keys, lowerKey) || hasKeysAtOrUnder(remoteIndex.keys, lowerKey));
      const directoryLike = stat?.isDirectory() === true || nestedKeys;

      if (directoryLike) {
        addKeysAtOrUnder(localIndex.keys, lowerKey, candidateKeys);
        addKeysAtOrUnder(remoteIndex.keys, lowerKey, candidateKeys);
      } else {
        candidateKeys.add(lowerKey);
      }

      localScans.set(changed.absolute, changed.key);
      remoteScans.set(archivePathForKey(profileDir, changed.key), changed.key);
    }

    const [localScanned, remoteScanned] = await Promise.all([
      scanChangedPaths(localScans, localIndex.entries, this.logger),
      scanChangedPaths(remoteScans, remoteIndex.entries, this.logger),
    ]);
    for (const [lower, file] of localScanned) {
      candidateKeys.add(lower);
      localFiles.set(lower, file);
    }
    for (const [lower, file] of remoteScanned) {
      candidateKeys.add(lower);
      remoteFiles.set(lower, file);
    }

    const local: Side = { files: localFiles, base: localIndex.entries, keys: localIndex.keys };
    const remote: Side = { files: remoteFiles, base: remoteIndex.entries, keys: remoteIndex.keys };
    const allKeys = new Set<string>([...candidateKeys, ...localFiles.keys(), ...remoteFiles.keys()]);

    await forEachConcurrent([...allKeys], SYNC_CONCURRENCY, async lower => {
      try {
        await this.syncKey(lower, local, remote, profileDir, mode, {}, result);
      } catch (error) {
        result.errors++;
        this.logger.error(`Failed to sync ${lower}: ${errorMessage(error)}`);
        this.logProgramDataHint(lower, error);
      }
    });

    if (mode === 'full' || hasChanges(result)) {
      await ensureDir(profileDir);
      await this.store.save(manifestPath(profileDir), profile, remote.base, remote.keys);
      await this.store.save(partition.localManifestPath, profile, local.base, local.keys);
    }

    const summary = `Sync (${mode}, incremental) for ${partition.label}: ${result.uploaded} uploaded, ` +
      `${result.downloaded} downloaded, ${result.conflicts} conflicts, ${result.deferred} deferred, ` +
      `${result.errors} errors`;
    if (hasChanges(result)) {
      this.logger.info(summary);
    } else {
      this.logger.debug(summary);
    }

    return result;
  }

  private async syncKey(
    lower: string,
    local: Side,
    remote: Side,
    profileDir: string,
    mode: SyncMode,
    options: SyncOptions,
    result: SyncResult,
  ): Promise<void> {
    const l = local.files.get(lower);
    const r = remote.files.get(lower);

    if (options.restoreKeys?.has(lower) && r) {
      if (mode === 'backup') {
        result.deferred++;
      } else {
        await this.download(lower, r, local, remote, result);
      }
      return;
    }

    if (options.forceRemote) {
      if (l && r) {
        if (l.entry.hash === r.entry.hash) {
          converge(lower, l, r, local, remote);
        } else {
          await this.resolveRemoteWins(lower, l, r, profileDir, local, remote, result);
        }
      } else if (r) {
        await this.download(lower, r, local, remote, result);
      } else if (l) {
        await this.upload(lower, l, profileDir, local, remote, result);
      } else {
        drop(lower, local, remote);
      }
      return;
    }

    if (!l && !r) {
      drop(lower, local, remote);
      return;
    }

    if (l && r && l.entry.hash === r.entry.hash) {
      converge(lower, l, r, local, remote);
      return;
    }

    if (!l) {
      // A missing local file is restored, never treated as a delete request.
      if (mode === 'backup') {
        result.deferred++;
        this.logger.debug(`Deferring restore of ${lower} until the next full sync.`);
      } else if (r) {
        await this.download(lower, r, local, remote, result);
      }
      return;
    }

    if (!r) {
      // Likewise, a missing archive file is recreated from the local copy.
      await this.upload(lower, l, profileDir, local, remote, result);
      return;
    }

    const localChanged = l.entry.hash !== local.base.get(lower)?.hash;
    const remoteChanged = r.entry.hash !== remote.base.get(lower)?.hash;

    if (remoteChanged && !localChanged) {
      if (mode === 'backup') {
        // A running game must never have a file pulled out from under it.
        result.deferred++;
        return;
      }
      await this.download(lower, r, local, remote, result);
    } else if (localChanged && !remoteChanged) {
      await this.upload(lower, l, profileDir, local, remote, result);
    } else {
      await this.resolveConflict(lower, l, r, profileDir, local, remote, mode, result);
    }
  }

  private logProgramDataHint(lowerKey: string, error: unknown): void {
    if (this.programDataHintLogged || !lowerKey.startsWith('pd/')) {
      return;
    }
    if (!isErrno(error, 'EACCES') && !isErrno(error, 'EPERM')) {
      return;
    }
    this.programDataHintLogged = true;
    this.logger.warn(
      'Windows denied a write under %PROGRAMDATA%. FPDT writes individual files inside the app folders ' +
      '(for example ...\\Adobe\\Director 11\\SPR\\Prefs), not to the ProgramData root. Default Windows ACLs ' +
      'normally let standard users write there. If an installer locked those folders down, run Flashpoint once ' +
      'as administrator so the folders are created, or grant this account modify rights, then sync again.',
    );
  }

  private async resolveConflict(
    lower: string,
    l: ScannedFile,
    r: ScannedFile,
    profileDir: string,
    local: Side,
    remote: Side,
    mode: SyncMode,
    result: SyncResult,
  ): Promise<void> {
    if (mode === 'backup') {
      // Pulling or resolving while a game is running could overwrite live data.
      result.deferred++;
      this.logger.debug(`Deferring conflict for ${lower} until the next full sync.`);
      return;
    }

    result.conflicts++;
    const winner: 'local' | 'remote' = this.conflictPolicy === 'local'
      ? 'local'
      : this.conflictPolicy === 'remote'
        ? 'remote'
        : l.entry.mtimeMs > r.entry.mtimeMs
          ? 'local'
          : 'remote';

    this.logger.warn(
      `Conflict on ${lower}: ${winner} wins (policy: ${this.conflictPolicy}, local ${new Date(l.entry.mtimeMs).toISOString()}, ` +
      `archive ${new Date(r.entry.mtimeMs).toISOString()}).`,
    );

    if (winner === 'remote') {
      await this.resolveRemoteWins(lower, l, r, profileDir, local, remote, result);
    } else {
      await this.resolveLocalWins(lower, l, r, profileDir, local, remote, result);
    }
  }

  private async resolveRemoteWins(
    lower: string,
    l: ScannedFile,
    r: ScannedFile,
    profileDir: string,
    local: Side,
    remote: Side,
    result: SyncResult,
  ): Promise<void> {
    await this.stash(profileDir, 'local', l, result);
    await this.download(lower, r, local, remote, result);
  }

  private async resolveLocalWins(
    lower: string,
    l: ScannedFile,
    r: ScannedFile,
    profileDir: string,
    local: Side,
    remote: Side,
    result: SyncResult,
  ): Promise<void> {
    await this.stash(profileDir, 'remote', r, result);
    await this.upload(lower, l, profileDir, local, remote, result);
  }

  private async download(
    lower: string,
    r: ScannedFile,
    local: Side,
    remote: Side,
    result: SyncResult,
  ): Promise<void> {
    const localKey = local.files.get(lower)?.key ?? r.key;
    const destination = localPathForKey(this.roots, localKey);
    await copyFilePreserve(r.absPath, destination);
    local.files.set(lower, { key: localKey, absPath: destination, entry: r.entry });
    local.base.set(lower, r.entry);
    local.keys.set(lower, localKey);
    remote.base.set(lower, r.entry);
    remote.keys.set(lower, r.key);
    result.downloaded++;
  }

  private async upload(
    lower: string,
    l: ScannedFile,
    profileDir: string,
    local: Side,
    remote: Side,
    result: SyncResult,
  ): Promise<void> {
    const remoteKey = remote.files.get(lower)?.key ?? l.key;
    const destination = archivePathForKey(profileDir, remoteKey);
    await copyFilePreserve(l.absPath, destination);
    remote.files.set(lower, { key: remoteKey, absPath: destination, entry: l.entry });
    remote.base.set(lower, l.entry);
    remote.keys.set(lower, remoteKey);
    local.base.set(lower, l.entry);
    local.keys.set(lower, l.key);
    result.uploaded++;
  }

  private async stash(profileDir: string, side: 'local' | 'remote', file: ScannedFile, result: SyncResult): Promise<boolean> {
    if (!this.safetyBackups) {
      return false;
    }
    const destination = path.join(
      profileDir,
      CONFLICTS_DIR,
      conflictStamp(),
      side,
      ...file.key.split('/'),
    );
    try {
      await copyFilePreserve(file.absPath, destination);
      result.stashed++;
      return true;
    } catch (error) {
      result.errors++;
      this.logger.warn(`Could not keep a conflict copy of ${file.key}: ${errorMessage(error)}`);
      return false;
    }
  }

  /** First-sync overlay: archive copies are written over local files. */
  private async overlayRemote(
    profileDir: string,
    local: Side,
    remote: Side,
    result: SyncResult,
  ): Promise<Set<string>> {
    const failed = new Set<string>();
    await forEachConcurrent([...remote.files.values()], SYNC_CONCURRENCY, async r => {
      const lower = r.key.toLowerCase();
      const existing = local.files.get(lower);
      if (existing && existing.entry.hash === r.entry.hash) {
        return;
      }
      const localKey = existing?.key ?? r.key;
      const destination = localPathForKey(this.roots, localKey);
      let stashed = false;
      try {
        if (existing) {
          stashed = await this.stash(profileDir, 'local', existing, result);
        }
        await copyFilePreserve(r.absPath, destination);
        local.files.set(lower, { key: localKey, absPath: destination, entry: r.entry });
        result.downloaded++;
      } catch (error) {
        result.errors++;
        failed.add(lower);
        this.logger.error(`First-sync restore failed for ${r.key}: ${errorMessage(error)}`);
        this.logProgramDataHint(lower, error);
        if (existing && stashed) {
          // The old version is safe in .conflicts. Remove it so the next sync
          // sees "local missing" and retries the restore instead of uploading
          // the stale file over the archive.
          try {
            await removeIfExists(destination);
            local.files.delete(lower);
          } catch (removeError) {
            this.logger.warn(`Could not remove stale local file ${destination}: ${errorMessage(removeError)}`);
          }
        }
      }
    });
    return failed;
  }

  async listProfiles(): Promise<string[]> {
    const names = await listDirNames(this.archiveRoot);
    return names
      .filter(name => !name.startsWith('.'))
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  }

  async status(options: { scan?: boolean; includeProfiles?: boolean } = {}): Promise<SyncStatus> {
    const partition = this.partition('profile');
    const profile = partition.id;
    const profileDir = partition.archiveDir;
    const [remoteLoaded, localLoaded] = await Promise.all([
      this.store.load(manifestPath(profileDir), profile),
      this.store.load(partition.localManifestPath, profile),
    ]);
    const remoteIndex = remoteLoaded.index;
    const localIndex = localLoaded.index;

    let localFileCount = localIndex.entries.size;
    let localBytes = sumEntries(localIndex.entries);
    let remoteFileCount = remoteIndex.entries.size;
    let remoteBytes = sumEntries(remoteIndex.entries);
    if (options.scan) {
      const [localFiles, remoteFiles] = await Promise.all([
        scanSaveData({
          targets: partition.targets,
          roots: this.roots,
          basePath: target => this.roots[target.root],
          baseEntries: localIndex.entries,
          logger: this.logger,
        }),
        scanSaveData({
          targets: partition.targets,
          roots: this.roots,
          basePath: target => path.join(profileDir, target.root),
          baseEntries: remoteIndex.entries,
          logger: this.logger,
        }),
      ]);
      localFileCount = localFiles.size;
      localBytes = sumSizes(localFiles);
      remoteFileCount = remoteFiles.size;
      remoteBytes = sumSizes(remoteFiles);
    }

    const profiles: ProfileSummary[] = [];
    if (options.includeProfiles === true) {
      for (const name of await this.listProfiles()) {
        profiles.push(await this.profileSummary(name));
      }
      if (!profiles.some(p => p.active)) {
        profiles.unshift({ name: profile, active: true, fileCount: 0, bytes: 0, lastSync: null });
      }
    }

    return {
      profile,
      archiveRoot: this.archiveRoot,
      profileDir,
      localStatePath: partition.localManifestPath,
      roots: this.roots,
      localFileCount,
      localBytes,
      remoteFileCount,
      remoteBytes,
      lastLocalSync: localLoaded.data?.updatedAt || null,
      lastRemoteSync: remoteLoaded.data?.updatedAt || null,
      profiles,
      system: await this.partitionStatus(this.partition('system'), options.scan === true),
    };
  }

  /** Read one profile's archive manifest, without touching other profiles. */
  async profileSummary(name: string): Promise<ProfileSummary> {
    const profile = sanitizeProfileName(name);
    const loaded = await this.store.load(manifestPath(path.join(this.archiveRoot, profile)), profile);
    let bytes = 0;
    for (const entry of loaded.index.entries.values()) {
      bytes += entry.size;
    }
    return {
      name: profile,
      active: profile.toLowerCase() === this._profile.toLowerCase(),
      fileCount: loaded.index.entries.size,
      bytes,
      lastSync: loaded.data?.updatedAt || null,
    };
  }

  /** Live and archived sizes for one partition (currently used for system data). */
  private async partitionStatus(partition: Partition, scan: boolean): Promise<PartitionStatus> {
    const [archiveLoaded, localLoaded] = await Promise.all([
      this.store.load(manifestPath(partition.archiveDir), partition.id),
      this.store.load(partition.localManifestPath, partition.id),
    ]);
    const archiveIndex = archiveLoaded.index;
    const localIndex = localLoaded.index;

    let localFileCount = localIndex.entries.size;
    let localBytes = sumEntries(localIndex.entries);
    let archiveFileCount = archiveIndex.entries.size;
    let archiveBytes = sumEntries(archiveIndex.entries);
    if (scan) {
      const [archiveFiles, localFiles] = await Promise.all([
        scanSaveData({
          targets: partition.targets,
          roots: this.roots,
          basePath: target => path.join(partition.archiveDir, target.root),
          baseEntries: archiveIndex.entries,
          logger: this.logger,
        }),
        scanSaveData({
          targets: partition.targets,
          roots: this.roots,
          basePath: target => this.roots[target.root],
          baseEntries: localIndex.entries,
          logger: this.logger,
        }),
      ]);
      localFileCount = localFiles.size;
      localBytes = sumSizes(localFiles);
      archiveFileCount = archiveFiles.size;
      archiveBytes = sumSizes(archiveFiles);
    }

    return {
      archiveDir: partition.archiveDir,
      localStatePath: partition.localManifestPath,
      localFileCount,
      localBytes,
      archiveFileCount,
      archiveBytes,
      lastSync: archiveLoaded.data?.updatedAt || null,
    };
  }

  async copyProfile(from: string, to: string, options: { overwrite?: boolean } = {}): Promise<CopyProfileResult> {
    const sourceName = assertProfileName(from);
    const targetName = assertProfileName(to);
    if (sourceName.toLowerCase() === targetName.toLowerCase()) {
      throw new Error('Source and destination profiles are the same.');
    }
    return this.run(async () => {
      const sourceDir = path.join(this.archiveRoot, sourceName);
      const targetDir = path.join(this.archiveRoot, targetName);
      if (!(await exists(sourceDir))) {
        throw new Error(`Profile "${sourceName}" does not exist in the archive.`);
      }
      if (await exists(targetDir)) {
        if (!options.overwrite) {
          throw new Error(`Profile "${targetName}" already exists. Enable overwrite to replace it.`);
        }
        await removeDir(targetDir);
      }

      await copyDirRecursive(sourceDir, targetDir);
      // Older builds copied ProgramData into every profile. Never propagate
      // that legacy copy into a new profile; system data has its own partition.
      await removeDir(path.join(targetDir, 'PD'));
      const copiedFiles = await countFiles(targetDir);

      // Keep the copied manifest consistent with its new folder name and drop
      // any legacy PD entries so the profile does not appear to own them.
      const targetManifest = manifestPath(targetDir);
      try {
        const data = await readJson<ManifestData>(targetManifest);
        for (const key of Object.keys(data.files ?? {})) {
          if (key.toLowerCase().startsWith('pd/')) {
            delete data.files[key];
          }
        }
        data.profile = targetName;
        data.updatedAt = new Date().toISOString();
        await writeJsonAtomic(targetManifest, data);
        // The copy was rewritten outside the store, so any resident copy of it
        // is now older than the file on disk.
        this.store.invalidate(targetManifest);
      } catch (error) {
        if (!isErrno(error, 'ENOENT') && !(error instanceof SyntaxError)) {
          throw error;
        }
      }

      this.logger.info(`Copied profile "${sourceName}" to "${targetName}" (${copiedFiles} files).`);
      return { from: sourceName, to: targetName, copiedFiles };
    });
  }

  async deleteProfile(profile: string, options: { deleteLocalData?: boolean } = {}): Promise<DeleteProfileResult> {
    const name = assertProfileName(profile);
    return this.run(async () => {
      const profileDir = path.join(this.archiveRoot, name);
      const localManifest = this.localManifestPath(name);
      let deletedLocalFiles = 0;

      if (options.deleteLocalData) {
        const loaded = await this.store.load(localManifest, name);
        const profileRoots = new Set(this.partition('profile').targets.map(target => target.root));
        for (const key of loaded.index.keys.values()) {
          try {
            const { root } = splitKeySafe(key);
            // A legacy manifest may still list PD files. Profile deletion must
            // never remove live ProgramData; that belongs to the system partition.
            if (!profileRoots.has(root)) {
              continue;
            }
            const filePath = localPathForKey(this.roots, key);
            if (await statOrNull(filePath)) {
              await removeIfExists(filePath);
              deletedLocalFiles++;
              await pruneEmptyParents(filePath, this.roots[root]);
            }
          } catch (error) {
            this.logger.warn(`Could not delete local file ${key}: ${errorMessage(error)}`);
          }
        }
      }

      const deletedArchiveFiles = await countFiles(profileDir);
      await removeDir(profileDir);
      await removeIfExists(localManifest);
      this.store.invalidate(manifestPath(profileDir));
      this.store.invalidate(localManifest);
      this.logger.info(`Deleted profile "${name}" (${deletedArchiveFiles} archived files, ${deletedLocalFiles} local files).`);

      return { profile: name, deletedArchiveFiles, deletedLocalFiles };
    });
  }

  async deleteSystem(options: { deleteLocalData?: boolean } = {}): Promise<DeleteSystemResult> {
    return this.run(async () => {
      const partition = this.partition('system');
      let deletedLocalFiles = 0;

      if (options.deleteLocalData) {
        const loaded = await this.store.load(partition.localManifestPath, partition.id);
        for (const key of loaded.index.keys.values()) {
          try {
            const filePath = localPathForKey(this.roots, key);
            if (await statOrNull(filePath)) {
              await removeIfExists(filePath);
              deletedLocalFiles++;
              const { root } = splitKeySafe(key);
              await pruneEmptyParents(filePath, this.roots[root]);
            }
          } catch (error) {
            this.logger.warn(`Could not delete local system file ${key}: ${errorMessage(error)}`);
          }
        }
      }

      const deletedArchiveFiles = await countFiles(partition.archiveDir);
      await removeDir(partition.archiveDir);
      await removeIfExists(partition.localManifestPath);
      this.store.invalidate(manifestPath(partition.archiveDir));
      this.store.invalidate(partition.localManifestPath);
      this.logger.info(
        `Deleted system data partition (${deletedArchiveFiles} archived files, ${deletedLocalFiles} local files).`,
      );

      return { deletedArchiveFiles, deletedLocalFiles };
    });
  }
}

/**
 * The profile archive and the system partition must be disjoint. Otherwise a
 * profile folder could be mistaken for the system partition (or vice versa),
 * and deleting one could remove the other.
 */
function assertSeparatePartitions(archiveRoot: string, systemRoot: string): void {
  const archive = normalizedPath(archiveRoot);
  const system = normalizedPath(systemRoot);
  if (isSameOrInside(archive, system) || isSameOrInside(system, archive)) {
    throw new Error(
      `The system partition (${systemRoot}) must be a separate folder from the profile archive (${archiveRoot}).`,
    );
  }
}

function normalizedPath(input: string): string {
  const resolved = path.resolve(input);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isSameOrInside(candidate: string, parent: string): boolean {
  if (candidate === parent) {
    return true;
  }
  const prefix = parent.endsWith(path.sep) ? parent : `${parent}${path.sep}`;
  return candidate.startsWith(prefix);
}

async function forEachConcurrent<T>(
  items: T[],
  limit: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = next++;
      if (index >= items.length) {
        return;
      }
      await work(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
}

async function scanChangedPaths(
  scans: Map<string, string>,
  baseEntries: Map<string, FileEntry>,
  logger: Logger,
): Promise<FileIndex> {
  const files: FileIndex = new Map();
  const queue = [...scans];
  let next = 0;

  const worker = async (): Promise<void> => {
    while (next < queue.length) {
      const item = queue[next++];
      const [absolute, key] = item;
      const result = await scanPath(absolute, key, baseEntries, logger);
      for (const [lower, file] of result) {
        files.set(lower, file);
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(4, queue.length) }, () => worker()),
  );
  return files;
}

function hasKeysAtOrUnder(keys: Map<string, string>, lowerPrefix: string): boolean {
  if (keys.has(lowerPrefix)) {
    return true;
  }
  const prefix = `${lowerPrefix}/`;
  for (const key of keys.keys()) {
    if (key.startsWith(prefix)) {
      return true;
    }
  }
  return false;
}

function addKeysAtOrUnder(keys: Map<string, string>, lowerPrefix: string, target: Set<string>): void {
  const prefix = `${lowerPrefix}/`;
  for (const key of keys.keys()) {
    if (key === lowerPrefix || key.startsWith(prefix)) {
      target.add(key);
    }
  }
}

function emptyResult(firstSync = false): SyncResult {
  return {
    uploaded: 0,
    downloaded: 0,
    conflicts: 0,
    deferred: 0,
    stashed: 0,
    errors: 0,
    firstSync,
  };
}

function hasChanges(result: SyncResult): boolean {
  return (
    result.uploaded > 0 ||
    result.downloaded > 0 ||
    result.conflicts > 0 ||
    result.deferred > 0 ||
    result.errors > 0 ||
    result.stashed > 0
  );
}

function converge(lower: string, l: ScannedFile, r: ScannedFile, local: Side, remote: Side): void {
  local.base.set(lower, l.entry);
  local.keys.set(lower, l.key);
  remote.base.set(lower, r.entry);
  remote.keys.set(lower, r.key);
}

function drop(lower: string, local: Side, remote: Side): void {
  local.base.delete(lower);
  local.keys.delete(lower);
  remote.base.delete(lower);
  remote.keys.delete(lower);
}

function conflictStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function sumSizes(files: FileIndex): number {
  let total = 0;
  for (const file of files.values()) {
    total += file.entry.size;
  }
  return total;
}

function sumEntries(entries: Map<string, FileEntry>): number {
  let total = 0;
  for (const entry of entries.values()) {
    total += entry.size;
  }
  return total;
}

async function countFiles(dir: string): Promise<number> {
  let count = 0;
  const root = path.resolve(dir);
  const walk = async (current: string): Promise<void> => {
    let entries;
    try {
      entries = await readDir(current);
    } catch {
      return;
    }
    const atRoot = path.resolve(current) === root;
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (atRoot && entry.name === CONFLICTS_DIR) {
          continue;
        }
        await walk(path.join(current, entry.name));
      } else if (entry.isFile()) {
        // The manifest describes the profile; it is not save data.
        if (atRoot && entry.name === 'manifest.json') {
          continue;
        }
        count++;
      }
    }
  };
  await walk(dir);
  return count;
}

function splitKeySafe(key: string): { root: 'R' | 'LL' | 'PD' } {
  const root = key.split('/')[0];
  if (root !== 'R' && root !== 'LL' && root !== 'PD') {
    throw new Error(`Invalid save data key: ${key}`);
  }
  return { root };
}

/** Re-exported so callers do not need to reach into scan.ts. */
export type { FileIndex };
