/** Shared types for the FPDT sync engine. */

export const ROOT_KEYS = ['R', 'LL', 'PD'] as const;
export type RootKey = (typeof ROOT_KEYS)[number];

/**
 * A non-portable save data location, relative to one of the Windows user data
 * folders. `relative` always uses forward slashes.
 */
export interface SaveTarget {
  root: RootKey;
  relative: string;
}

export interface FileEntry {
  /** SHA-256 of the file contents. */
  hash: string;
  size: number;
  mtimeMs: number;
}

export interface ScannedFile {
  /** Archive/local key, e.g. `R/Macromedia/Flash Player/#SharedObjects/...`. */
  key: string;
  absPath: string;
  entry: FileEntry;
}

/** Manifest files are stored as JSON next to the data they describe. */
export interface ManifestData {
  version: number;
  profile: string;
  updatedAt: string;
  files: Record<string, FileEntry>;
}

export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export type ConflictPolicy = 'newest' | 'remote' | 'local';

export type SyncMode = 'full' | 'backup';

export interface SyncEngineOptions {
  /** Folder that contains one sub-folder per profile (`.../Data/Extensions/FPDT/profiles`). */
  archiveRoot: string;
  /**
   * Folder for system-level data (`.../Data/Extensions/FPDT/.global`).
   * It is deliberately outside `archiveRoot` and uses a dot-prefixed name that
   * no profile name can produce, so a Windows account called "system" cannot
   * collide with it.
   */
  systemRoot: string;
  /** Local, non-portable state directory (`%LOCALAPPDATA%/FPDT`). */
  stateDir: string;
  /** Absolute paths of the `R`, `LL` and `PD` roots for this machine. */
  roots: Record<RootKey, string>;
  profile: string;
  conflictPolicy: ConflictPolicy;
  safetyBackups: boolean;
  logger: Logger;
  /** Override the target list (used by tests). */
  targets?: readonly SaveTarget[];
}

export interface SyncResult {
  uploaded: number;
  downloaded: number;
  conflicts: number;
  deferred: number;
  stashed: number;
  errors: number;
  firstSync: boolean;
}

export interface SyncAllResult {
  profile: SyncResult;
  system: SyncResult;
}

export interface ProfileSummary {
  name: string;
  active: boolean;
  fileCount: number;
  bytes: number;
  lastSync: string | null;
}

export interface PartitionStatus {
  archiveDir: string;
  localStatePath: string;
  localFileCount: number;
  localBytes: number;
  archiveFileCount: number;
  archiveBytes: number;
  lastSync: string | null;
}

export interface SyncStatus {
  profile: string;
  archiveRoot: string;
  profileDir: string;
  localStatePath: string;
  roots: Record<RootKey, string>;
  localFileCount: number;
  localBytes: number;
  remoteFileCount: number;
  remoteBytes: number;
  lastLocalSync: string | null;
  lastRemoteSync: string | null;
  profiles: ProfileSummary[];
  /** ProgramData partition, shared by every Windows account on this machine. */
  system: PartitionStatus;
}

export interface CopyProfileResult {
  from: string;
  to: string;
  copiedFiles: number;
}

export interface DeleteProfileResult {
  profile: string;
  deletedArchiveFiles: number;
  deletedLocalFiles: number;
}

export interface DeleteSystemResult {
  deletedArchiveFiles: number;
  deletedLocalFiles: number;
}
