import { createHash } from 'crypto';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';

const WINDOWS = process.platform === 'win32';
/**
 * Below MAX_PATH there is no reason to use the extended namespace. At or above
 * it, `\\?\` removes the 260 character limit regardless of the LongPathsEnabled
 * policy (the archive can get deep because Flash creates nested folders).
 */
const LONG_PATH_THRESHOLD = 240;

/** Convert an absolute path to one the Windows API treats as long-path safe. */
export function nativePath(input: string): string {
  if (!WINDOWS || input.startsWith('\\\\?\\')) {
    return input;
  }
  if (!path.isAbsolute(input) || input.length < LONG_PATH_THRESHOLD) {
    return input;
  }
  const resolved = path.resolve(input);
  if (resolved.startsWith('\\\\')) {
    return `\\\\?\\UNC\\${resolved.slice(2)}`;
  }
  return `\\\\?\\${resolved}`;
}

export function toPosix(value: string): string {
  return value.replace(/\\/g, '/');
}

/**
 * Always use the extended namespace, even below MAX_PATH. Recursive APIs
 * (copy/rm) append child names to the path they are given, so prefixing the
 * root keeps deep descendants valid too.
 */
function extendedRootPath(input: string): string {
  if (!WINDOWS || input.startsWith('\\?\\')) {
    return input;
  }
  const resolved = path.resolve(input);
  if (resolved.startsWith('\\\\')) {
    return `\\\\?\\UNC\\${resolved.slice(2)}`;
  }
  return `\\\\?\\${resolved}`;
}

export async function statOrNull(filePath: string): Promise<fs.Stats | null> {
  try {
    return await fsp.stat(nativePath(filePath));
  } catch (error) {
    if (isErrno(error, 'ENOENT') || isErrno(error, 'ENOTDIR')) {
      return null;
    }
    throw error;
  }
}

export async function exists(filePath: string): Promise<boolean> {
  return (await statOrNull(filePath)) !== null;
}

export async function readDir(filePath: string): Promise<fs.Dirent[]> {
  return fsp.readdir(nativePath(filePath), { withFileTypes: true });
}

export async function listDirNames(filePath: string): Promise<string[]> {
  try {
    const entries = await readDir(filePath);
    return entries.filter(entry => entry.isDirectory() || entry.isSymbolicLink()).map(entry => entry.name);
  } catch (error) {
    if (isErrno(error, 'ENOENT') || isErrno(error, 'ENOTDIR')) {
      return [];
    }
    throw error;
  }
}

export async function ensureDir(dirPath: string): Promise<void> {
  await fsp.mkdir(nativePath(dirPath), { recursive: true });
}

/**
 * Only call mkdir when the parent is actually missing. Creating a directory
 * that already exists can still perform a permission check on Windows, and
 * ProgramData app folders are often writable while a recursive mkdir on the
 * same path is not guaranteed to be. File writes themselves are unchanged.
 */
async function ensureParentDir(filePath: string): Promise<void> {
  const parent = path.dirname(filePath);
  const stat = await statOrNull(parent);
  if (stat?.isDirectory()) {
    return;
  }
  await ensureDir(parent);
}

/** Copy a file and preserve its modification time, which sync uses for conflicts. */
export async function copyFilePreserve(source: string, destination: string): Promise<void> {
  await ensureParentDir(destination);
  const stat = await fsp.stat(nativePath(source));
  await fsp.copyFile(nativePath(source), nativePath(destination));
  await fsp.utimes(nativePath(destination), stat.atime, stat.mtime);
}

export async function moveFile(source: string, destination: string): Promise<void> {
  await ensureParentDir(destination);
  await fsp.rename(nativePath(source), nativePath(destination));
}

export async function removeIfExists(filePath: string): Promise<void> {
  try {
    await fsp.unlink(nativePath(filePath));
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) {
      throw error;
    }
  }
}

export async function removeDir(dirPath: string): Promise<void> {
  await fsp.rm(extendedRootPath(dirPath), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

/** Copy a directory tree (used for profile-to-profile copies). */
export async function copyDirRecursive(source: string, destination: string): Promise<void> {
  await fsp.cp(extendedRootPath(source), extendedRootPath(destination), {
    recursive: true,
    force: true,
    errorOnExist: false,
    preserveTimestamps: true,
  });
}

export async function readJson<T>(filePath: string): Promise<T> {
  const text = await fsp.readFile(nativePath(filePath), 'utf8');
  return JSON.parse(text) as T;
}

export async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  await ensureParentDir(filePath);
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const text = `${JSON.stringify(data, null, 2)}\n`;
  await fsp.writeFile(nativePath(tmpPath), text, 'utf8');
  try {
    await fsp.rename(nativePath(tmpPath), nativePath(filePath));
  } catch (error) {
    await removeIfExists(tmpPath);
    // Antivirus or a locked file can make rename fail. Fall back to a direct write.
    if (isErrno(error, 'EPERM') || isErrno(error, 'EACCES') || isErrno(error, 'EBUSY')) {
      await fsp.writeFile(nativePath(filePath), text, 'utf8');
      return;
    }
    throw error;
  }
}

export async function hashFile(filePath: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = fs.createReadStream(nativePath(filePath));
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/** Remove now-empty parent folders, but never the target root itself. */
export async function pruneEmptyParents(filePath: string, stopAt: string): Promise<void> {
  const stop = path.resolve(stopAt);
  let current = path.dirname(filePath);
  while (path.resolve(current).length > stop.length && isInside(path.resolve(current), stop)) {
    try {
      const entries = await readDir(current);
      if (entries.length > 0) {
        return;
      }
      await fsp.rmdir(nativePath(current));
    } catch {
      return;
    }
    current = path.dirname(current);
  }
}

function isInside(candidate: string, parent: string): boolean {
  const prefix = parent.endsWith(path.sep) ? parent : `${parent}${path.sep}`;
  return candidate === parent || candidate.startsWith(prefix);
}

export function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === code;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
