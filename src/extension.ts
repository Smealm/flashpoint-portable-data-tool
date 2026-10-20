import * as path from 'path';
import * as flashpoint from 'flashpoint-launcher';
import { CLOUD_MANIFEST_FILE, CloudController, CloudEngine, CloudSyncResult } from './core/cloud';
import { GoogleDriveTransport, openExternalUrl } from './core/gdrive';
import { errorMessage } from './core/io';
import { SyncEngine, SYSTEM_DIR_NAME } from './core/sync';
import {
  ConflictPolicy,
  Logger,
  RootKey,
} from './core/types';
import {
  currentWindowsProfile,
  getDefaultRoots,
  getDefaultStateRoot,
  isWindows,
  sanitizeProfileName,
} from './core/targets';
import { openManager } from './manager';
import { SaveDataWatcher } from './watcher';

interface RuntimeConfig {
  profile: string;
  syncOnStartup: boolean;
  restoreBeforeLaunch: boolean;
  backupOnFileChange: boolean;
  backupIntervalMinutes: number;
  conflictPolicy: ConflictPolicy;
  safetyBackups: boolean;
  cloudEnabled: boolean;
  cloudSyncOnChange: boolean;
  cloudIntervalMinutes: number;
  cloudClientId: string;
  cloudClientSecret: string;
}

const logger: Logger = {
  debug: message => flashpoint.log.debug(`[FPDT] ${message}`),
  info: message => flashpoint.log.info(`[FPDT] ${message}`),
  warn: message => flashpoint.log.warn(`[FPDT] ${message}`),
  error: message => flashpoint.log.error(`[FPDT] ${message}`),
};

let engine: SyncEngine | null = null;
let watcher: SaveDataWatcher | null = null;
let backupTimer: NodeJS.Timeout | null = null;
let configTimer: NodeJS.Timeout | null = null;
let cloudTimer: NodeJS.Timeout | null = null;
let cloudDebounce: NodeJS.Timeout | null = null;
let cloudQueue: Promise<unknown> = Promise.resolve();
let exitFlushListener: (() => void) | null = null;
let roots: Record<RootKey, string>;
let runtimeConfig: RuntimeConfig;
let cloud: CloudEngine | null = null;
let cloudTransport: GoogleDriveTransport | null = null;
let cloudCredentialKey = '';

export async function activate(context: flashpoint.ExtensionContext): Promise<void> {
  if (!isWindows()) {
    flashpoint.log.warn('[FPDT] Flashpoint Portable Data Tool only supports Windows. No save data will be synced.');
    return;
  }

  disposeWatcher();
  disposeCloudTimers();
  await migrateLegacyConflictPolicy();
  runtimeConfig = readConfig();
  roots = getDefaultRoots();
  cloudCredentialKey = '';
  cloudTransport = null;

  const extensionRoot = flashpoint.extensionPath || path.resolve(__dirname, '..');
  // The install layout is <flashpoint>/Data/Extensions/FPDT, so the archive
  // folder and the portable root always agree with each other.
  const flashpointRoot = path.resolve(extensionRoot, '..', '..', '..');
  const stateDir = getDefaultStateRoot();
  engine = new SyncEngine({
    archiveRoot: path.join(extensionRoot, 'profiles'),
    systemRoot: path.join(extensionRoot, SYSTEM_DIR_NAME),
    stateDir,
    roots,
    profile: runtimeConfig.profile,
    conflictPolicy: runtimeConfig.conflictPolicy,
    safetyBackups: runtimeConfig.safetyBackups,
    logger,
  });
  cloud = new CloudEngine({
    root: flashpointRoot,
    manifestPath: path.join(extensionRoot, CLOUD_MANIFEST_FILE),
    stateDir,
    safetyBackups: runtimeConfig.safetyBackups,
    transport: null,
    logger,
  });
  syncCloudTransport(runtimeConfig, stateDir);

  const controller: CloudController = {
    get configured() {
      return cloud?.configured === true;
    },
    status: () => {
      if (!cloud) {
        throw new Error('Cloud sync is not available.');
      }
      return cloud.status();
    },
    sync: () => runCloudSync({ applyToWindows: true }),
    login: async () => {
      if (!cloudTransport) {
        throw new Error(
          'Set the Google Drive client ID and client secret in the FPDT config before connecting.',
        );
      }
      await cloudTransport.login(openExternalUrl);
      await runCloudSync({ applyToWindows: true });
    },
    logout: async () => {
      if (cloudTransport) {
        await cloudTransport.logout();
      }
    },
  };

  const register = (disposable: flashpoint.Disposable): void => {
    flashpoint.registerDisposable(context.subscriptions, disposable);
  };

  register(flashpoint.commands.registerCommand('fpdt.openManager', () => {
    if (!engine) {
      return;
    }
    return openManager(engine, {
      persistProfile: async (profile: string) => {
        await flashpoint.setExtConfigValue('fpdt.profile', profile);
      },
      cloud: controller,
    });
  }));

  const restoreBeforeLaunch = async (): Promise<void> => {
    if (!engine || !runtimeConfig.restoreBeforeLaunch) {
      return;
    }
    try {
      // Pull cloud changes into the Flashpoint folder first, so the same
      // pre-launch sync can put them in Windows before the game starts.
      await pullCloudBeforeFullSync();
      const result = await engine.syncAll('full');
      const errors = result.profile.errors + result.system.errors;
      if (errors > 0) {
        logger.warn(`${errors} file(s) could not be restored before launch. See the logs above.`);
      }
      if (
        runtimeConfig.cloudEnabled &&
        result.profile.uploaded + result.system.uploaded > 0
      ) {
        // New local data reached the Flashpoint folder; push it up shortly.
        scheduleCloudSync();
      }
    } catch (error) {
      // Never block the launch itself; the game may still work with existing files.
      logger.error(`Pre-launch restore failed: ${errorMessage(error)}`);
    }
  };

  register(flashpoint.games.onWillLaunchGame(() => restoreBeforeLaunch()));
  register(flashpoint.games.onWillLaunchAddApp(() => restoreBeforeLaunch()));

  register(flashpoint.onExtConfigChange(change => {
    if (!change.key.startsWith('fpdt.')) {
      return;
    }
    applyConfig(readConfig());
  }));

  applyConfig(runtimeConfig);
  installExitFlush();
  startConfigPoll();

  if (runtimeConfig.syncOnStartup) {
    logger.info(`Restoring save data for profile "${engine.profile}" and system data...`);
    void (async () => {
      await warmUpManifests();
      // Pull cloud changes into the archive first so the startup sync can
      // apply them to Windows. Uploads happen in the background afterwards.
      await pullCloudBeforeFullSync();
      await engine!.syncAll('full');
      if (runtimeConfig.cloudEnabled && cloud?.configured) {
        scheduleCloudSync(1_000, true);
      }
    })().catch(error => {
      logger.error(`Startup sync failed: ${errorMessage(error)}`);
    });
  } else {
    // Nothing to sync right now, but the manifests are still worth holding so
    // the first launch and the first manager redraw do not pay for them.
    void warmUpManifests();
    if (runtimeConfig.cloudEnabled) {
      scheduleCloudSync(5_000, true);
    }
  }
}

/**
 * Read every manifest into memory once, with a progress dialog, before the
 * startup sync. Each manifest is one step: the read cost is dominated by a
 * single parse, so per-manifest progress is honest rather than decorative.
 */
async function warmUpManifests(): Promise<void> {
  const activeEngine = engine;
  if (!activeEngine) {
    return;
  }

  const steps = [...activeEngine.warmSteps()];
  if (cloud?.configured) {
    steps.push(...cloud.warmSteps());
  }

  let dialogId: string | null = null;
  try {
    dialogId = await flashpoint.dialogs.showMessageBoxWithHandle({
      message: 'FPDT: loading save data manifests into memory...',
      userCanCancel: false,
      buttons: ['Hide'],
      fields: [{ type: 'progress', name: 'warmup', value: 0 }],
    });
  } catch (error) {
    // Caching is an optimisation; a launcher without dialogs must still start.
    logger.debug(`Warmup dialog unavailable: ${errorMessage(error)}`);
  }

  try {
    let done = 0;
    for (const step of steps) {
      try {
        const entries = await step.run();
        logger.debug(`Pre-loaded ${step.label}: ${entries} entries`);
      } catch (error) {
        // A missing or unreadable manifest is normal on a first run.
        logger.warn(`Could not pre-load ${step.label}: ${errorMessage(error)}`);
      }
      done++;
      updateWarmupProgress(dialogId, Math.round((done / steps.length) * 100));
    }
  } finally {
    if (dialogId) {
      try {
        flashpoint.dialogs.cancelDialog(dialogId);
      } catch (error) {
        logger.debug(`Could not close the warmup dialog: ${errorMessage(error)}`);
      }
    }
  }
}

function updateWarmupProgress(dialogId: string | null, percent: number): void {
  if (!dialogId) {
    return;
  }
  try {
    flashpoint.dialogs.updateDialogField(dialogId, 'warmup', percent);
  } catch (error) {
    // The user may have closed the dialog while the warmup was still running.
    logger.debug(`Warmup progress update failed: ${errorMessage(error)}`);
  }
}

export async function deactivate(): Promise<void> {
  removeExitFlush();
  disposeWatcher();
  disposeCloudTimers();
  if (backupTimer) {
    clearInterval(backupTimer);
    backupTimer = null;
  }
  if (configTimer) {
    clearInterval(configTimer);
    configTimer = null;
  }
  engine = null;
  cloud = null;
  cloudTransport = null;
}

function applyConfig(next: RuntimeConfig): void {
  const wasEnabled = runtimeConfig?.cloudEnabled === true;
  runtimeConfig = next;
  if (!engine) {
    return;
  }

  if (engine.profile.toLowerCase() !== next.profile.toLowerCase()) {
    engine.setProfile(next.profile);
  }
  engine.setConflictPolicy(next.conflictPolicy);
  engine.setSafetyBackups(next.safetyBackups);
  cloud?.setSafetyBackups(next.safetyBackups);
  syncCloudTransport(next, getDefaultStateRoot());
  if (next.cloudEnabled && !cloud?.configured) {
    logger.warn(
      'Cloud sync is enabled but the Google Drive client ID and client secret are missing. ' +
      'Set fpdt.cloudClientId and fpdt.cloudClientSecret, then connect from the manager.',
    );
  }

  if (next.backupOnFileChange && !watcher) {
    watcher = new SaveDataWatcher(engine, roots, logger, 2500, scheduleCloudSync);
    watcher.start();
  } else if (!next.backupOnFileChange) {
    disposeWatcher();
  }

  restartBackupTimer();
  restartCloudTimer();
  if (next.cloudEnabled && !wasEnabled) {
    scheduleCloudSync(1_000, true);
  }
  if (!next.cloudEnabled) {
    if (cloudTimer) {
      clearInterval(cloudTimer);
      cloudTimer = null;
    }
    if (cloudDebounce) {
      clearTimeout(cloudDebounce);
      cloudDebounce = null;
    }
  }
}

function syncCloudTransport(config: RuntimeConfig, stateDir: string): void {
  const clientId = config.cloudClientId;
  const clientSecret = config.cloudClientSecret;
  const key = `${clientId}\u0000${clientSecret}`;
  if (key === cloudCredentialKey) {
    return;
  }
  cloudCredentialKey = key;
  if (!clientId || !clientSecret) {
    cloudTransport = null;
    cloud?.setTransport(null);
    return;
  }
  cloudTransport = new GoogleDriveTransport(
    { clientId, clientSecret },
    path.join(stateDir, 'cloud-token.json'),
    logger,
  );
  cloud?.setTransport(cloudTransport);
}

function runCloudSync(options: { applyToWindows?: boolean } = {}): Promise<CloudSyncResult> {
  if (!cloud || !engine) {
    return Promise.reject(new Error('Cloud sync is not available.'));
  }
  if (!cloud.configured) {
    return Promise.reject(new Error(
      'Cloud sync needs a Google Drive desktop app client ID and client secret. ' +
      'Set them under Config -> FPDT - Portable Save Data.',
    ));
  }

  const activeCloud = cloud;
  const activeEngine = engine;
  const applyToWindows = options.applyToWindows === true;
  return queueCloudTask(async (): Promise<CloudSyncResult> => {
    const result = await activeCloud.sync();
    // Cloud files only ever land in the Flashpoint folder. A manual sync may
    // apply them to Windows immediately; automatic passes leave that to the
    // next full sync so a running game never loses a file mid-session.
    if (applyToWindows && (result.downloaded > 0 || result.conflicts > 0 || result.firstSync)) {
      await activeEngine.syncAll('full');
    }
    return result;
  });
}

/** Cloud -> Flashpoint only; the following full sync moves it into Windows. */
async function pullCloudBeforeFullSync(): Promise<void> {
  const activeCloud = cloud;
  if (!runtimeConfig?.cloudEnabled || !activeCloud?.configured) {
    return;
  }
  try {
    await queueCloudTask(() => activeCloud.sync({ direction: 'pull' }));
  } catch (error) {
    // A cloud outage must not block local save data from being restored.
    logger.warn(`Cloud sync before the full sync failed: ${errorMessage(error)}`);
  }
}

function queueCloudTask<T>(task: () => Promise<T>): Promise<T> {
  const next = cloudQueue.then(task, task);
  cloudQueue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

/** Wait for a burst of local saves to reach the Flashpoint copy first. */
function scheduleCloudSync(delayMs = 4_000, force = false): void {
  if (!runtimeConfig?.cloudEnabled || !cloud?.configured) {
    return;
  }
  if (!force && !runtimeConfig.cloudSyncOnChange) {
    return;
  }
  if (cloudDebounce) {
    clearTimeout(cloudDebounce);
  }
  cloudDebounce = setTimeout(() => {
    cloudDebounce = null;
    void runCloudSync({ applyToWindows: false }).catch(error => {
      logger.error(`Automatic cloud sync failed: ${errorMessage(error)}`);
    });
  }, delayMs);
  cloudDebounce.unref?.();
}

function restartCloudTimer(): void {
  if (cloudTimer) {
    clearInterval(cloudTimer);
    cloudTimer = null;
  }
  if (!runtimeConfig.cloudEnabled || runtimeConfig.cloudIntervalMinutes <= 0) {
    return;
  }
  cloudTimer = setInterval(() => {
    void runCloudSync({ applyToWindows: false }).catch(error => {
      logger.error(`Scheduled cloud sync failed: ${errorMessage(error)}`);
    });
  }, runtimeConfig.cloudIntervalMinutes * 60_000);
  cloudTimer.unref?.();
}

function disposeCloudTimers(): void {
  if (cloudTimer) {
    clearInterval(cloudTimer);
    cloudTimer = null;
  }
  if (cloudDebounce) {
    clearTimeout(cloudDebounce);
    cloudDebounce = null;
  }
}

function startConfigPoll(): void {
  // onExtConfigChange is not fired by every launcher build, so poll the few
  // values we care about. This keeps Config page edits working without a restart.
  configTimer = setInterval(() => {
    const next = readConfig();
    if (!configsEqual(next, runtimeConfig)) {
      applyConfig(next);
    }
  }, 5_000);
  configTimer.unref?.();
}

function configsEqual(a: RuntimeConfig, b: RuntimeConfig): boolean {
  return (
    a.profile.toLowerCase() === b.profile.toLowerCase() &&
    a.syncOnStartup === b.syncOnStartup &&
    a.restoreBeforeLaunch === b.restoreBeforeLaunch &&
    a.backupOnFileChange === b.backupOnFileChange &&
    a.backupIntervalMinutes === b.backupIntervalMinutes &&
    a.conflictPolicy === b.conflictPolicy &&
    a.safetyBackups === b.safetyBackups &&
    a.cloudEnabled === b.cloudEnabled &&
    a.cloudSyncOnChange === b.cloudSyncOnChange &&
    a.cloudIntervalMinutes === b.cloudIntervalMinutes &&
    a.cloudClientId === b.cloudClientId &&
    a.cloudClientSecret === b.cloudClientSecret
  );
}

function installExitFlush(): void {
  removeExitFlush();
  let started = false;
  exitFlushListener = () => {
    if (started || !engine) {
      return;
    }
    started = true;
    // Best effort: the launcher does not expose a quit event to extensions.
    // beforeExit lets async work finish if Electron gets this far.
    const activeEngine = engine;
    void activeEngine.syncAll('backup')
      .then(() => {
        if (runtimeConfig.cloudEnabled && cloud?.configured) {
          return cloud.sync();
        }
        return undefined;
      })
      .catch(error => {
        logger.error(`Exit backup failed: ${errorMessage(error)}`);
      });
  };
  process.once('beforeExit', exitFlushListener);
}

function removeExitFlush(): void {
  if (exitFlushListener) {
    process.removeListener('beforeExit', exitFlushListener);
    exitFlushListener = null;
  }
}

function disposeWatcher(): void {
  if (watcher) {
    watcher.dispose();
    watcher = null;
  }
}

function restartBackupTimer(): void {
  if (backupTimer) {
    clearInterval(backupTimer);
    backupTimer = null;
  }
  if (!engine || runtimeConfig.backupIntervalMinutes <= 0) {
    return;
  }
  const activeEngine = engine;
  backupTimer = setInterval(() => {
    void activeEngine.syncAll('backup').catch(error => {
      logger.error(`Scheduled backup failed: ${errorMessage(error)}`);
    });
  }, runtimeConfig.backupIntervalMinutes * 60_000);
  backupTimer.unref?.();
}

async function migrateLegacyConflictPolicy(): Promise<void> {
  if (readString('fpdt.conflictPolicy', '') !== 'remote') {
    return;
  }
  try {
    await flashpoint.setExtConfigValue('fpdt.conflictPolicy', 'flashpoint');
  } catch (error) {
    // The legacy value is still normalized by readConflictPolicy.
    logger.warn(`Could not migrate the conflict policy: ${errorMessage(error)}`);
  }
}

function readConfig(): RuntimeConfig {
  const configuredProfile = readString('fpdt.profile', '');
  return {
    profile: sanitizeProfileName(configuredProfile || currentWindowsProfile()),
    syncOnStartup: readBoolean('fpdt.syncOnStartup', true),
    restoreBeforeLaunch: readBoolean('fpdt.restoreBeforeLaunch', true),
    backupOnFileChange: readBoolean('fpdt.backupOnFileChange', true),
    backupIntervalMinutes: readInterval('fpdt.backupIntervalMinutes', 5, 1440),
    conflictPolicy: readConflictPolicy('fpdt.conflictPolicy'),
    safetyBackups: readBoolean('fpdt.safetyBackups', true),
    cloudEnabled: readBoolean('fpdt.cloudSync', false),
    cloudSyncOnChange: readBoolean('fpdt.cloudSyncOnChange', true),
    cloudIntervalMinutes: readInterval('fpdt.cloudIntervalMinutes', 15, 1440),
    cloudClientId: readString('fpdt.cloudClientId', ''),
    cloudClientSecret: readString('fpdt.cloudClientSecret', ''),
  };
}

function readBoolean(key: string, fallback: boolean): boolean {
  const value = flashpoint.getExtConfigValue(key);
  return typeof value === 'boolean' ? value : fallback;
}

function readString(key: string, fallback: string): string {
  const value = flashpoint.getExtConfigValue(key);
  return typeof value === 'string' ? value.trim() : fallback;
}

function readInterval(key: string, fallback: number, max: number): number {
  const raw = readString(key, String(fallback));
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return Math.min(parsed, max);
}

function readConflictPolicy(key: string): ConflictPolicy {
  const raw = readString(key, 'newest');
  if (raw === 'flashpoint' || raw === 'remote') {
    return 'remote';
  }
  return raw === 'local' ? 'local' : 'newest';
}
