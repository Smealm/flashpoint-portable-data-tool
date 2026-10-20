'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const { CloudEngine, resolveCloudKey, isExcludedCloudKey } = require('../dist/core/cloud.js');
const { SyncEngine } = require('../dist/core/sync.js');
const { nativePath } = require('../dist/core/io.js');
const { SaveDataWatcher } = require('../dist/watcher.js');

const PLAYLIST = 'Data/Playlists/list.json';
const THEME = 'Data/Themes/theme.css';
const PROFILE_SAVE = 'Data/Extensions/FPDT/profiles/Admin/R/Macromedia/Flash Player/#SharedObjects/AAAA/save.sol';
const SYSTEM_SAVE = 'Data/Extensions/FPDT/.global/PD/Adobe/Director 12/SPR/Prefs';
const NAVIGATOR = 'FPSoftware/fpnavigator-portable/User/flashpointnavigator/Profiles/Default/webappsstore.sqlite';
const P851 = 'FPSoftware/Shockwave/PJ851/Prefs/prefs.txt';
const P9 = 'FPSoftware/Shockwave/PJ9/Prefs/prefs.txt';
const MOTHERLOAD = 'Legacy/cgi-bin/www.xgenstudios.com/motherload/savedata/save.xml';
const STICKRPG2 = 'Legacy/cgi-bin/api.xgenstudios.com/stickrpg2/users.txt';
const FIDGIT = 'Legacy/htdocs/pbskids.org/designsquad/games/fidgit/php/fidgit.db';

const sandboxes = [];
after(async () => {
  for (const root of sandboxes) {
    await fs.rm(nativePath(root), { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }
});

function logger() {
  const messages = [];
  return {
    messages,
    debug: () => {},
    info: message => messages.push(message),
    warn: message => messages.push(message),
    error: message => messages.push(message),
  };
}

function md5(data) {
  return createHash('md5').update(data).digest('hex');
}

/** In-memory stand-in for the Google Drive app data folder. */
class FakeDrive {
  constructor() {
    this.files = new Map();
    this.manifest = null;
    this.nextId = 1;
    this.failKeys = new Set();
  }

  async list() {
    return [...this.files.entries()].map(([key, file]) => ({
      key,
      fileId: file.id,
      md5: file.md5,
      size: file.data.length,
      modifiedTime: file.modifiedTime,
    }));
  }

  async download(file, destination) {
    if (this.failKeys.has(file.key)) {
      throw new Error(`Simulated cloud failure for ${file.key}`);
    }
    const stored = this.files.get(file.key);
    if (!stored) {
      throw new Error(`No such fake cloud file: ${file.key}`);
    }
    await fs.mkdir(nativePath(path.dirname(destination)), { recursive: true });
    await fs.writeFile(nativePath(destination), stored.data);
  }

  async upload(key, source, fileId) {
    const data = await fs.readFile(nativePath(source));
    const existing = fileId
      ? [...this.files.values()].find(file => file.id === fileId)
      : null;
    const id = existing?.id ?? fileId ?? `file-${this.nextId++}`;
    const stored = {
      id,
      data,
      md5: md5(data),
      modifiedTime: new Date().toISOString(),
    };
    this.files.set(key, stored);
    return { fileId: id, md5: stored.md5 };
  }

  async remove(fileId) {
    for (const [key, file] of this.files) {
      if (file.id === fileId) {
        this.files.delete(key);
      }
    }
  }

  async readManifest() {
    return this.manifest ? JSON.parse(JSON.stringify(this.manifest)) : null;
  }

  async writeManifest(data) {
    this.manifest = JSON.parse(JSON.stringify(data));
  }

  async isConnected() {
    return true;
  }

  put(key, content, mtimeMs) {
    const data = Buffer.from(content);
    const id = `file-${this.nextId++}`;
    this.files.set(key, {
      id,
      data,
      md5: md5(data),
      modifiedTime: new Date(mtimeMs ?? Date.now()).toISOString(),
    });
    return id;
  }

  content(key) {
    const file = this.files.get(key);
    return file ? file.data.toString('utf8') : null;
  }

  keys() {
    return [...this.files.keys()].sort();
  }
}

async function sandbox() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fpdt-cloud-test-'));
  sandboxes.push(root);
  const box = {
    root,
    extension: path.join(root, 'Data', 'Extensions', 'FPDT'),
    state: path.join(root, 'state'),
    manifest: path.join(root, 'Data', 'Extensions', 'FPDT', 'cloud.json'),
  };
  await fs.mkdir(nativePath(box.extension), { recursive: true });
  return box;
}

function makeCloud(box, drive, options = {}) {
  return new CloudEngine({
    root: box.root,
    manifestPath: box.manifest,
    stateDir: box.state,
    safetyBackups: options.safety !== false,
    transport: drive,
    logger: options.logger || logger(),
    scope: options.scope,
  });
}

function absolute(box, key) {
  return path.join(box.root, ...key.split('/'));
}

async function write(box, key, content, mtimeMs) {
  const filePath = absolute(box, key);
  await fs.mkdir(nativePath(path.dirname(filePath)), { recursive: true });
  await fs.writeFile(nativePath(filePath), content);
  if (mtimeMs !== undefined) {
    const date = new Date(mtimeMs);
    await fs.utimes(nativePath(filePath), date, date);
  }
  return filePath;
}

async function read(box, key) {
  return fs.readFile(nativePath(absolute(box, key)), 'utf8');
}

async function exists(filePath) {
  try {
    await fs.stat(nativePath(filePath));
    return true;
  } catch {
    return false;
  }
}

async function conflictCopies(box) {
  const root = path.join(box.extension, '.cloud-conflicts');
  const found = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await fs.readdir(nativePath(dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else {
        found.push({ path: full, content: await fs.readFile(nativePath(full), 'utf8') });
      }
    }
  }
  await walk(root);
  return found;
}

test('first cloud sync uploads the portable folders, extras, and nothing else', async () => {
  const box = await sandbox();
  const drive = new FakeDrive();
  await write(box, PLAYLIST, 'playlist');
  await write(box, THEME, 'theme');
  await write(box, PROFILE_SAVE, 'profile-save');
  await write(box, SYSTEM_SAVE, 'system-save');
  await write(box, NAVIGATOR, 'navigator-state');
  await write(box, P851, 'p851-prefs');
  await write(box, P9, 'p9-prefs');
  await write(box, 'Data/Games/game.zip', 'not-unique-fpdt-data');
  await write(box, 'Other/notes.txt', 'outside-scope');
  await write(box, 'Data/Extensions/FPDT/profiles/Admin/.conflicts/stamp/remote/save.sol', 'conflict-copy');

  const cloud = makeCloud(box, drive);
  const first = await cloud.sync();

  assert.equal(first.firstSync, true);
  assert.equal(first.errors, 0);
  assert.equal(first.uploaded, 7);
  assert.deepEqual(
    drive.keys(),
    [PLAYLIST, THEME, PROFILE_SAVE, SYSTEM_SAVE, NAVIGATOR, P851, P9].sort(),
    'only the configured cloud scope is uploaded',
  );
  assert.equal(drive.content(PLAYLIST), 'playlist');
  assert.equal(await exists(box.manifest), true);

  const manifest = JSON.parse(await fs.readFile(nativePath(box.manifest), 'utf8'));
  assert.equal(manifest.profile, 'cloud');
  assert.deepEqual(Object.keys(manifest.files).sort(), drive.keys());
  assert.equal(manifest.files[PLAYLIST].size, 'playlist'.length);

  const second = await cloud.sync();
  assert.deepEqual(
    {
      uploaded: second.uploaded,
      downloaded: second.downloaded,
      conflicts: second.conflicts,
      errors: second.errors,
      firstSync: second.firstSync,
    },
    { uploaded: 0, downloaded: 0, conflicts: 0, errors: 0, firstSync: false },
  );
  assert.equal(drive.keys().length, 7);
});

test('an empty collection initializes both manifests without errors', async () => {
  const box = await sandbox();
  const drive = new FakeDrive();
  const cloud = makeCloud(box, drive);

  const first = await cloud.sync();
  assert.equal(first.firstSync, true);
  assert.equal(first.errors, 0);
  assert.equal(await exists(box.manifest), true);
  assert.deepEqual(drive.manifest.files, {});

  const second = await cloud.sync();
  assert.equal(second.firstSync, false);
  assert.deepEqual(
    { uploaded: second.uploaded, downloaded: second.downloaded, errors: second.errors },
    { uploaded: 0, downloaded: 0, errors: 0 },
  );
});

test('a Flashpoint folder with no cloud manifest gets the cloud backup laid over it', async () => {
  const box = await sandbox();
  const drive = new FakeDrive();
  drive.put(PLAYLIST, 'cloud-playlist', Date.now() - 3_600_000);
  drive.put(THEME, 'cloud-theme', Date.now() - 3_600_000);
  const localOnly = 'Data/Playlists/local-only.json';
  await write(box, PLAYLIST, 'local-playlist', Date.now() + 3_600_000);
  await write(box, localOnly, 'keep-me');

  const cloud = makeCloud(box, drive);
  const result = await cloud.sync();

  assert.equal(result.firstSync, true);
  assert.equal(result.downloaded, 2);
  assert.equal(result.uploaded, 1, 'local-only portable data is still backed up');
  assert.equal(await read(box, PLAYLIST), 'cloud-playlist', 'cloud wins on the first sync');
  assert.equal(await read(box, THEME), 'cloud-theme');
  assert.equal(drive.content(localOnly), 'keep-me');
  assert.ok(
    (await conflictCopies(box)).some(file => file.content === 'local-playlist'),
    'the overwritten Flashpoint copy is preserved',
  );
});

test('cloud files are authoritative again when the cloud manifest is lost', async () => {
  const box = await sandbox();
  const drive = new FakeDrive();
  await write(box, PLAYLIST, 'v1');
  const cloud = makeCloud(box, drive);
  await cloud.sync();

  drive.manifest = null;
  drive.put(PLAYLIST, 'cloud-v2', Date.now() + 60_000);
  await write(box, PLAYLIST, 'flashpoint-v2', Date.now() + 120_000);

  const result = await cloud.sync();
  assert.equal(result.firstSync, true);
  assert.equal(await read(box, PLAYLIST), 'cloud-v2');
  assert.equal(result.uploaded, 0);
});

test('local portable changes upload and cloud changes download', async () => {
  const box = await sandbox();
  const drive = new FakeDrive();
  await write(box, PLAYLIST, 'v1');
  const cloud = makeCloud(box, drive);
  await cloud.sync();

  await write(box, PLAYLIST, 'v2-local', Date.now() + 60_000);
  const upload = await cloud.sync();
  assert.equal(upload.uploaded, 1);
  assert.equal(upload.downloaded, 0);
  assert.equal(drive.content(PLAYLIST), 'v2-local');

  drive.put(PLAYLIST, 'v3-cloud', Date.now() + 120_000);
  const download = await cloud.sync();
  assert.equal(download.downloaded, 1);
  assert.equal(download.uploaded, 0);
  assert.equal(await read(box, PLAYLIST), 'v3-cloud');

  const noop = await cloud.sync();
  assert.deepEqual(
    { uploaded: noop.uploaded, downloaded: noop.downloaded, conflicts: noop.conflicts, errors: noop.errors },
    { uploaded: 0, downloaded: 0, conflicts: 0, errors: 0 },
  );
});

test('cloud conflicts keep the newest file and stash the loser', async () => {
  const box = await sandbox();
  const drive = new FakeDrive();
  await write(box, PLAYLIST, 'v1');
  const cloud = makeCloud(box, drive);
  await cloud.sync();

  await write(box, PLAYLIST, 'local-version', Date.now() - 60_000);
  drive.put(PLAYLIST, 'cloud-version', Date.now() + 60_000);
  const cloudWins = await cloud.sync();
  assert.equal(cloudWins.conflicts, 1);
  assert.equal(await read(box, PLAYLIST), 'cloud-version');
  assert.ok((await conflictCopies(box)).some(file => file.content === 'local-version'));

  await write(box, PLAYLIST, 'local-newer', Date.now() + 240_000);
  drive.put(PLAYLIST, 'cloud-older', Date.now() + 180_000);
  const localWins = await cloud.sync();
  assert.equal(localWins.conflicts, 1);
  assert.equal(drive.content(PLAYLIST), 'local-newer');
  assert.ok((await conflictCopies(box)).some(file => file.content === 'cloud-older'));
});

test('a cloud file that cannot be read is never overwritten by a stale local copy', async () => {
  const machineA = await sandbox();
  const drive = new FakeDrive();
  await write(machineA, PLAYLIST, 'cloud-playlist');
  await write(machineA, THEME, 'cloud-theme');
  await makeCloud(machineA, drive).sync();

  const machineB = await sandbox();
  await write(machineB, PLAYLIST, 'stale-local-playlist');
  await write(machineB, 'Data/Playlists/local.json', 'local-only');
  drive.failKeys.add(PLAYLIST);

  const cloudB = makeCloud(machineB, drive);
  const failed = await cloudB.sync();
  assert.equal(failed.errors, 1);
  assert.equal(drive.content(PLAYLIST), 'cloud-playlist', 'the unreadable cloud copy is left alone');
  assert.equal(drive.content(THEME), 'cloud-theme');
  assert.equal(drive.content('Data/Playlists/local.json'), 'local-only');

  drive.failKeys.clear();
  const recovered = await cloudB.sync();
  assert.equal(recovered.errors, 0);
  assert.equal(await read(machineB, PLAYLIST), 'cloud-playlist');
});

test('deletions are restored on either side instead of propagating', async () => {
  const box = await sandbox();
  const drive = new FakeDrive();
  await write(box, PLAYLIST, 'keep-cloud');
  await write(box, THEME, 'keep-flashpoint');
  const cloud = makeCloud(box, drive);
  await cloud.sync();

  await drive.remove(drive.files.get(PLAYLIST).id);
  const restoredCloud = await cloud.sync();
  assert.equal(restoredCloud.uploaded, 1);
  assert.equal(drive.content(PLAYLIST), 'keep-cloud');

  await fs.rm(nativePath(absolute(box, THEME)));
  const restoredLocal = await cloud.sync();
  assert.equal(restoredLocal.downloaded, 1);
  assert.equal(await read(box, THEME), 'keep-flashpoint');
});

test('the nested Flashpoint/FPSoftware layout is used when the root layout is absent', async () => {
  const box = await sandbox();
  const drive = new FakeDrive();
  const nested = `Flashpoint/${P851}`;
  await write(box, nested, 'nested-p851');
  const cloud = makeCloud(box, drive);
  await cloud.sync();
  assert.ok(drive.files.has(nested), 'the existing nested layout is picked');
  assert.equal(drive.files.has(P851), false);
});

test('required additional paths are restored from the cloud', async () => {
  const box = await sandbox();
  const drive = new FakeDrive();
  drive.put(NAVIGATOR, 'navigator-backup');
  drive.put(P851, 'p851-backup');
  drive.put(P9, 'p9-backup');
  drive.put(SYSTEM_SAVE, 'system-backup');
  const cloud = makeCloud(box, drive);

  const result = await cloud.sync();
  assert.equal(result.downloaded, 4);
  assert.equal(await read(box, NAVIGATOR), 'navigator-backup');
  assert.equal(await read(box, P851), 'p851-backup');
  assert.equal(await read(box, P9), 'p9-backup');
  assert.equal(await read(box, SYSTEM_SAVE), 'system-backup');
});

test('a watcher backup invokes the cloud follow-up hook', { skip: process.platform !== 'win32' }, async () => {
  const box = await sandbox();
  const roots = {
    R: path.join(box.root, 'Roaming'),
    LL: path.join(box.root, 'LocalLow'),
    PD: path.join(box.root, 'ProgramData'),
  };
  const saveDir = path.join(roots.R, 'Macromedia', 'Flash Player', '#SharedObjects', 'AAAA');
  await fs.mkdir(nativePath(saveDir), { recursive: true });

  let backedUp = 0;
  let resolveBackup;
  const backedUpOnce = new Promise(resolve => {
    resolveBackup = resolve;
  });
  const fakeEngine = {
    async syncChanges() {
      return { profile: {}, system: {} };
    },
    async syncAll() {
      return { profile: {}, system: {} };
    },
  };
  const watcher = new SaveDataWatcher(
    fakeEngine,
    roots,
    logger(),
    30,
    () => {
      backedUp++;
      resolveBackup();
    },
  );
  try {
    watcher.start();
    await new Promise(resolve => setTimeout(resolve, 300));
    await fs.writeFile(nativePath(path.join(saveDir, 'save.sol')), 'changed');
    await Promise.race([
      backedUpOnce,
      new Promise((_, reject) => setTimeout(() => reject(new Error('cloud hook was not called')), 5000)),
    ]);
    assert.equal(backedUp, 1);
  } finally {
    watcher.dispose();
  }
});

test('local -> Flashpoint -> cloud and cloud -> Flashpoint -> Windows settle without errors', async () => {
  const box = await sandbox();
  box.roots = {
    R: path.join(box.root, 'Roaming'),
    LL: path.join(box.root, 'LocalLow'),
    PD: path.join(box.root, 'ProgramData'),
  };
  const engine = new SyncEngine({
    archiveRoot: path.join(box.extension, 'profiles'),
    systemRoot: path.join(box.extension, '.global'),
    stateDir: box.state,
    roots: box.roots,
    profile: 'Admin',
    conflictPolicy: 'newest',
    safetyBackups: true,
    logger: logger(),
  });
  const localSave = path.join(
    box.roots.R,
    'Macromedia',
    'Flash Player',
    '#SharedObjects',
    'AAAA',
    'save.sol',
  );
  await fs.mkdir(nativePath(path.dirname(localSave)), { recursive: true });
  await fs.writeFile(nativePath(localSave), 'windows-save');
  await engine.syncAll('full');
  assert.equal(await read(box, PROFILE_SAVE), 'windows-save');

  const drive = new FakeDrive();
  const cloud = makeCloud(box, drive);
  const first = await cloud.sync();
  assert.equal(first.errors, 0);
  assert.equal(drive.content(PROFILE_SAVE), 'windows-save', 'the local save reached the cloud');

  drive.put(PROFILE_SAVE, 'cloud-save', Date.now() + 60_000);
  const pulled = await cloud.sync();
  assert.equal(pulled.errors, 0);
  assert.equal(pulled.downloaded, 1);
  assert.equal(await read(box, PROFILE_SAVE), 'cloud-save', 'the cloud save reached the archive first');
  assert.equal(await fs.readFile(nativePath(localSave), 'utf8'), 'windows-save', 'Windows is untouched until a full sync');

  const applied = await engine.syncAll('full');
  assert.equal(applied.profile.errors, 0);
  assert.ok(applied.profile.downloaded >= 1);
  assert.equal(await fs.readFile(nativePath(localSave), 'utf8'), 'cloud-save');

  // Archive manifests changed during the Windows sync; the next cloud pass
  // uploads them, and the pass after that is a clean no-op.
  const syncBack = await cloud.sync();
  assert.equal(syncBack.errors, 0);
  const settled = await cloud.sync();
  assert.deepEqual(
    { uploaded: settled.uploaded, downloaded: settled.downloaded, conflicts: settled.conflicts, errors: settled.errors },
    { uploaded: 0, downloaded: 0, conflicts: 0, errors: 0 },
  );
});

test('pull mode brings cloud changes down without uploading local work', async () => {
  const box = await sandbox();
  const drive = new FakeDrive();
  await write(box, PLAYLIST, 'v1');
  await write(box, THEME, 'theme-v1');
  const cloud = makeCloud(box, drive);
  await cloud.sync();

  await write(box, PLAYLIST, 'local-v2', Date.now() + 60_000);
  await write(box, 'Data/Playlists/new-local.json', 'new-local');
  drive.put(THEME, 'cloud-v2', Date.now() + 60_000);

  const pulled = await cloud.sync({ direction: 'pull' });
  assert.equal(pulled.uploaded, 0, 'pull mode never uploads');
  assert.equal(pulled.downloaded, 1);
  assert.equal(pulled.errors, 0);
  assert.equal(drive.content(PLAYLIST), 'v1', 'the local change is left for the next full sync');
  assert.equal(drive.content('Data/Playlists/new-local.json'), null);
  assert.equal(await read(box, THEME), 'cloud-v2');

  const full = await cloud.sync();
  assert.equal(full.uploaded, 2);
  assert.equal(drive.content(PLAYLIST), 'local-v2');
  assert.equal(drive.content('Data/Playlists/new-local.json'), 'new-local');
});

test('game-specific Legacy save folders are backed up and restored', async () => {
  const box = await sandbox();
  const drive = new FakeDrive();
  await write(box, MOTHERLOAD, 'motherload-save');
  await write(box, STICKRPG2, 'stickrpg2-save');
  await write(box, FIDGIT, 'fidgit-db');

  const cloud = makeCloud(box, drive);
  const first = await cloud.sync();
  assert.equal(first.errors, 0);
  assert.equal(first.uploaded, 3);
  assert.deepEqual(drive.keys(), [MOTHERLOAD, STICKRPG2, FIDGIT].sort());

  const status = await cloud.status();
  assert.ok(status.scope.includes('Legacy/cgi-bin/www.xgenstudios.com/motherload/savedata'));
  assert.ok(status.scope.includes('Legacy/htdocs/pbskids.org/designsquad/games/fidgit/php/fidgit.db'));

  // A fresh machine restores them from cloud on the first pass.
  const other = await sandbox();
  const restored = await makeCloud(other, drive).sync();
  assert.equal(restored.errors, 0);
  assert.equal(restored.downloaded, 3);
  assert.equal(await read(other, MOTHERLOAD), 'motherload-save');
  assert.equal(await read(other, STICKRPG2), 'stickrpg2-save');
  assert.equal(await read(other, FIDGIT), 'fidgit-db');
});

test('cloud files outside the resolved scope are never restored', async () => {
  const box = await sandbox();
  const drive = new FakeDrive();
  await write(box, P851, 'primary-layout');
  drive.put('Data/Games/game.zip', 'not-scoped');
  drive.put(`Flashpoint/${P851}`, 'nested-layout');
  drive.put(PLAYLIST, 'playlist-backup');

  const cloud = makeCloud(box, drive);
  const result = await cloud.sync();
  assert.equal(result.errors, 0);
  assert.equal(result.downloaded, 1, 'only the in-scope playlist is restored');
  assert.equal(await read(box, PLAYLIST), 'playlist-backup');
  assert.equal(await exists(absolute(box, 'Data/Games/game.zip')), false);
  assert.equal(await exists(absolute(box, `Flashpoint/${P851}`)), false);
  assert.equal(
    JSON.parse(await fs.readFile(nativePath(box.manifest), 'utf8')).files[`Flashpoint/${P851}`],
    undefined,
    'out-of-scope cloud paths are not written into the manifest',
  );
});

test('status reports tracked Flashpoint and cloud counts without scanning the whole folder', async () => {
  const box = await sandbox();
  const drive = new FakeDrive();
  await write(box, PLAYLIST, 'playlist');
  await write(box, THEME, 'theme');
  const cloud = makeCloud(box, drive);
  await cloud.sync();

  const status = await cloud.status();
  assert.equal(status.configured, true);
  assert.equal(status.connected, true);
  assert.equal(status.flashpointFileCount, 2);
  assert.equal(status.cloudFileCount, 2);
  assert.equal(status.flashpointBytes, 13);
  assert.ok(status.lastSync);
  assert.ok(status.scope.includes('Data/Playlists'));
  assert.ok(status.scope.includes('Data/Themes'));
});

test('cloud keys cannot escape the Flashpoint root', () => {
  assert.throws(() => resolveCloudKey('C:/Flashpoint', '../outside.txt'), /Invalid cloud key|escapes/);
  assert.throws(() => resolveCloudKey('C:/Flashpoint', 'Data/../outside.txt'), /Invalid cloud key/);
  assert.equal(
    resolveCloudKey('C:/Flashpoint', 'Data/Themes/theme.css'),
    path.resolve('C:/Flashpoint', 'Data', 'Themes', 'theme.css'),
  );
  assert.equal(isExcludedCloudKey('Data/Extensions/FPDT/profiles/Admin/.conflicts/x'), true);
  assert.equal(isExcludedCloudKey('Data/Extensions/FPDT/profiles/Admin/R/save.sol'), false);
});
