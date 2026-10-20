import * as path from 'path';
import { FileEntry, Logger, ManifestData } from './types';
import { isFileEntry } from './scan';
import { isErrno, moveFile, readJson, writeJsonAtomic } from './io';

export const MANIFEST_VERSION = 1;

export interface ManifestLoadResult {
  data: ManifestData | null;
  /** True when a file existed but could not be parsed and was moved aside. */
  corrupt: boolean;
}

/**
 * Read a manifest. A missing manifest is normal (it triggers the "remote wins"
 * first-sync rule). A corrupt manifest is renamed so it is not silently lost,
 * and is treated as missing.
 */
export async function loadManifest(filePath: string, profile: string, logger: Logger): Promise<ManifestLoadResult> {
  let raw: unknown;
  try {
    raw = await readJson<unknown>(filePath);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) {
      return { data: null, corrupt: false };
    }
    if (error instanceof SyntaxError) {
      const backup = `${filePath}.corrupt-${Date.now()}.json`;
      logger.warn(`Manifest is not valid JSON. Moving it to ${path.basename(backup)}.`);
      try {
        await moveFile(filePath, backup);
      } catch {
        // Ignore: the manifest being unreadable already forces remote-wins.
      }
      return { data: null, corrupt: true };
    }
    // Permission or IO errors should not silently reset sync state.
    throw error;
  }

  const data = normalizeManifest(raw, profile, logger);
  return { data, corrupt: false };
}

function normalizeManifest(raw: unknown, profile: string, logger: Logger): ManifestData | null {
  if (typeof raw !== 'object' || raw === null) {
    logger.warn('Manifest is not an object. Treating it as missing.');
    return null;
  }
  const value = raw as Partial<ManifestData>;
  if (value.profile !== undefined && String(value.profile).toLowerCase() !== profile.toLowerCase()) {
    // A manifest for a different profile would compare unrelated files.
    return null;
  }
  // Validate the parsed table in place instead of rebuilding it. Copying every
  // entry allocated a second object per file, which was the second largest cost
  // of a load; the table is not aliased anywhere else, so mutating it is safe.
  let files: ManifestData['files'] = {};
  if (value.files && typeof value.files === 'object') {
    files = value.files as ManifestData['files'];
    for (const key in files) {
      if (!isFileEntry(files[key])) {
        logger.debug(`Dropping invalid manifest entry for ${key}`);
        delete files[key];
      }
    }
  }
  return {
    version: typeof value.version === 'number' ? value.version : MANIFEST_VERSION,
    profile,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : '',
    files,
  };
}

export interface FileEntryView {
  key: string;
  entry: FileEntry;
}

/** Write a manifest from the engine's synced-state maps. */
export async function saveManifest(
  filePath: string,
  profile: string,
  entries: Map<string, FileEntryView>,
): Promise<void> {
  const base = new Map<string, FileEntry>();
  const keys = new Map<string, string>();
  for (const [lower, view] of entries) {
    base.set(lower, view.entry);
    keys.set(lower, view.key);
  }
  await saveManifestState(filePath, profile, base, keys);
}

/**
 * Write a manifest from the case-insensitive index maps the engine keeps. Kept
 * separate from `saveManifest` so callers that already hold the two maps do not
 * have to build a third copy of every entry first.
 *
 * Returns the written data so a caller can cache it without re-reading.
 */
export async function saveManifestState(
  filePath: string,
  profile: string,
  entries: Map<string, FileEntry>,
  keys: Map<string, string>,
): Promise<ManifestData> {
  const files: ManifestData['files'] = {};
  const sorted = [...keys.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const lower of sorted) {
    const key = keys.get(lower);
    const entry = entries.get(lower);
    if (key && entry) {
      files[key] = entry;
    }
  }
  const data: ManifestData = {
    version: MANIFEST_VERSION,
    profile,
    updatedAt: new Date().toISOString(),
    files,
  };
  await writeJsonAtomic(filePath, data);
  return data;
}

export function manifestPath(profileDir: string): string {
  return path.join(profileDir, 'manifest.json');
}
