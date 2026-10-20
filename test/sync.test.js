'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const { SyncEngine } = require('../dist/core/sync.js');
const { nativePath } = require('../dist/core/io.js');

const FLASH = 'R/Macromedia/Flash Player/#SharedObjects/AAAA/localhost/game.swf/save.sol';
const UNITY = 'R/Unity/WebPlayerPrefs';
const DIRECTOR_LL = 'LL/Adobe/Director 11/SPR/Prefs';
const DIRECTOR_PD = 'PD/Adobe/Director 12/SPR/Prefs';

const sandboxes = [];
after(async () => {
  for (const sandbox of sandboxes) {
    await fs.rm(nativePath(sandbox.root), { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
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

async function sandbox(sharedArchive, sharedSystem) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fpdt-test-'));
  const roots = {
    R: path.join(root, 'Roaming'),
    LL: path.join(root, 'LocalLow'),
    PD: path.join(root, 'ProgramData'),
  };
  await Promise.all(Object.values(roots).map(dir => fs.mkdir(nativePath(dir), { recursive: true })));
  const box = {
    root,
    roots,
    archive: sharedArchive || path.join(root, 'archive'),
    system: sharedSystem || path.join(root, 'system'),
    state: path.join(root, 'state'),
  };
  sandboxes.push(box);
  return box;
}

function makeEngine(box, profile = 'Admin', options = {}) {
  return new SyncEngine({
    archiveRoot: options.archive || box.archive,
    systemRoot: options.system || box.system,
    stateDir: options.state || box.state,
    roots: box.roots,
    profile,
    conflictPolicy: options.policy || 'newest',
    safetyBackups: options.safety !== false,
    logger: options.logger || logger(),
    targets: options.targets,
  });
}

function localPathFor(roots, key) {
  const parts = key.split('/');
  return path.join(roots[parts[0]], ...parts.slice(1));
}

function archivePathFor(box, profile, key) {
  return path.join(box.archive, profile, ...key.split('/'));
}

function systemPathFor(box, key) {
  return path.join(box.system, ...key.split('/'));
}

async function writeLocal(box, key, content, mtimeMs) {
  const filePath = localPathFor(box.roots, key);
  await fs.mkdir(nativePath(path.dirname(filePath)), { recursive: true });
  await fs.writeFile(nativePath(filePath), content, 'utf8');
  if (mtimeMs !== undefined) {
    const date = new Date(mtimeMs);
    await fs.utimes(nativePath(filePath), date, date);
  }
  return filePath;
}

async function writeArchive(box, profile, key, content, mtimeMs) {
  const filePath = archivePathFor(box, profile, key);
  await fs.mkdir(nativePath(path.dirname(filePath)), { recursive: true });
  await fs.writeFile(nativePath(filePath), content, 'utf8');
  if (mtimeMs !== undefined) {
    const date = new Date(mtimeMs);
    await fs.utimes(nativePath(filePath), date, date);
  }
  return filePath;
}

async function readFile(filePath) {
  return fs.readFile(nativePath(filePath), 'utf8');
}

async function fileExists(filePath) {
  try {
    await fs.stat(nativePath(filePath));
    return true;
  } catch {
    return false;
  }
}

async function conflictFiles(box, profile = 'Admin') {
  const root = path.join(box.archive, profile, '.conflicts');
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
      } else if (entry.isFile()) {
        found.push({ path: full, content: await readFile(full) });
      }
    }
  }
  await walk(root);
  return found;
}

function expectNoop(result) {
  assert.deepEqual(
    {
      uploaded: result.uploaded,
      downloaded: result.downloaded,
      conflicts: result.conflicts,
      errors: result.errors,
    },
    { uploaded: 0, downloaded: 0, conflicts: 0, errors: 0 },
  );
}

test('first sync uploads local data and the second sync is a no-op', async () => {
  const box = await sandbox();
  await writeLocal(box, FLASH, 'flash-save');
  await writeLocal(box, UNITY, 'unity-prefs');
  const localLogger = logger();
  const engine = makeEngine(box, 'Admin', { logger: localLogger });

  const first = await engine.sync('full');
  assert.equal(first.firstSync, true);
  assert.equal(first.uploaded, 2);
  assert.equal(first.errors, 0);
  assert.equal(await readFile(archivePathFor(box, 'Admin', FLASH)), 'flash-save');
  assert.equal(await readFile(archivePathFor(box, 'Admin', UNITY)), 'unity-prefs');
  assert.equal(await fileExists(path.join(box.archive, 'Admin', 'manifest.json')), true);
  assert.equal(await fileExists(path.join(box.state, 'Admin.json')), true);

  const second = await engine.sync('full');
  assert.equal(second.firstSync, false);
  expectNoop(second);
  assert.ok(localLogger.messages.some(message => message.includes('Sync (full)')));
});

test('first sync on a new machine restores the archive over newer local files', async () => {
  const machineA = await sandbox();
  await writeLocal(machineA, FLASH, 'archive-data');
  await makeEngine(machineA).sync('full');

  const machineB = await sandbox(machineA.archive);
  const localOnlyKey = 'R/Macromedia/Flash Player/#SharedObjects/AAAA/local-only.sol';
  await writeLocal(machineB, FLASH, 'local-data', Date.now() + 60 * 60 * 1000);
  await writeLocal(machineB, localOnlyKey, 'keep-this');

  const engineB = makeEngine(machineB);
  const result = await engineB.sync('full');

  assert.equal(result.firstSync, true);
  assert.ok(result.downloaded >= 1);
  assert.ok(result.uploaded >= 1);
  assert.equal(
    await readFile(localPathFor(machineB.roots, FLASH)),
    'archive-data',
    'the archive must win on the first sync, even when the local file is newer',
  );
  assert.equal(
    await readFile(archivePathFor(machineB, 'Admin', localOnlyKey)),
    'keep-this',
    'local-only files are uploaded during the first sync',
  );

  const stashed = await conflictFiles(machineB);
  assert.ok(stashed.some(file => file.content === 'local-data'), 'the overwritten local file is kept');
});

test('local edits upload and archive edits download', async () => {
  const box = await sandbox();
  await writeLocal(box, FLASH, 'v1');
  const engine = makeEngine(box);
  await engine.sync('full');

  await writeLocal(box, FLASH, 'v2-local', Date.now() + 60_000);
  const upload = await engine.sync('full');
  assert.equal(upload.uploaded, 1);
  assert.equal(upload.downloaded, 0);
  assert.equal(await readFile(archivePathFor(box, 'Admin', FLASH)), 'v2-local');

  await writeArchive(box, 'Admin', FLASH, 'v3-archive', Date.now() + 120_000);
  const download = await engine.sync('full');
  assert.equal(download.downloaded, 1);
  assert.equal(download.uploaded, 0);
  assert.equal(await readFile(localPathFor(box.roots, FLASH)), 'v3-archive');
});

test('conflicts follow the newest modification and keep the losing copy', async () => {
  const box = await sandbox();
  await writeLocal(box, FLASH, 'v1');
  const engine = makeEngine(box);
  await engine.sync('full');

  const older = Date.now() - 60_000;
  const newer = Date.now() + 60_000;
  await writeLocal(box, FLASH, 'local-version', older);
  await writeArchive(box, 'Admin', FLASH, 'archive-version', newer);

  const remoteWins = await engine.sync('full');
  assert.equal(remoteWins.conflicts, 1);
  assert.equal(remoteWins.downloaded, 1);
  assert.equal(remoteWins.stashed, 1);
  assert.equal(await readFile(localPathFor(box.roots, FLASH)), 'archive-version');
  assert.ok((await conflictFiles(box)).some(file => file.content === 'local-version'));

  await writeLocal(box, FLASH, 'local-newer', Date.now() + 240_000);
  await writeArchive(box, 'Admin', FLASH, 'archive-second', Date.now() + 180_000);
  const localWins = await engine.sync('full');
  assert.equal(localWins.conflicts, 1);
  assert.equal(localWins.uploaded, 1);
  assert.equal(await readFile(archivePathFor(box, 'Admin', FLASH)), 'local-newer');
  assert.ok((await conflictFiles(box)).some(file => file.content === 'archive-second'));
});

test('backup mode only uploads and never pulls files', async () => {
  const box = await sandbox();
  await writeLocal(box, FLASH, 'v1');
  await writeLocal(box, UNITY, 'unity-v1');
  const engine = makeEngine(box);
  await engine.sync('full');

  await writeArchive(box, 'Admin', FLASH, 'archive-v2', Date.now() + 60_000);
  const remoteOnlyKey = 'R/Macromedia/Flash Player/#SharedObjects/AAAA/from-archive.sol';
  await writeArchive(box, 'Admin', remoteOnlyKey, 'remote-new');

  const backup = await engine.sync('backup');
  assert.equal(backup.downloaded, 0);
  assert.ok(backup.deferred >= 2);
  assert.equal(await readFile(localPathFor(box.roots, FLASH)), 'v1');
  assert.equal(await fileExists(localPathFor(box.roots, remoteOnlyKey)), false);

  await writeLocal(box, UNITY, 'unity-v2', Date.now() + 60_000);
  const upload = await engine.sync('backup');
  assert.equal(upload.uploaded, 1);
  assert.equal(upload.downloaded, 0);
  assert.equal(await readFile(archivePathFor(box, 'Admin', UNITY)), 'unity-v2');
});

test('deploy forces the archive over local data regardless of timestamps', async () => {
  const box = await sandbox();
  await writeLocal(box, FLASH, 'archive-v1');
  const engine = makeEngine(box);
  await engine.sync('full');

  await writeLocal(box, FLASH, 'local-newest', Date.now() + 24 * 60 * 60 * 1000);
  const result = await engine.deploy('Admin');

  assert.equal(result.downloaded, 1);
  assert.equal(await readFile(localPathFor(box.roots, FLASH)), 'archive-v1');
  assert.equal(await readFile(archivePathFor(box, 'Admin', FLASH)), 'archive-v1');
  assert.ok((await conflictFiles(box)).some(file => file.content === 'local-newest'));

  const afterDeploy = await engine.sync('full');
  expectNoop(afterDeploy);
});

test('copy profile carries only profile data, never the system partition', async () => {
  const machineA = await sandbox();
  await writeLocal(machineA, FLASH, 'admin-save');
  await writeLocal(machineA, DIRECTOR_PD, 'director-save');
  const engineA = makeEngine(machineA);
  await engineA.syncAll('full');

  const copied = await engineA.copyProfile('Admin', 'User');
  assert.equal(copied.copiedFiles, 1, 'only the roaming save belongs to the profile');
  assert.equal(await readFile(archivePathFor(machineA, 'User', FLASH)), 'admin-save');
  assert.equal(await fileExists(path.join(machineA.archive, 'User', 'PD')), false);
  assert.equal(await readFile(systemPathFor(machineA, DIRECTOR_PD)), 'director-save');
  const userManifest = JSON.parse(await readFile(path.join(machineA.archive, 'User', 'manifest.json')));
  assert.equal(userManifest.profile, 'User');
  assert.equal(Object.keys(userManifest.files).some(key => key.startsWith('PD/')), false);

  await assert.rejects(() => engineA.copyProfile('Admin', 'User'), /already exists/);
  await engineA.copyProfile('Admin', 'User', { overwrite: true });

  const machineC = await sandbox(machineA.archive, machineA.system);
  await writeLocal(machineC, FLASH, 'machine-c-save');
  const engineC = makeEngine(machineC, 'User');
  const result = await engineC.syncAll('full');
  assert.equal(result.profile.firstSync, true);
  assert.equal(result.system.firstSync, true);
  assert.equal(await readFile(localPathFor(machineC.roots, FLASH)), 'admin-save');
  assert.equal(await readFile(localPathFor(machineC.roots, DIRECTOR_PD)), 'director-save');
});

test('delete profile can remove its archive and tracked local files', async () => {
  const box = await sandbox();
  const localFile = await writeLocal(box, FLASH, 'v1');
  const engine = makeEngine(box);
  await engine.sync('full');

  const result = await engine.deleteProfile('Admin', { deleteLocalData: true });
  assert.equal(result.deletedArchiveFiles, 1);
  assert.equal(result.deletedLocalFiles, 1);
  assert.equal(await fileExists(localFile), false);
  assert.equal(await fileExists(path.join(box.archive, 'Admin')), false);
  assert.equal(await fileExists(path.join(box.state, 'Admin.json')), false);
});

test('long archive paths survive a round trip', async () => {
  const box = await sandbox();
  const deepSegments = Array.from({ length: 4 }, (_, index) => `${index}-${'x'.repeat(60)}`);
  const deepKey = `R/Macromedia/Flash Player/#SharedObjects/${deepSegments.join('/')}/save.sol`;

  await writeLocal(box, deepKey, 'deep-save');
  const engine = makeEngine(box);
  const upload = await engine.sync('full');
  assert.equal(upload.uploaded, 1);
  assert.equal(upload.errors, 0);

  const archiveFile = archivePathFor(box, 'Admin', deepKey);
  assert.ok(archiveFile.length > 260, 'test should exercise a path longer than MAX_PATH');
  assert.equal(await readFile(archiveFile), 'deep-save');

  const machineB = await sandbox(box.archive);
  const restore = await makeEngine(machineB).sync('full');
  assert.equal(restore.errors, 0);
  assert.equal(await readFile(localPathFor(machineB.roots, deepKey)), 'deep-save');

  const copied = await engine.copyProfile('Admin', 'Copy');
  assert.equal(copied.copiedFiles, 1);
  assert.equal(await readFile(archivePathFor(box, 'Copy', deepKey)), 'deep-save');
  const deleted = await engine.deleteProfile('Copy');
  assert.equal(deleted.deletedArchiveFiles, 1);
  assert.equal(await fileExists(path.join(box.archive, 'Copy')), false);
});

test('LocalLow is per profile while ProgramData uses the system partition', async () => {
  const machineA = await sandbox();
  await writeLocal(machineA, DIRECTOR_LL, 'director-ll');
  await writeLocal(machineA, DIRECTOR_PD, 'director-pd');
  await makeEngine(machineA).syncAll('full');

  assert.equal(await readFile(archivePathFor(machineA, 'Admin', DIRECTOR_LL)), 'director-ll');
  assert.equal(await readFile(systemPathFor(machineA, DIRECTOR_PD)), 'director-pd');
  assert.equal(
    await fileExists(path.join(machineA.archive, 'Admin', 'PD')),
    false,
    'ProgramData must never be duplicated into a profile',
  );

  // A profile-only sync must not read or write ProgramData.
  await writeLocal(machineA, DIRECTOR_LL, 'director-ll-2', Date.now() + 60_000);
  await writeLocal(machineA, DIRECTOR_PD, 'director-pd-2', Date.now() + 60_000);
  await makeEngine(machineA).sync('full');
  assert.equal(await readFile(archivePathFor(machineA, 'Admin', DIRECTOR_LL)), 'director-ll-2');
  assert.equal(await readFile(systemPathFor(machineA, DIRECTOR_PD)), 'director-pd');

  const machineB = await sandbox(machineA.archive, machineA.system);
  await writeLocal(machineB, DIRECTOR_PD, 'machine-b-pd', Date.now() + 24 * 60 * 60 * 1000);
  const result = await makeEngine(machineB).syncAll('full');
  assert.ok(result.profile.downloaded >= 1);
  assert.ok(result.system.downloaded >= 1);
  assert.equal(await readFile(localPathFor(machineB.roots, DIRECTOR_LL)), 'director-ll-2');
  assert.equal(
    await readFile(localPathFor(machineB.roots, DIRECTOR_PD)),
    'director-pd',
    'the shared system archive wins on a new machine',
  );
});

test('incremental sync uploads only changed files', async () => {
  const box = await sandbox();
  await writeLocal(box, FLASH, 'v1');
  await writeLocal(box, UNITY, 'unity-v1');
  const engine = makeEngine(box);
  await engine.syncAll('full');

  const addedKey = 'R/Macromedia/Flash Player/#SharedObjects/AAAA/added.sol';
  const addedPath = await writeLocal(box, addedKey, 'new-save');
  await writeLocal(box, FLASH, 'v2', Date.now() + 60_000);

  const result = await engine.syncChanges([localPathFor(box.roots, FLASH), addedPath], 'backup');
  assert.equal(result.profile.uploaded, 2);
  assert.equal(result.profile.downloaded, 0);
  assert.equal(result.system.uploaded, 0);
  assert.equal(await readFile(archivePathFor(box, 'Admin', FLASH)), 'v2');
  assert.equal(await readFile(archivePathFor(box, 'Admin', addedKey)), 'new-save');
  assert.equal(await readFile(archivePathFor(box, 'Admin', UNITY)), 'unity-v1');
});

test('incremental sync handles a changed directory and a deleted directory', async () => {
  const box = await sandbox();
  const nestedKey = 'R/Macromedia/Flash Player/#SharedObjects/AAAA/campaign/save.sol';
  const nestedPath = await writeLocal(box, nestedKey, 'nested-save');
  const nestedDir = path.dirname(nestedPath);
  const engine = makeEngine(box);
  await engine.syncAll('full');

  const addedKey = 'R/Macromedia/Flash Player/#SharedObjects/AAAA/campaign/added.sol';
  const addedPath = await writeLocal(box, addedKey, 'added-save');
  const upload = await engine.syncChanges([nestedDir], 'backup');
  assert.equal(upload.profile.uploaded, 1);
  assert.equal(await readFile(archivePathFor(box, 'Admin', addedKey)), 'added-save');

  await fs.rm(nativePath(nestedDir), { recursive: true, force: true });
  const restore = await engine.syncChanges([nestedDir], 'full');
  assert.equal(restore.profile.downloaded, 2);
  assert.equal(await readFile(nestedPath), 'nested-save');
  assert.equal(await readFile(addedPath), 'added-save');
});

test('incremental sync updates the system partition independently', async () => {
  const box = await sandbox();
  await writeLocal(box, DIRECTOR_PD, 'pd-v1');
  const engine = makeEngine(box);
  await engine.syncAll('full');

  const pdPath = await writeLocal(box, DIRECTOR_PD, 'pd-v2', Date.now() + 60_000);
  const result = await engine.syncChanges([pdPath], 'backup');
  assert.equal(result.profile.uploaded, 0);
  assert.equal(result.system.uploaded, 1);
  assert.equal(await readFile(systemPathFor(box, DIRECTOR_PD)), 'pd-v2');
});

test('incremental sync ignores unrelated and generated files', async () => {
  const box = await sandbox();
  await writeLocal(box, FLASH, 'v1');
  const engine = makeEngine(box);
  await engine.syncAll('full');

  const outside = path.join(box.root, 'outside.sol');
  await fs.writeFile(nativePath(outside), 'outside');
  const ignored = 'R/Macromedia/Flash Player/#SharedObjects/AAAA/desktop.ini';
  const ignoredPath = await writeLocal(box, ignored, 'ignored');
  const result = await engine.syncChanges([outside, ignoredPath], 'backup');

  assert.deepEqual(
    {
      uploaded: result.profile.uploaded,
      downloaded: result.profile.downloaded,
      conflicts: result.profile.conflicts,
      errors: result.profile.errors,
    },
    { uploaded: 0, downloaded: 0, conflicts: 0, errors: 0 },
  );
  assert.equal(await fileExists(archivePathFor(box, 'Admin', ignored)), false);
});

test('a profile named System cannot collide with the system partition', async () => {
  const box = await sandbox();
  const profileSave = await writeLocal(box, FLASH, 'system-profile-save');
  const systemSave = await writeLocal(box, DIRECTOR_PD, 'system-partition-save');
  const engine = makeEngine(box, 'System');
  await engine.syncAll('full');

  assert.equal(await readFile(archivePathFor(box, 'System', FLASH)), 'system-profile-save');
  assert.equal(await readFile(systemPathFor(box, DIRECTOR_PD)), 'system-partition-save');
  assert.equal(await fileExists(path.join(box.archive, 'System', 'PD')), false);
  assert.ok((await engine.listProfiles()).includes('System'));
  assert.equal((await engine.listProfiles()).some(name => name.startsWith('.')), false);

  // Deleting the profile named System must not touch the shared partition.
  await engine.deleteProfile('System', { deleteLocalData: true });
  assert.equal(await fileExists(profileSave), false);
  assert.equal(await fileExists(systemSave), true);
  assert.equal(await fileExists(systemPathFor(box, DIRECTOR_PD)), true);
  assert.equal(await fileExists(path.join(box.archive, 'System')), false);
});

test('the system partition must be separate from the profile archive', async () => {
  const box = await sandbox();
  assert.throws(
    () => makeEngine(box, 'Admin', { system: box.archive }),
    /separate folder/,
  );
  assert.throws(
    () => makeEngine(box, 'Admin', { system: path.join(box.archive, 'System') }),
    /separate folder/,
    'a nested folder would look like a profile named System',
  );
});

test('the system partition can be deleted independently', async () => {
  const box = await sandbox();
  const profileSave = await writeLocal(box, FLASH, 'profile-save');
  const systemSave = await writeLocal(box, DIRECTOR_PD, 'system-save');
  const engine = makeEngine(box);
  await engine.syncAll('full');

  const result = await engine.deleteSystem({ deleteLocalData: true });
  assert.equal(result.deletedArchiveFiles, 1);
  assert.equal(result.deletedLocalFiles, 1);
  assert.equal(await fileExists(systemSave), false);
  assert.equal(await fileExists(path.join(box.system, 'PD')), false);
  assert.equal(await fileExists(systemPathFor(box, DIRECTOR_PD)), false);
  assert.equal(await fileExists(profileSave), true, 'the profile is untouched');
  assert.equal(await readFile(archivePathFor(box, 'Admin', FLASH)), 'profile-save');
});

test('a locally deleted save is restored instead of deleting the archive copy', async () => {
  const box = await sandbox();
  const localFile = await writeLocal(box, FLASH, 'v1');
  const engine = makeEngine(box);
  await engine.sync('full');

  await fs.rm(nativePath(localFile));
  const result = await engine.sync('full');
  assert.equal(result.downloaded, 1);
  assert.equal(result.uploaded, 0);
  assert.equal(await readFile(localFile), 'v1');
  assert.equal(await readFile(archivePathFor(box, 'Admin', FLASH)), 'v1');
});

test('status reports the active profile and both partitions', async () => {
  const box = await sandbox();
  await writeLocal(box, FLASH, 'v1');
  await writeLocal(box, DIRECTOR_PD, 'pd-v1');
  const engine = makeEngine(box);
  await engine.syncAll('full');

  const status = await engine.status({ includeProfiles: true });
  assert.equal(status.profile, 'Admin');
  assert.equal(status.localFileCount, 1);
  assert.equal(status.remoteFileCount, 1);
  assert.equal(status.system.localFileCount, 1);
  assert.equal(status.system.archiveFileCount, 1);
  assert.equal(status.system.archiveDir, box.system);
  assert.ok(status.profiles.some(profile => profile.name === 'Admin' && profile.active));
});

test('status only loads profile summaries when requested', async () => {
  const box = await sandbox();
  await writeLocal(box, FLASH, 'v1');
  const localLogger = logger();
  const engine = makeEngine(box, 'Admin', { logger: localLogger });
  await engine.syncAll('full');

  const otherManifest = path.join(box.archive, 'Other', 'manifest.json');
  await fs.mkdir(nativePath(path.dirname(otherManifest)), { recursive: true });
  await fs.writeFile(nativePath(otherManifest), 'not valid json');

  const fast = await engine.status();
  assert.deepEqual(fast.profiles, []);
  assert.equal((await engine.profileSummary('Admin')).fileCount, 1);
  assert.equal(
    localLogger.messages.some(message => message.includes('not valid JSON')),
    false,
    'status must not read another profile\'s manifest',
  );
});

test('status uses tracked manifests unless an on-disk scan is requested', async () => {
  const box = await sandbox();
  await writeLocal(box, FLASH, 'v1');
  const engine = makeEngine(box);
  await engine.syncAll('full');

  await writeLocal(box, UNITY, 'not-synced-yet');
  const tracked = await engine.status();
  assert.equal(tracked.localFileCount, 1);

  const scanned = await engine.status({ scan: true });
  assert.equal(scanned.localFileCount, 2);
});
