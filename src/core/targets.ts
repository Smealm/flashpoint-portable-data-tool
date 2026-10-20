import * as os from 'os';
import * as path from 'path';
import { RootKey, SaveTarget } from './types';

/**
 * Save data locations from https://flashpointarchive.org/datahub/Save_Data_Locations
 *
 * The original docs use %APPDATA%, %APPDATA%\..\LocalLow and %PROGRAMDATA%.
 * They are expressed here as three roots so that the archive can mirror the
 * Windows user data folders without ever writing `..` into a path.
 *
 * R  = %APPDATA%                  (Roaming)
 * LL = %USERPROFILE%\AppData\LocalLow
 * PD = %PROGRAMDATA%
 */
export const SAVE_TARGETS: readonly SaveTarget[] = [
  // Flash
  { root: 'R', relative: 'Macromedia/Flash Player/#SharedObjects' },
  // Unity Web Player
  { root: 'R', relative: 'Unity/WebPlayerPrefs' },
  // Silverlight
  { root: 'LL', relative: 'Microsoft/Silverlight' },
  // Shockwave / Director
  { root: 'R', relative: 'Macromedia/Director MX 2004/SPR/Prefs' },
  { root: 'LL', relative: 'Adobe/Director 11/Projector/Prefs' },
  { root: 'LL', relative: 'Adobe/Director 11/SPR/Prefs' },
  { root: 'PD', relative: 'Adobe/Director 11/Projector/Prefs' },
  { root: 'PD', relative: 'Adobe/Director 11/SPR/Prefs' },
  { root: 'LL', relative: 'Adobe/Director 12/Projector/Prefs' },
  { root: 'LL', relative: 'Adobe/Director 12/SPR/Prefs' },
  { root: 'PD', relative: 'Adobe/Director 12/Projector/Prefs' },
  { root: 'PD', relative: 'Adobe/Director 12/SPR/Prefs' },
];

export const ROOT_LABELS: Record<RootKey, string> = {
  R: '%APPDATA%',
  LL: '%USERPROFILE%\\AppData\\LocalLow',
  PD: '%PROGRAMDATA%',
};

export type EnvLike = Record<string, string | undefined>;

/** Resolve the three roots for the current machine. */
export function getDefaultRoots(env: EnvLike = process.env, home: string = os.homedir()): Record<RootKey, string> {
  const userProfile = env.USERPROFILE || home;
  return {
    R: env.APPDATA || path.join(userProfile, 'AppData', 'Roaming'),
    LL: path.join(userProfile, 'AppData', 'LocalLow'),
    PD: env.PROGRAMDATA || path.join(env.SystemDrive || 'C:', 'ProgramData'),
  };
}

/** `%LOCALAPPDATA%/FPDT`, where manifests and local conflict copies live. */
export function getDefaultStateRoot(env: EnvLike = process.env, home: string = os.homedir()): string {
  return path.join(env.LOCALAPPDATA || path.join(env.USERPROFILE || home, 'AppData', 'Local'), 'FPDT');
}

export function keyForTarget(target: SaveTarget): string {
  return `${target.root}/${target.relative.replace(/\\/g, '/')}`;
}

/**
 * Map an absolute path reported by the filesystem watcher back to its target.
 * Returns null for paths outside every configured save-data target.
 */
export function matchLocalPath(
  roots: Record<RootKey, string>,
  targets: readonly SaveTarget[],
  absolutePath: string,
): { key: string; target: SaveTarget } | null {
  const absolute = path.resolve(absolutePath);
  let best: { key: string; target: SaveTarget; length: number } | null = null;

  for (const target of targets) {
    const targetKey = keyForTarget(target);
    const targetPath = localPathForKey(roots, targetKey);
    const relative = path.relative(targetPath, absolute);
    if (relative === '') {
      if (!best || targetPath.length > best.length) {
        best = { key: targetKey, target, length: targetPath.length };
      }
      continue;
    }
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      continue;
    }
    if (!best || targetPath.length > best.length) {
      best = {
        key: `${targetKey}/${relative.split(path.sep).join('/')}`,
        target,
        length: targetPath.length,
      };
    }
  }

  return best ? { key: best.key, target: best.target } : null;
}

/** Absolute local path of a key. Keys are validated before they reach this. */
export function localPathForKey(roots: Record<RootKey, string>, key: string): string {
  const parts = splitKey(key);
  return path.join(roots[parts.root], ...parts.rest);
}

/** Absolute archive path of a key inside one profile folder. */
export function archivePathForKey(profileDir: string, key: string): string {
  return path.join(profileDir, ...splitKey(key).segments);
}

export function splitKey(key: string): { root: RootKey; rest: string[]; segments: string[] } {
  const segments = key.split('/');
  const root = segments[0];
  if (root !== 'R' && root !== 'LL' && root !== 'PD') {
    throw new Error(`Invalid save data key: ${key}`);
  }
  if (segments.length < 2 || segments.some(part => part.length === 0)) {
    throw new Error(`Invalid save data key: ${key}`);
  }
  for (const part of segments) {
    if (part === '.' || part === '..' || /[<>:"|?*\u0000-\u001f]/.test(part)) {
      throw new Error(`Invalid save data key: ${key}`);
    }
  }
  return { root, rest: segments.slice(1), segments };
}

const INVALID_PROFILE_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g;

/**
 * Profile names become folder names. Windows does not allow the characters
 * above, and trailing dots/spaces are silently stripped by Windows, which
 * would make the profile unfindable.
 */
export function sanitizeProfileName(name: string): string {
  const cleaned = name
    .replace(INVALID_PROFILE_CHARS, '_')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 64);
  return cleaned.length > 0 ? cleaned : 'default';
}

export function assertProfileName(name: string): string {
  const cleaned = sanitizeProfileName(name);
  if (cleaned !== name) {
    throw new Error(
      `Invalid profile name "${name}". Use letters, numbers, spaces, dots, dashes or underscores (max 64 characters).`,
    );
  }
  return cleaned;
}

export function currentWindowsProfile(env: EnvLike = process.env): string {
  return sanitizeProfileName(env.USERNAME || os.userInfo().username);
}

export function isWindows(): boolean {
  return process.platform === 'win32';
}
