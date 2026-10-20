import { randomBytes } from 'crypto';
import { statSync } from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  copyFilePreserve,
  ensureDir,
  errorMessage,
  hashFile,
  nativePath,
  removeIfExists,
  statOrNull,
} from './io';
import { FileEntryView, loadManifest, saveManifest } from './manifest';
import { FileIndex, indexManifestFiles, scanPath } from './scan';
import { FileEntry, Logger } from './types';

/**
 * Cloud sync is deliberately scoped to a fixed set of paths inside the
 * Flashpoint folder. Keys are forward-slash paths relative to that folder, for
 * both the local tree and the Google Drive app data folder. Nothing outside
 * the listed paths is scanned, uploaded, downloaded, stashed or deleted.
 */
export const CLOUD_SCOPE: readonly (readonly string[])[] = [
  ['Data/Playlists'],
  ['Data/Themes'],
  ['Data/Extensions/FPDT/profiles'],
  ['Data/Extensions/FPDT/.global'],
  ['FPSoftware/fpnavigator-portable/User/flashpointnavigator/Profiles/Default/webappsstore.sqlite'],
  // The portable Shockwave prefs folder is normally at the Flashpoint root.
  // Older layouts nest the whole portable folder under a "Flashpoint" folder,
  // so the first existing candidate wins.
  ['FPSoftware/Shockwave/PJ851/Prefs', 'Flashpoint/FPSoftware/Shockwave/PJ851/Prefs'],
  ['FPSoftware/Shockwave/PJ9/Prefs', 'Flashpoint/FPSoftware/Shockwave/PJ9/Prefs'],
];

/** Name used inside the Drive app data folder. */
export const CLOUD_FOLDER_NAME = 'FPDT Cloud';
/** Manifest file inside the Drive app data folder. */
export const CLOUD_MANIFEST_NAME = 'fpdt-cloud-manifest.json';
export const CLOUD_MANIFEST_VERSION = 1;
/** The portable, Flashpoint-side manifest for cloud sync. */
export const CLOUD_PROFILE = 'cloud';
export const CLOUD_MANIFEST_FILE = 'cloud.json';
export const CLOUD_CONFLICTS_DIR = '.cloud-conflicts';

const SYNC_CONCURRENCY = 4;
const HASH_CONCURRENCY = 4;

export interface CloudRemoteFile {
  key: string;
  fileId: string;
  /** MD5 reported by Drive. Used to trust the stored SHA-256 without downloading. */
  md5: string;
  size: number;
  modifiedTime: string;
}

export interface CloudManifestEntry {
  fileId: string;
  hash: string;
  md5: string;
  size: number;
  mtimeMs: number;
}

export interface CloudManifestData {
  version: number;
  updatedAt: string;
  files: Record<string, CloudManifestEntry>;
}

/**
 * The only interface the sync engine uses to talk to the cloud. It is
 * implemented by the Google Drive transport and by test transports.
 */
export interface CloudTransport {
  list(): Promise<CloudRemoteFile[]>;
  download(file: CloudRemoteFile, destination: string): Promise<void>;
  upload(key: string, source: string, fileId?: string): Promise<{ fileId: string; md5: string }>;
  remove(fileId: string): Promise<void>;
  readManifest(): Promise<CloudManifestData | null>;
  writeManifest(data: CloudManifestData): Promise<void>;
  isConnected(): Promise<boolean>;
}

export type CloudSyncDirection = 'both' | 'pull';

export interface CloudSyncRequest {
  /** `pull` only applies cloud changes to the Flashpoint folder (used before launch). */
  direction?: CloudSyncDirection;
}

export interface CloudSyncResult {
  uploaded: number;
  downloaded: number;
  conflicts: number;
  stashed: number;
  errors: number;
  checked: number;
  firstSync: boolean;
}

export interface CloudStatus {
  /** True when a transport (client ID + secret) is configured. */
  configured: boolean;
  connected: boolean;
  root: string;
  manifestPath: string;
  scope: string[];
  /** Tracked Flashpoint-side counts from the last cloud sync. */
  flashpointFileCount: number;
  flashpointBytes: number;
  lastSync: string | null;
  /** Counts from the cloud manifest at the last sync, or a live read for status. */
  cloudFileCount: number;
  cloudBytes: number;
  cloudUpdatedAt: string | null;
  error: string | null;
}

export interface CloudSyncOptions {
  safetyBackups: boolean;
  logger: Logger;
  /** Folder the portable Flashpoint collection lives in. */
  root: string;
  /** `<extension>/cloud.json`; the Flashpoint-side record of the last cloud agreement. */
  manifestPath: string;
  /** Local scratch folder for upload snapshots (`%LOCALAPPDATA%/FPDT`). */
  stateDir: string;
  transport: CloudTransport | null;
  scope?: readonly (readonly string[])[];
}

export interface CloudController {
  status(): Promise<CloudStatus>;
  sync(): Promise<CloudSyncResult>;
  login(): Promise<void>;
  logout(): Promise<void>;
  readonly configured: boolean;
}

interface SideFile {
  key: string;
  entry: FileEntry;
  absPath?: string;
  fileId?: string;
  md5?: string;
}

interface CloudBaseEntry extends FileEntry {
  fileId?: string;
  md5?: string;
}

interface Side {
  files: Map<string, SideFile>;
  base: Map<string, CloudBaseEntry>;
  keys: Map<string, string>;
}

interface SnapshottedFile {
  path: string;
  entry: FileEntry;
}

let snapshotCounter = 0;

export class CloudEngine {
  private readonly logger: Logger;
  private readonly root: string;
  private readonly manifestPath: string;
  private readonly stateDir: string;
  private readonly scopeGroups: readonly (readonly string[])[];
  private transport: CloudTransport | null;
  private safetyBackups: boolean;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: CloudSyncOptions) {
    this.logger = options.logger;
    this.root = path.resolve(options.root);
    this.manifestPath = path.resolve(options.manifestPath);
    this.stateDir = path.resolve(options.stateDir);
    this.transport = options.transport;
    this.safetyBackups = options.safetyBackups;
    this.scopeGroups = options.scope ?? CLOUD_SCOPE;
  }

  get configured(): boolean {
    return this.transport !== null;
  }

  setTransport(transport: CloudTransport | null): void {
    this.transport = transport;
  }

  setSafetyBackups(enabled: boolean): void {
    this.safetyBackups = enabled;
  }

  /** Resolve every configured scope entry to a path relative to the Flashpoint root. */
  resolveScope(): string[] {
    const resolved: string[] = [];
    for (const group of this.scopeGroups) {
      resolved.push(selectScopeCandidate(this.root, group));
    }
    return resolved;
  }

  async status(): Promise<CloudStatus> {
    let loaded: Awaited<ReturnType<typeof loadManifest>> = { data: null, corrupt: false };
    let error: string | null = null;
    try {
      loaded = await loadManifest(this.manifestPath, CLOUD_PROFILE, this.logger);
    } catch (caught) {
      error = `Could not read ${this.manifestPath}: ${errorMessage(caught)}`;
    }
    let flashpointFileCount = 0;
    let flashpointBytes = 0;
    for (const entry of Object.values(loaded.data?.files ?? {})) {
      flashpointFileCount++;
      flashpointBytes += entry.size;
    }

    let connected = false;
    let cloudFileCount = 0;
    let cloudBytes = 0;
    let cloudUpdatedAt: string | null = null;
    if (this.transport) {
      try {
        connected = await this.transport.isConnected();
        if (connected) {
          const cloudManifest = await this.transport.readManifest();
          for (const entry of Object.values(cloudManifest?.files ?? {})) {
            cloudFileCount++;
            cloudBytes += entry.size;
          }
          cloudUpdatedAt = cloudManifest?.updatedAt || null;
        }
      } catch (caught) {
        error = error ? `${error}; ${errorMessage(caught)}` : errorMessage(caught);
      }
    }

    return {
      configured: this.configured,
      connected,
      root: this.root,
      manifestPath: this.manifestPath,
      scope: this.resolveScope(),
      flashpointFileCount,
      flashpointBytes,
      lastSync: loaded.data?.updatedAt || null,
      cloudFileCount,
      cloudBytes,
      cloudUpdatedAt,
      error,
    };
  }

  /**
   * Three-way sync between the Flashpoint portable folder and the cloud copy.
   *
   * The direction that matters is cloud -> Flashpoint: cloud data is written
   * into the portable folder, never directly into the Windows save folders.
   * The ordinary FPDT sync then moves it from the portable folder into Windows
   * on its next full pass. This keeps the two syncs independent and prevents
   * either one from pulling a file out from under the other.
   */
  sync(request: CloudSyncRequest = {}): Promise<CloudSyncResult> {
    const direction = request.direction ?? 'both';
    const next = this.queue.then(
      () => this.syncNow(direction),
      () => this.syncNow(direction),
    );
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async syncNow(direction: CloudSyncDirection): Promise<CloudSyncResult> {
    const pullOnly = direction === 'pull';
    const transport = this.transport;
    if (!transport) {
      throw new Error('Cloud sync is not configured. Set the Google Drive client ID and client secret first.');
    }

    const result = emptyResult();
    const flashpointLoaded = await loadManifest(this.manifestPath, CLOUD_PROFILE, this.logger);
    const cloudManifest = normalizeCloudManifest(await transport.readManifest());
    result.firstSync = flashpointLoaded.data === null || cloudManifest === null;

    const flashpointIndex = indexManifestFiles(flashpointLoaded.data?.files);
    const cloudIndex = indexManifestFiles(cloudManifest?.files);
    const scope = this.resolveScope();

    const remoteList = await transport.list();
    const remoteByKey = new Map<string, CloudRemoteFile>();
    const duplicates: CloudRemoteFile[] = [];
    for (const remote of remoteList) {
      if (isExcludedCloudKey(remote.key)) {
        continue;
      }
      if (!scope.some(entry => isInScope(remote.key, entry))) {
        // Never restore a cloud path that this installation does not include
        // in its scope. This keeps a differently-laid-out collection, or a
        // stray file in the app data folder, from creating new paths locally.
        this.logger.debug(`Ignoring out-of-scope cloud file ${remote.key}`);
        continue;
      }
      try {
        // Reject anything that would resolve outside the Flashpoint folder
        // before a download or conflict copy can use the key.
        resolveCloudKey(this.root, remote.key);
      } catch (error) {
        this.logger.warn(`Ignoring an unsafe cloud file name: ${errorMessage(error)}`);
        continue;
      }
      const lower = remote.key.toLowerCase();
      const existing = remoteByKey.get(lower);
      if (existing) {
        // A retried upload can leave a duplicate. Keep the newest copy.
        if (remoteTime(remote) > remoteTime(existing)) {
          duplicates.push(existing);
          remoteByKey.set(lower, remote);
        } else {
          duplicates.push(remote);
        }
        continue;
      }
      remoteByKey.set(lower, remote);
    }
    if (!pullOnly) {
      for (const duplicate of duplicates) {
        try {
          await transport.remove(duplicate.fileId);
          this.logger.debug(`Removed duplicate cloud copy of ${duplicate.key}`);
        } catch (error) {
          this.logger.warn(`Could not remove duplicate cloud copy of ${duplicate.key}: ${errorMessage(error)}`);
        }
      }
    }

    const [localFiles, cloudScan] = await Promise.all([
      scanFlashpoint(this.root, scope, flashpointIndex.entries, this.logger),
      scanCloud(transport, remoteByKey, cloudIndex.entries, this.logger),
    ]);
    // A cloud file that could not be read must not be treated as missing: that
    // would upload a stale local copy over data that is still in the cloud.
    const unreachableCloudKeys = cloudScan.failed;

    const local: Side = { files: localFiles, base: flashpointIndex.entries, keys: flashpointIndex.keys };
    const cloud: Side = {
      files: cloudScan.files,
      base: new Map(cloudIndex.entries) as Map<string, CloudBaseEntry>,
      keys: cloudIndex.keys,
    };

    // "No manifest yet" means this Flashpoint collection has never synced, or
    // the cloud manifest was lost. A backup that already exists must still be
    // applied, so the cloud copy is overlaid before normal matching resumes.
    if (result.firstSync && cloud.files.size > 0) {
      const failed = await this.overlayCloud(cloud, local, result);
      if (failed.size > 0) {
        for (const key of failed) {
          unreachableCloudKeys.add(key);
        }
      }
      for (const [lower, file] of cloud.files) {
        if (failed.has(lower)) {
          continue;
        }
        local.base.set(lower, file.entry);
        local.keys.set(lower, file.key);
        cloud.base.set(lower, cloudBaseEntry(file));
        cloud.keys.set(lower, file.key);
      }
    }

    const allKeys = new Set<string>([
      ...local.files.keys(),
      ...cloud.files.keys(),
      ...local.base.keys(),
      ...cloud.base.keys(),
    ]);

    await forEachConcurrent([...allKeys], SYNC_CONCURRENCY, async lower => {
      if (unreachableCloudKeys.has(lower)) {
        return;
      }
      try {
        await this.syncKey(lower, local, cloud, transport, result, pullOnly);
      } catch (error) {
        result.errors++;
        this.logger.error(`Cloud sync failed for ${lower}: ${errorMessage(error)}`);
      }
    });
    result.checked = allKeys.size;

    if (hasChanges(result) || result.firstSync) {
      await ensureDir(path.dirname(this.manifestPath));
      await saveManifest(this.manifestPath, CLOUD_PROFILE, viewsOf(local.base, local.keys));
    }
    if (
      !pullOnly &&
      (
        result.firstSync ||
        result.uploaded > 0 ||
        result.downloaded > 0 ||
        result.conflicts > 0 ||
        result.stashed > 0
      )
    ) {
      await transport.writeManifest(buildCloudManifest(cloud.base, cloud.keys));
    }

    const summary = `Cloud ${pullOnly ? 'pull' : 'sync'}: ${result.uploaded} uploaded, ` +
      `${result.downloaded} downloaded, ${result.conflicts} conflicts, ${result.errors} errors`;
    if (hasChanges(result) || result.firstSync) {
      this.logger.info(summary);
    } else {
      this.logger.debug(summary);
    }
    return result;
  }

  private async syncKey(
    lower: string,
    local: Side,
    cloud: Side,
    transport: CloudTransport,
    result: CloudSyncResult,
    pullOnly: boolean,
  ): Promise<void> {
    const l = local.files.get(lower);
    const c = cloud.files.get(lower);

    if (!l && !c) {
      drop(lower, local, cloud);
      return;
    }

    if (l && c && l.entry.hash === c.entry.hash) {
      converge(lower, l, c, local, cloud);
      return;
    }

    if (!c) {
      if (!l) {
        drop(lower, local, cloud);
      } else if (!pullOnly) {
        // The cloud copy disappeared. It is restored, never treated as a
        // delete request, matching the local <-> Flashpoint rules.
        await this.upload(lower, l, transport, local, cloud, result, undefined);
      }
      return;
    }

    if (!l) {
      // Missing in the portable folder: restore it from the cloud.
      await this.download(lower, c, transport, local, cloud, result);
      return;
    }

    const localChanged = l.entry.hash !== local.base.get(lower)?.hash;
    const cloudChanged = c.entry.hash !== cloud.base.get(lower)?.hash;

    if (cloudChanged && !localChanged) {
      await this.download(lower, c, transport, local, cloud, result);
    } else if (localChanged && !cloudChanged) {
      if (!pullOnly) {
        await this.upload(lower, l, transport, local, cloud, result, c.fileId);
      }
    } else {
      await this.resolveConflict(lower, l, c, transport, local, cloud, result, pullOnly);
    }
  }

  private async resolveConflict(
    lower: string,
    l: SideFile,
    c: SideFile,
    transport: CloudTransport,
    local: Side,
    cloud: Side,
    result: CloudSyncResult,
    pullOnly: boolean,
  ): Promise<void> {
    result.conflicts++;
    // Ties go to the cloud so a deterministic winner always exists.
    const cloudWins = c.entry.mtimeMs >= l.entry.mtimeMs;
    this.logger.warn(
      `Cloud conflict on ${l.key}: ${cloudWins ? 'cloud' : 'Flashpoint'} wins ` +
      `(Flashpoint ${new Date(l.entry.mtimeMs).toISOString()}, cloud ${new Date(c.entry.mtimeMs).toISOString()}).`,
    );

    if (cloudWins) {
      await this.stashFlashpoint(l, result);
      await this.download(lower, c, transport, local, cloud, result);
    } else if (!pullOnly) {
      await this.stashCloud(c, transport, result);
      await this.upload(lower, l, transport, local, cloud, result, c.fileId);
    }
  }

  private async upload(
    lower: string,
    l: SideFile,
    transport: CloudTransport,
    local: Side,
    cloud: Side,
    result: CloudSyncResult,
    existingId: string | undefined,
  ): Promise<void> {
    if (!l.absPath) {
      throw new Error(`No local file for ${l.key}`);
    }
    const snapshot = await snapshotFile(l.absPath, this.stateDir);
    try {
      const uploaded = await transport.upload(l.key, snapshot.path, existingId);
      const remote: SideFile = {
        key: l.key,
        entry: snapshot.entry,
        fileId: uploaded.fileId,
        md5: uploaded.md5,
      };
      cloud.files.set(lower, remote);
      cloud.base.set(lower, cloudBaseEntry(remote));
      cloud.keys.set(lower, l.key);
      local.base.set(lower, snapshot.entry);
      local.keys.set(lower, l.key);
      result.uploaded++;
    } finally {
      await removeIfExists(snapshot.path);
    }
  }

  private async download(
    lower: string,
    c: SideFile,
    transport: CloudTransport,
    local: Side,
    cloud: Side,
    result: CloudSyncResult,
  ): Promise<void> {
    if (!c.fileId) {
      throw new Error(`Cloud entry for ${c.key} has no file id`);
    }
    const destination = resolveCloudKey(this.root, c.key);
    await transport.download(
      {
        key: c.key,
        fileId: c.fileId,
        md5: c.md5 ?? '',
        size: c.entry.size,
        modifiedTime: new Date(c.entry.mtimeMs).toISOString(),
      },
      destination,
    );
    await setMtime(destination, c.entry.mtimeMs);
    local.files.set(lower, { key: c.key, absPath: destination, entry: c.entry });
    local.base.set(lower, c.entry);
    local.keys.set(lower, c.key);
    cloud.base.set(lower, cloudBaseEntry(c));
    cloud.keys.set(lower, c.key);
    result.downloaded++;
  }

  /** First-sync overlay: every cloud copy is written over the Flashpoint copy. */
  private async overlayCloud(cloud: Side, local: Side, result: CloudSyncResult): Promise<Set<string>> {
    const failed = new Set<string>();
    await forEachConcurrent([...cloud.files.entries()], SYNC_CONCURRENCY, async ([lower, c]) => {
      const existing = local.files.get(lower);
      if (existing && existing.entry.hash === c.entry.hash) {
        return;
      }
      let stashed = false;
      try {
        if (existing) {
          stashed = await this.stashFlashpoint(existing, result);
        }
        const destination = resolveCloudKey(this.root, c.key);
        if (!c.fileId) {
          throw new Error(`Cloud entry for ${c.key} has no file id`);
        }
        await this.transport!.download(
          {
            key: c.key,
            fileId: c.fileId,
            md5: c.md5 ?? '',
            size: c.entry.size,
            modifiedTime: new Date(c.entry.mtimeMs).toISOString(),
          },
          destination,
        );
        await setMtime(destination, c.entry.mtimeMs);
        local.files.set(lower, { key: c.key, absPath: destination, entry: c.entry });
        result.downloaded++;
      } catch (error) {
        result.errors++;
        failed.add(lower);
        this.logger.error(`Cloud restore failed for ${c.key}: ${errorMessage(error)}`);
        if (existing && stashed) {
          // The old version is safe in .cloud-conflicts. Remove the stale copy
          // so the next pass retries the restore instead of uploading it.
          try {
            await removeIfExists(resolveCloudKey(this.root, existing.key));
            local.files.delete(lower);
          } catch (removeError) {
            this.logger.warn(`Could not remove stale file for ${c.key}: ${errorMessage(removeError)}`);
          }
        }
      }
    });
    return failed;
  }

  private async stashFlashpoint(file: SideFile, result: CloudSyncResult): Promise<boolean> {
    if (!this.safetyBackups) {
      return false;
    }
    if (!file.absPath) {
      return false;
    }
    const destination = path.join(
      path.dirname(this.manifestPath),
      CLOUD_CONFLICTS_DIR,
      conflictStamp(),
      'flashpoint',
      ...file.key.split('/'),
    );
    try {
      await copyFilePreserve(file.absPath, destination);
      result.stashed++;
      return true;
    } catch (error) {
      result.errors++;
      this.logger.warn(`Could not keep a Flashpoint-side cloud conflict copy of ${file.key}: ${errorMessage(error)}`);
      return false;
    }
  }

  private async stashCloud(file: SideFile, transport: CloudTransport, result: CloudSyncResult): Promise<boolean> {
    if (!this.safetyBackups || !file.fileId) {
      return false;
    }
    const destination = path.join(
      path.dirname(this.manifestPath),
      CLOUD_CONFLICTS_DIR,
      conflictStamp(),
      'cloud',
      ...file.key.split('/'),
    );
    try {
      await transport.download(
        {
          key: file.key,
          fileId: file.fileId,
          md5: file.md5 ?? '',
          size: file.entry.size,
          modifiedTime: new Date(file.entry.mtimeMs).toISOString(),
        },
        destination,
      );
      await setMtime(destination, file.entry.mtimeMs);
      result.stashed++;
      return true;
    } catch (error) {
      result.errors++;
      this.logger.warn(`Could not keep a cloud-side conflict copy of ${file.key}: ${errorMessage(error)}`);
      return false;
    }
  }
}

/** Keys that are FPDT bookkeeping, not portable data worth uploading. */
export function isExcludedCloudKey(key: string): boolean {
  const segments = key.toLowerCase().split('/');
  return (
    segments.includes('.conflicts') ||
    segments.includes('.cloud-conflicts') ||
    segments.includes('.cloud-tmp') ||
    key.toLowerCase() === `data/extensions/fpdt/${CLOUD_MANIFEST_FILE}`
  );
}

/** True when a key is exactly a scope path or lives below it. */
export function isInScope(key: string, scopePath: string): boolean {
  const lowerKey = key.toLowerCase();
  const lowerScope = scopePath.toLowerCase();
  return lowerKey === lowerScope || lowerKey.startsWith(`${lowerScope}/`);
}

/** Resolve a cloud key inside the Flashpoint root, rejecting traversal. */
export function resolveCloudKey(root: string, key: string): string {
  const segments = key.split('/');
  if (segments.length === 0 || segments.some(segment => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new Error(`Invalid cloud key: ${key}`);
  }
  for (const segment of segments) {
    if (/[<>:"|?*\u0000-\u001f]/.test(segment) || /^[A-Za-z]:$/.test(segment)) {
      throw new Error(`Invalid cloud key: ${key}`);
    }
  }
  const resolved = path.resolve(root, ...segments);
  const relative = path.relative(path.resolve(root), resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Cloud key escapes the Flashpoint folder: ${key}`);
  }
  return resolved;
}

function selectScopeCandidate(root: string, group: readonly string[]): string {
  // Prefer an existing layout, but keep the first candidate for paths that do
  // not exist yet so cloud files can create them on restore.
  for (const candidate of group) {
    try {
      if (statExistsSync(resolveCloudKey(root, candidate))) {
        return candidate;
      }
    } catch {
      // Invalid candidate in a custom scope; skip it.
    }
  }
  return group[0];
}

function statExistsSync(filePath: string): boolean {
  try {
    statSync(nativePath(filePath));
    return true;
  } catch {
    return false;
  }
}

async function scanFlashpoint(
  root: string,
  scope: string[],
  baseEntries: Map<string, FileEntry>,
  logger: Logger,
): Promise<Map<string, SideFile>> {
  const results = await Promise.all(
    scope.map(async relative => {
      const absolute = resolveCloudKey(root, relative);
      if (!(await statOrNull(absolute))) {
        return new Map() as FileIndex;
      }
      return scanPath(
        absolute,
        relative,
        baseEntries,
        logger,
        // Conflict history is FPDT bookkeeping and can be large; cloud sync
        // must not spend time hashing it only to filter it out afterwards.
        name => name.toLowerCase() === '.conflicts',
      );
    }),
  );
  const merged = new Map<string, SideFile>();
  for (const files of results) {
    for (const [lower, file] of files) {
      if (!isExcludedCloudKey(file.key)) {
        merged.set(lower, file);
      }
    }
  }
  return merged;
}

async function scanCloud(
  transport: CloudTransport,
  remoteByKey: Map<string, CloudRemoteFile>,
  baseEntries: Map<string, FileEntry>,
  logger: Logger,
): Promise<{ files: Map<string, SideFile>; failed: Set<string> }> {
  const files = new Map<string, SideFile>();
  const failed = new Set<string>();
  await forEachConcurrent([...remoteByKey.entries()], HASH_CONCURRENCY, async ([lower, remote]) => {
    const known = baseEntries.get(lower);
    if (known && known.size === remote.size && (known as CloudManifestEntry).md5 === remote.md5) {
      files.set(lower, { key: remote.key, absPath: '', entry: known, fileId: remote.fileId, md5: remote.md5 });
      return;
    }
    // The file is new or changed outside the sync. Hash its actual content so
    // the three-way comparison is based on bytes, not Drive metadata.
    const temp = path.join(os.tmpdir(), `fpdt-cloud-hash-${process.pid}-${snapshotCounter++}-${randomBytes(4).toString('hex')}`);
    try {
      await transport.download(remote, temp);
      const stat = await statOrNull(temp);
      const modified = Date.parse(remote.modifiedTime);
      const entry: FileEntry = {
        hash: await hashFile(temp),
        size: stat?.size ?? remote.size,
        // A cloud file whose bytes changed was written after the previous
        // agreement, so its Drive modification time is the right ordering key.
        mtimeMs: Number.isNaN(modified) ? (known?.mtimeMs ?? Date.now()) : modified,
      };
      files.set(lower, { key: remote.key, absPath: '', entry, fileId: remote.fileId, md5: remote.md5 });
    } catch (error) {
      failed.add(lower);
      logger.warn(`Could not read cloud file ${remote.key}: ${errorMessage(error)}`);
    } finally {
      await removeIfExists(temp);
    }
  });
  return { files, failed };
}

async function snapshotFile(source: string, stateDir: string): Promise<SnapshottedFile> {
  const scratch = path.join(stateDir, '.cloud-tmp');
  await ensureDir(scratch);
  const temp = path.join(scratch, `snap-${process.pid}-${snapshotCounter++}-${randomBytes(4).toString('hex')}`);
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = await fsp.stat(nativePath(source));
      await fsp.copyFile(nativePath(source), nativePath(temp));
      const after = await fsp.stat(nativePath(source));
      if (before.size === after.size && Math.abs(before.mtimeMs - after.mtimeMs) < 2) {
        return {
          path: temp,
          entry: { hash: await hashFile(temp), size: after.size, mtimeMs: after.mtimeMs },
        };
      }
      // The archive file was being written while it was read. Retry.
    }
    throw new Error('File kept changing while it was being prepared for upload.');
  } catch (error) {
    await removeIfExists(temp);
    throw error;
  }
}

async function setMtime(filePath: string, mtimeMs: number): Promise<void> {
  if (!Number.isFinite(mtimeMs) || mtimeMs <= 0) {
    return;
  }
  try {
    const date = new Date(mtimeMs);
    await fsp.utimes(nativePath(filePath), date, date);
  } catch {
    // Timestamps only affect conflict ordering; the content is already correct.
  }
}

function normalizeCloudManifest(raw: unknown): CloudManifestData | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const value = raw as Partial<CloudManifestData>;
  const files: Record<string, CloudManifestEntry> = {};
  for (const [key, entry] of Object.entries(value.files ?? {})) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const candidate = entry as Partial<CloudManifestEntry>;
    if (
      typeof candidate.fileId !== 'string' ||
      typeof candidate.hash !== 'string' ||
      typeof candidate.md5 !== 'string' ||
      typeof candidate.size !== 'number' ||
      typeof candidate.mtimeMs !== 'number'
    ) {
      continue;
    }
    files[key] = {
      fileId: candidate.fileId,
      hash: candidate.hash,
      md5: candidate.md5,
      size: candidate.size,
      mtimeMs: candidate.mtimeMs,
    };
  }
  return {
    version: typeof value.version === 'number' ? value.version : CLOUD_MANIFEST_VERSION,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : '',
    files,
  };
}

function buildCloudManifest(
  entries: Map<string, CloudBaseEntry>,
  keys: Map<string, string>,
): CloudManifestData {
  const files: Record<string, CloudManifestEntry> = {};
  const sorted = [...keys.keys()].sort();
  for (const lower of sorted) {
    const key = keys.get(lower);
    const entry = entries.get(lower);
    if (!key || !entry || !entry.fileId || !entry.md5) {
      continue;
    }
    files[key] = {
      fileId: entry.fileId,
      hash: entry.hash,
      md5: entry.md5,
      size: entry.size,
      mtimeMs: entry.mtimeMs,
    };
  }
  return {
    version: CLOUD_MANIFEST_VERSION,
    updatedAt: new Date().toISOString(),
    files,
  };
}

function viewsOf(entries: Map<string, FileEntry>, keys: Map<string, string>): Map<string, FileEntryView> {
  const views = new Map<string, FileEntryView>();
  for (const [lower, entry] of entries) {
    views.set(lower, { key: keys.get(lower) ?? lower, entry });
  }
  return views;
}

function converge(lower: string, l: SideFile, c: SideFile, local: Side, cloud: Side): void {
  local.base.set(lower, l.entry);
  local.keys.set(lower, l.key);
  cloud.base.set(lower, cloudBaseEntry(c));
  cloud.keys.set(lower, c.key);
}

function cloudBaseEntry(file: SideFile): CloudBaseEntry {
  return {
    hash: file.entry.hash,
    size: file.entry.size,
    mtimeMs: file.entry.mtimeMs,
    fileId: file.fileId,
    md5: file.md5,
  };
}

function drop(lower: string, local: Side, cloud: Side): void {
  local.base.delete(lower);
  local.keys.delete(lower);
  cloud.base.delete(lower);
  cloud.keys.delete(lower);
}

function emptyResult(firstSync = false): CloudSyncResult {
  return {
    uploaded: 0,
    downloaded: 0,
    conflicts: 0,
    stashed: 0,
    errors: 0,
    checked: 0,
    firstSync,
  };
}

function hasChanges(result: CloudSyncResult): boolean {
  return result.uploaded > 0 || result.downloaded > 0 || result.conflicts > 0 || result.stashed > 0 || result.errors > 0;
}

function conflictStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function remoteTime(file: CloudRemoteFile): number {
  const parsed = Date.parse(file.modifiedTime);
  return Number.isNaN(parsed) ? 0 : parsed;
}

async function forEachConcurrent<T>(items: T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
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
