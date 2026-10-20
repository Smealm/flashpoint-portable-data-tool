import { spawn } from 'child_process';
import * as flashpoint from 'flashpoint-launcher';
import { CloudController, CloudSyncResult } from './core/cloud';
import { errorMessage } from './core/io';
import { SyncEngine } from './core/sync';
import { SyncAllResult, SyncResult, SyncStatus } from './core/types';

export interface ManagerHooks {
  /** Persist the active profile in the extension's config. */
  persistProfile(profile: string): Promise<void>;
  /** Optional Google Drive cloud sync. */
  cloud?: CloudController;
}

const CLOSE = 'Close';
const BACK = 'Back';

let managerOpen = false;

export async function openManager(engine: SyncEngine, hooks: ManagerHooks): Promise<void> {
  if (managerOpen) {
    return;
  }
  managerOpen = true;
  try {
    await mainMenu(engine, hooks);
  } catch (error) {
    flashpoint.log.error(`[FPDT] Manager failed: ${errorMessage(error)}`);
    await showInfo(`FPDT manager failed:\n\n${errorMessage(error)}`);
  } finally {
    managerOpen = false;
  }
}

async function mainMenu(engine: SyncEngine, hooks: ManagerHooks): Promise<void> {
  while (true) {
    const status = await engine.status({ includeProfiles: false });
    const choice = await choose(
      statusText(status),
      ['Sync now', 'Profiles...', 'System data...', 'Cloud sync...', CLOSE],
    );
    if (choice === 0) {
      await guarded(async () => {
        const result = await engine.syncAll('full');
        await showInfo(bundleText(result));
      });
    } else if (choice === 1) {
      await profilesMenu(engine, hooks);
    } else if (choice === 2) {
      await systemMenu(engine);
    } else if (choice === 3) {
      await cloudMenu(hooks);
    } else {
      return;
    }
  }
}

async function profilesMenu(engine: SyncEngine, hooks: ManagerHooks): Promise<void> {
  while (true) {
    const status = await engine.status({ includeProfiles: false });
    const names = await engine.listProfiles();
    const active = engine.profile.toLowerCase();
    const visible = names.slice(0, 10);
    const labels = visible.map(name => `${name.toLowerCase() === active ? '* ' : ''}${name}`);
    const needsName = names.length > visible.length;
    const buttons = [...labels, ...(needsName ? ['Enter profile name...'] : []), 'Copy profile...', CLOSE];
    const choice = await choose(
      `Profiles in:\n${status.archiveRoot}\n\n* = active profile on this machine.`,
      buttons,
    );

    if (choice < 0) {
      return;
    }
    if (choice < visible.length) {
      await profileMenu(engine, hooks, visible[choice]);
      continue;
    }
    let index = visible.length;
    if (needsName) {
      if (choice === index) {
        const name = await askText('Profile name', 'Profile', '');
        if (name) {
          await profileMenu(engine, hooks, name);
        }
        continue;
      }
      index++;
    }
    if (choice === index) {
      await copyFlow(engine);
      continue;
    }
    return;
  }
}

async function profileMenu(engine: SyncEngine, hooks: ManagerHooks, name: string): Promise<void> {
  while (true) {
    const profile = await engine.profileSummary(name);
    const summary = `${profile.fileCount} files, ${formatBytes(profile.bytes)}\n` +
      `Last Flashpoint update: ${profile.lastSync ?? 'never'}`;
    const choice = await choose(
      `Profile "${name}"\n\n${summary}\n\n` +
      'Deploy writes the Flashpoint copy over this machine\'s save data (Flashpoint wins). ' +
      'Use makes this the profile that is synced from now on.',
      ['Use on this machine', 'Deploy to this machine', 'Copy...', 'Delete...', BACK],
    );

    if (choice === 0) {
      await guarded(async () => {
        await hooks.persistProfile(name);
        engine.setProfile(name);
        const result = await engine.sync('full');
        await showInfo(`Now using profile "${name}".\n\n${resultText(result)}`);
      });
    } else if (choice === 1) {
      const confirmed = await choose(
        `Deploy profile "${name}" to this machine?\n\n` +
        'Every file in the Flashpoint copy is written over the local copy. Local-only save files are kept and backed up. ' +
        'Overwritten files are kept in the profile\'s .conflicts folder when safety backups are enabled.',
        ['Deploy', 'Cancel'],
      );
      if (confirmed === 0) {
        await guarded(async () => {
          const result = await engine.deploy(name);
          await hooks.persistProfile(name);
          await showInfo(`Deployed profile "${name}".\n\n${resultText(result)}`);
        });
      }
    } else if (choice === 2) {
      await copyFlow(engine, name);
    } else if (choice === 3) {
      await deleteFlow(engine, name);
    } else {
      return;
    }
  }
}

async function systemMenu(engine: SyncEngine): Promise<void> {
  while (true) {
    const status = await engine.status();
    const system = status.system;
    const choice = await choose(
      `System data (ProgramData)\n\n` +
      `Local ProgramData: ${system.localFileCount} files, ${formatBytes(system.localBytes)}\n` +
      `Flashpoint: ${system.archiveFileCount} files, ${formatBytes(system.archiveBytes)}\n` +
      `Last Flashpoint update: ${system.lastSync ?? 'never'}\n` +
      `Flashpoint folder:\n${system.archiveDir}\n\n` +
      'This partition is shared by every Windows account. It is stored outside the profiles and is never copied by profile copy or deploy.',
      ['Sync system data', 'Deploy system data (Flashpoint wins)', 'Delete system data...', 'Open system folder', BACK],
    );

    if (choice === 0) {
      await guarded(async () => {
        const result = await engine.syncSystem('full');
        await showInfo(`System data sync complete.\n\n${resultText(result)}`);
      });
    } else if (choice === 1) {
      const confirmed = await choose(
        'Deploy Flashpoint system data over this machine?\n\n' +
        'Every file in the Flashpoint copy is written over the live copy. Local-only files are kept and backed up. ' +
        'Overwritten files are kept in the system partition\'s .conflicts folder when safety backups are enabled.',
        ['Deploy', 'Cancel'],
      );
      if (confirmed === 0) {
        await guarded(async () => {
          const result = await engine.deploySystem();
          await showInfo(`Deployed system data.\n\n${resultText(result)}`);
        });
      }
    } else if (choice === 2) {
      await deleteSystemFlow(engine);
    } else if (choice === 3) {
      openFolder(system.archiveDir);
    } else {
      return;
    }
  }
}

async function cloudMenu(hooks: ManagerHooks): Promise<void> {
  const cloud = hooks.cloud;
  if (!cloud) {
    await showInfo('Cloud sync is not available in this build.');
    return;
  }

  while (true) {
    let status;
    try {
      status = await cloud.status();
    } catch (error) {
      await showInfo(`Could not read the cloud status:\n\n${errorMessage(error)}`);
      return;
    }

    const lines = [
      'Cloud sync (Google Drive, app data folder only)',
      '',
      `Config: ${status.configured ? 'client ID and secret set' : 'no client ID / secret'}`,
      `Google Drive: ${status.connected ? 'connected' : 'not connected'}`,
      `Tracked in Flashpoint: ${status.flashpointFileCount} files, ${formatBytes(status.flashpointBytes)}`,
      `Cloud backup: ${status.cloudFileCount} files, ${formatBytes(status.cloudBytes)}`,
      `Last cloud sync: ${status.lastSync ?? 'never'}`,
      '',
      'Scope (relative to the Flashpoint folder):',
      ...status.scope.map(entry => `  ${entry}`),
      '',
      'Only the hidden, app-private Google Drive folder is ever accessed. Other Drive files cannot be seen or changed.',
    ];
    if (!status.configured) {
      lines.push('', 'Set the Google Drive client ID and client secret in Config to enable it.');
    }
    if (status.error) {
      lines.push('', `Last error: ${status.error}`);
    }

    const buttons = ['Sync now'];
    if (status.configured) {
      buttons.push(status.connected ? 'Reconnect Google Drive...' : 'Connect Google Drive...');
      if (status.connected) {
        buttons.push('Disconnect Google Drive');
      }
    }
    buttons.push(BACK);

    const choice = await choose(lines.join('\n'), buttons);
    if (choice === 0) {
      await guarded(async () => {
        const result = await cloud.sync();
        await showInfo(cloudResultText(result));
      });
    } else if (choice === 1 && status.configured) {
      await guarded(async () => {
        await cloud.login();
        await showInfo('Cloud sync is connected to Google Drive.\n\nOnly the hidden FPDT app data folder is used.');
      });
    } else if (choice === 2 && status.connected) {
      const confirm = await choose(
        'Disconnect cloud sync from Google Drive?\n\nThis removes FPDT\'s stored token from this Windows account. ' +
        'The cloud backup itself is not deleted. You can reconnect at any time.',
        ['Disconnect', 'Cancel'],
      );
      if (confirm === 0) {
        await guarded(async () => {
          await cloud.logout();
          await showInfo('Disconnected from Google Drive. The cloud backup was not deleted.');
        });
      }
    } else {
      return;
    }
  }
}

function cloudResultText(result: CloudSyncResult): string {
  return (
    (result.firstSync ? 'First cloud sync: cloud data was laid over the Flashpoint folder.\n\n' : '') +
    `Uploaded to cloud: ${result.uploaded}\n` +
    `Downloaded from cloud: ${result.downloaded}\n` +
    `Conflicts: ${result.conflicts}\n` +
    `Conflict copies kept: ${result.stashed}\n` +
    `Errors: ${result.errors}`
  );
}

async function deleteSystemFlow(engine: SyncEngine): Promise<void> {
  const choice = await choose(
    'Delete the system data partition?\n\n' +
    '"Delete Flashpoint copy only" removes the copy stored in the Flashpoint folder.\n' +
    '"Delete Flashpoint copy and local files" also removes the live ProgramData files listed in the system manifest.',
    ['Delete Flashpoint copy only', 'Delete Flashpoint copy and local files', 'Cancel'],
  );
  if (choice !== 0 && choice !== 1) {
    return;
  }

  if (choice === 1) {
    const confirm = await choose(
      'Delete the live ProgramData files tracked by the system partition?\n\nThis cannot be undone.',
      ['Delete local files', 'Cancel'],
    );
    if (confirm !== 0) {
      return;
    }
  }

  await guarded(async () => {
    const result = await engine.deleteSystem({ deleteLocalData: choice === 1 });
    await showInfo(
      'Deleted the system data partition.\n\n' +
      `Flashpoint files removed: ${result.deletedArchiveFiles}\n` +
      `Local files removed: ${result.deletedLocalFiles}`,
    );
  });
}

async function copyFlow(engine: SyncEngine, presetSource?: string): Promise<void> {
  const source = presetSource ?? (await pickProfile(engine, 'Copy which profile?'));
  if (!source) {
    return;
  }
  const destination = await askText(`Copy "${source}" to a new profile`, 'New profile name', `${source}-copy`);
  if (!destination) {
    return;
  }

  const existing = (await engine.listProfiles()).some(p => p.toLowerCase() === destination.toLowerCase());
  if (existing) {
    const confirm = await choose(
      `Profile "${destination}" already exists. Replace it?\n\nThis deletes the existing Flashpoint folder for that profile.`,
      ['Replace', 'Cancel'],
    );
    if (confirm !== 0) {
      return;
    }
  }

  await guarded(async () => {
    const result = await engine.copyProfile(source, destination, { overwrite: existing });
    await showInfo(`Copied "${result.from}" to "${result.to}" (${result.copiedFiles} files).`);
  });
}

async function deleteFlow(engine: SyncEngine, name: string): Promise<void> {
  const active = engine.profile.toLowerCase() === name.toLowerCase();
  const activeNote = active
    ? '\n\nThis is the active profile. It will be recreated from any remaining local data on the next sync.'
    : '';
  const choice = await choose(
    `Delete profile "${name}"?\n\n` +
    '"Delete Flashpoint copy only" removes the copy stored in the Flashpoint folder.\n' +
    '"Delete Flashpoint copy and local files" also removes local save files listed in this profile\'s manifest.' +
    activeNote,
    ['Delete Flashpoint copy only', 'Delete Flashpoint copy and local files', 'Cancel'],
  );
  if (choice !== 0 && choice !== 1) {
    return;
  }

  if (choice === 1) {
    const confirm = await choose(
      `Delete the local save files tracked by profile "${name}"?\n\nThis cannot be undone.`,
      ['Delete local files', 'Cancel'],
    );
    if (confirm !== 0) {
      return;
    }
  }

  await guarded(async () => {
    const result = await engine.deleteProfile(name, { deleteLocalData: choice === 1 });
    await showInfo(
      `Deleted profile "${result.profile}".\n\n` +
      `Flashpoint files removed: ${result.deletedArchiveFiles}\n` +
      `Local files removed: ${result.deletedLocalFiles}`,
    );
  });
}

async function pickProfile(engine: SyncEngine, title: string): Promise<string | null> {
  const profiles = await engine.listProfiles();
  if (profiles.length === 0) {
    await showInfo('There are no Flashpoint profiles yet.');
    return null;
  }
  const visible = profiles.slice(0, 10);
  const choice = await choose(title, [...visible, 'Cancel']);
  if (choice < 0 || choice >= visible.length) {
    return null;
  }
  return visible[choice];
}

async function guarded(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    flashpoint.log.error(`[FPDT] ${errorMessage(error)}`);
    await showInfo(`Operation failed:\n\n${errorMessage(error)}`);
  }
}

async function choose(message: string, buttons: string[]): Promise<number> {
  return flashpoint.dialogs.showMessageBox({
    message,
    buttons,
    cancelId: buttons.length - 1,
    userCanCancel: true,
  });
}

async function showInfo(message: string): Promise<void> {
  await flashpoint.dialogs.showMessageBox({ message, buttons: ['OK'], userCanCancel: true });
}

async function askText(message: string, label: string, initial: string): Promise<string | null> {
  const handle = await flashpoint.dialogs.showMessageBoxWithHandle({
    message,
    buttons: ['OK', 'Cancel'],
    cancelId: 1,
    userCanCancel: true,
    fields: [{ type: 'string', name: 'value', message: label, value: initial }],
  });
  const response = await flashpoint.dialogs.awaitDialog(handle);
  if (response.buttonIdx !== 0) {
    return null;
  }
  const field = response.dialog.fields?.find(field => field.name === 'value');
  return field && field.type === 'string' ? field.value.trim() : null;
}

function openFolder(folder: string): void {
  try {
    const child = spawn('explorer.exe', [folder], { detached: true, stdio: 'ignore' });
    child.unref();
  } catch (error) {
    flashpoint.log.warn(`[FPDT] Could not open ${folder}: ${errorMessage(error)}`);
  }
}

function statusText(status: SyncStatus): string {
  return (
    `FPDT — Portable Save Data\n\n` +
    `Active profile: ${status.profile}\n` +
    `Profile local: ${status.localFileCount} files, ${formatBytes(status.localBytes)}\n` +
    `Profile Flashpoint: ${status.remoteFileCount} files, ${formatBytes(status.remoteBytes)}\n` +
    `System local: ${status.system.localFileCount} files, ${formatBytes(status.system.localBytes)}\n` +
    `System Flashpoint: ${status.system.archiveFileCount} files, ${formatBytes(status.system.archiveBytes)}\n` +
    `Last local sync: ${status.lastLocalSync ?? 'never'}\n` +
    `Flashpoint folder:\n${status.archiveRoot}\n\n` +
    `System Flashpoint folder:\n${status.system.archiveDir}`
  );
}

function bundleText(result: SyncAllResult): string {
  return `Profile data:\n${resultText(result.profile)}\n\nSystem data:\n${resultText(result.system)}`;
}

function resultText(result: SyncResult): string {
  return (
    `Uploaded: ${result.uploaded}\n` +
    `Downloaded: ${result.downloaded}\n` +
    `Conflicts: ${result.conflicts}\n` +
    `Deferred until next full sync: ${result.deferred}\n` +
    `Conflict copies kept: ${result.stashed}\n` +
    `Errors: ${result.errors}`
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}
