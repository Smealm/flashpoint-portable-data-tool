'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');

const { nativePath } = require('../dist/core/io.js');

function makeDisposable(onDispose) {
  return { toDispose: [], isDisposed: false, onDispose };
}

function makeEvent() {
  const listeners = [];
  const event = listener => {
    listeners.push(listener);
    return makeDisposable(() => {
      const index = listeners.indexOf(listener);
      if (index >= 0) {
        listeners.splice(index, 1);
      }
    });
  };
  event.listeners = listeners;
  event.fire = async value => {
    for (const listener of [...listeners]) {
      await listener(value);
    }
  };
  return event;
}

async function writeFile(filePath, content) {
  await fs.mkdir(nativePath(path.dirname(filePath)), { recursive: true });
  await fs.writeFile(nativePath(filePath), content, 'utf8');
}

async function readFile(filePath) {
  return fs.readFile(nativePath(filePath), 'utf8');
}

async function exists(filePath) {
  try {
    await fs.stat(nativePath(filePath));
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) {
      return true;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return false;
}

const tempRoot = require('node:fs').mkdtempSync(path.join(os.tmpdir(), 'fpdt-ext-'));
const extensionRoot = path.join(tempRoot, 'Data', 'Extensions', 'FPDT');
const roaming = path.join(tempRoot, 'user', 'AppData', 'Roaming');
const localLow = path.join(tempRoot, 'user', 'AppData', 'LocalLow');
const programData = path.join(tempRoot, 'ProgramData');
const localAppData = path.join(tempRoot, 'user', 'AppData', 'Local');

process.env.APPDATA = roaming;
process.env.USERPROFILE = path.join(tempRoot, 'user');
process.env.LOCALAPPDATA = localAppData;
process.env.PROGRAMDATA = programData;
process.env.USERNAME = 'TestUser';

const logs = [];
const commands = new Map();
const hooks = {
  onWillLaunchGame: makeEvent(),
  onWillLaunchAddApp: makeEvent(),
};
const config = {};

const fakeFlashpoint = {
  extensionPath: extensionRoot,
  log: {
    trace: message => logs.push(['trace', message]),
    debug: message => logs.push(['debug', message]),
    info: message => logs.push(['info', message]),
    warn: message => logs.push(['warn', message]),
    error: message => logs.push(['error', message]),
  },
  registerDisposable(parent, child) {
    parent.toDispose.push(child);
  },
  commands: {
    registerCommand(name, callback) {
      commands.set(name, callback);
      return makeDisposable(() => commands.delete(name));
    },
  },
  games: hooks,
  onExtConfigChange: makeEvent(),
  getExtConfigValue(key) {
    return config[key];
  },
  async setExtConfigValue(key, value) {
    config[key] = value;
  },
  dialogs: {
    async showMessageBox() {
      // Out-of-range acts like closing the dialog.
      return 99;
    },
    async showMessageBoxWithHandle() {
      return 'handle';
    },
    async awaitDialog() {
      return { buttonId: 1, buttonIdx: 1, dialog: { id: 'handle', message: '', buttons: [], fields: [] } };
    },
  },
};

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === 'flashpoint-launcher') {
    return fakeFlashpoint;
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { activate, deactivate } = require('../dist/extension.js');

after(async () => {
  Module._load = originalLoad;
  await fs.rm(nativePath(tempRoot), { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
});

test('activate registers hooks and syncs through the mocked launcher API', { skip: process.platform !== 'win32' }, async () => {
  const saveKey = path.join(roaming, 'Macromedia', 'Flash Player', '#SharedObjects', 'AAAA', 'game.swf', 'save.sol');
  await writeFile(saveKey, 'wired-save');
  const systemSaveKey = path.join(programData, 'Adobe', 'Director 12', 'SPR', 'Prefs');
  await writeFile(systemSaveKey, 'wired-system-save');

  config['fpdt.conflictPolicy'] = 'remote';
  const context = { subscriptions: makeDisposable() };
  await activate(context);
  assert.equal(config['fpdt.conflictPolicy'], 'flashpoint', 'legacy remote policy is migrated');

  assert.ok(commands.has('fpdt.openManager'), 'manager command is registered');
  assert.equal(hooks.onWillLaunchGame.listeners.length, 1);
  assert.equal(hooks.onWillLaunchAddApp.listeners.length, 1);

  const archiveFile = path.join(
    extensionRoot,
    'profiles',
    'TestUser',
    'R',
    'Macromedia',
    'Flash Player',
    '#SharedObjects',
    'AAAA',
    'game.swf',
    'save.sol',
  );
  assert.ok(await waitFor(() => exists(archiveFile)), 'startup sync uploads the save');
  assert.equal(await readFile(archiveFile), 'wired-save');

  const systemArchiveFile = path.join(
    extensionRoot,
    '.global',
    'PD',
    'Adobe',
    'Director 12',
    'SPR',
    'Prefs',
  );
  assert.ok(await waitFor(() => exists(systemArchiveFile)), 'startup sync uploads system data');
  assert.equal(await readFile(systemArchiveFile), 'wired-system-save');
  assert.equal(
    await exists(path.join(extensionRoot, 'profiles', 'TestUser', 'PD')),
    false,
    'system data is not duplicated into the profile',
  );

  // The pre-launch hook performs an awaited full sync.
  await writeFile(saveKey.replace('save.sol', 'second.sol'), 'second-save');
  await hooks.onWillLaunchGame.fire({});
  const secondArchiveFile = archiveFile.replace('save.sol', 'second.sol');
  assert.equal(await exists(secondArchiveFile), true);
  assert.equal(await readFile(secondArchiveFile), 'second-save');

  // The folder watcher backs up a change without any other trigger.
  await writeFile(saveKey.replace('save.sol', 'watched.sol'), 'watched-save');
  const watchedArchiveFile = archiveFile.replace('save.sol', 'watched.sol');
  assert.ok(
    await waitFor(() => exists(watchedArchiveFile), 8000),
    'file watcher triggers a debounced backup',
  );
  assert.equal(await readFile(watchedArchiveFile), 'watched-save');

  // Config changes are applied without throwing.
  await fakeFlashpoint.onExtConfigChange.fire({ key: 'fpdt.backupIntervalMinutes', value: '0' });
  await fakeFlashpoint.onExtConfigChange.fire({ key: 'fpdt.profile', value: 'TestUser' });

  // The manager command opens and closes against the mocked dialogs.
  await commands.get('fpdt.openManager')();

  assert.ok(
    logs.some(([level, message]) => level === 'info' && message.includes('Restoring save data')),
    'startup logs what it is doing',
  );

  await deactivate();
  assert.ok(context.subscriptions.toDispose.length >= 4, 'event subscriptions are registered for disposal');
  for (const disposable of context.subscriptions.toDispose) {
    disposable.onDispose?.();
  }
  assert.equal(hooks.onWillLaunchGame.listeners.length, 0, 'disposing the context removes the hook');
});
