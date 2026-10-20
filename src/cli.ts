import * as path from 'path';
import {
  currentWindowsProfile,
  getDefaultRoots,
  getDefaultStateRoot,
  isWindows,
  sanitizeProfileName,
} from './core/targets';
import { SyncEngine, SYSTEM_DIR_NAME } from './core/sync';
import { ConflictPolicy, Logger, SyncAllResult, SyncResult } from './core/types';
import { errorMessage } from './core/io';
import { CLOUD_MANIFEST_FILE, CloudEngine, CloudSyncResult } from './core/cloud';
import { GoogleDriveTransport, openExternalUrl } from './core/gdrive';

interface Flags {
  profile?: string;
  archive?: string;
  system?: string;
  state?: string;
  policy?: ConflictPolicy;
  root?: string;
  clientId?: string;
  clientSecret?: string;
  force: boolean;
  local: boolean;
  scan: boolean;
  profiles: boolean;
  help: boolean;
}

const logger: Logger = {
  debug: message => console.debug(`[debug] ${message}`),
  info: message => console.log(message),
  warn: message => console.warn(`[warn] ${message}`),
  error: message => console.error(`[error] ${message}`),
};

const USAGE = `Flashpoint Portable Data Tool - command line

Usage:
  node dist/cli.js <command> [arguments] [options]

Commands:
  status                  Show the active profile, system data and file counts
  list                    List Flashpoint profiles
  sync                    Sync local and Flashpoint data (full two-way)
  backup                  Upload changes from both partitions (never downloads)
  deploy <profile>        Apply a Flashpoint profile to this machine (Flashpoint wins)
  copy <from> <to>        Copy a profile inside the Flashpoint folder (--force to replace)
  delete <profile>        Delete a profile from the Flashpoint folder (--local to also delete its local files)
  system [subcommand]     Manage the system-level ProgramData partition:
                          status | sync | backup | deploy | delete [--local]
  cloud [subcommand]      Optional scoped Google Drive backup:
                          status | sync | login | logout

Options:
  --profile <name>        Profile to use (default: current Windows account)
  --flashpoint <path>     Flashpoint root (default: <extension>/profiles)
  --archive <path>        Alias for --flashpoint
  --system <path>         System partition folder (default: <extension>/.global)
  --state <path>          Local state folder (default: %LOCALAPPDATA%/FPDT)
  --root <path>           Flashpoint root for cloud sync (default: inferred)
  --client-id <id>        Google Drive desktop app client ID (cloud only)
  --client-secret <secret>
                          Google Drive desktop app client secret (cloud only)
  --policy <newest|flashpoint|local>
                          Conflict resolution for this run
  --force                 Allow copy to replace an existing profile
  --local                 Also delete local files tracked by the selected partition's manifest
  --scan                  Count files on disk instead of using the tracked manifests
  --profiles              Include per-profile counts in status (reads every profile manifest)
  --help                  Show this text
`;

async function main(): Promise<number> {
  if (!isWindows()) {
    console.error('FPDT only supports Windows machines.');
    return 1;
  }

  const { command, positional, flags } = parseArgs(process.argv.slice(2));
  if (flags.help || command === 'help' || command === undefined) {
    console.log(USAGE);
    return command === undefined && !flags.help ? 2 : 0;
  }

  const archiveRoot = flags.archive
    ? path.resolve(flags.archive)
    : path.resolve(__dirname, '..', 'profiles');
  const systemRoot = flags.system
    ? path.resolve(flags.system)
    : path.resolve(__dirname, '..', SYSTEM_DIR_NAME);
  const stateDir = flags.state ? path.resolve(flags.state) : getDefaultStateRoot();
  const profile = sanitizeProfileName(flags.profile || currentWindowsProfile());

  const engine = new SyncEngine({
    archiveRoot,
    systemRoot,
    stateDir,
    roots: getDefaultRoots(),
    profile,
    conflictPolicy: flags.policy ?? 'newest',
    safetyBackups: true,
    logger,
  });

  switch (command) {
    case 'status': {
      const status = await engine.status({ scan: flags.scan, includeProfiles: flags.profiles });
      console.log(`Profile:      ${status.profile}`);
      console.log(`Flashpoint root: ${status.archiveRoot}`);
      console.log(`Local state:     ${status.localStatePath}`);
      console.log(`Local data:      ${status.localFileCount} files, ${formatBytes(status.localBytes)}`);
      console.log(`Flashpoint:      ${status.remoteFileCount} files, ${formatBytes(status.remoteBytes)}`);
      console.log(`Last sync:       local=${status.lastLocalSync ?? 'never'} flashpoint=${status.lastRemoteSync ?? 'never'}`);
      console.log('System data:');
      console.log(`  Folder:     ${status.system.archiveDir}`);
      console.log(`  Local:      ${status.system.localFileCount} files, ${formatBytes(status.system.localBytes)}`);
      console.log(`  Flashpoint: ${status.system.archiveFileCount} files, ${formatBytes(status.system.archiveBytes)}`);
      console.log(`  Last sync:  ${status.system.lastSync ?? 'never'}`);
      if (status.profiles.length > 0) {
        console.log('Profiles:');
        for (const entry of status.profiles) {
          console.log(
            `  ${entry.active ? '*' : ' '} ${entry.name.padEnd(24)} ${String(entry.fileCount).padStart(6)} files  ${formatBytes(entry.bytes)}`,
          );
        }
      }
      return 0;
    }
    case 'list': {
      const profiles = await engine.listProfiles();
      if (profiles.length === 0) {
        console.log('No Flashpoint profiles.');
      } else {
        for (const name of profiles) {
          console.log(name);
        }
      }
      return 0;
    }
    case 'sync': {
      printAll(await engine.syncAll('full'));
      return 0;
    }
    case 'backup': {
      printAll(await engine.syncAll('backup'));
      return 0;
    }
    case 'deploy': {
      const name = positional[0];
      if (!name) {
        console.error('deploy requires a profile name.\n');
        console.log(USAGE);
        return 2;
      }
      printResult(await engine.deploy(name));
      console.log(`Active profile for this run: ${name}. Pass --profile ${name} to later CLI commands.`);
      return 0;
    }
    case 'copy': {
      const [from, to] = positional;
      if (!from || !to) {
        console.error('copy requires source and destination profile names.\n');
        console.log(USAGE);
        return 2;
      }
      const result = await engine.copyProfile(from, to, { overwrite: flags.force });
      console.log(`Copied "${result.from}" to "${result.to}" (${result.copiedFiles} files).`);
      return 0;
    }
    case 'delete': {
      const name = positional[0];
      if (!name) {
        console.error('delete requires a profile name.\n');
        console.log(USAGE);
        return 2;
      }
      const result = await engine.deleteProfile(name, { deleteLocalData: flags.local });
      console.log(
        `Deleted "${result.profile}" (${result.deletedArchiveFiles} Flashpoint files, ${result.deletedLocalFiles} local files).`,
      );
      return 0;
    }
    case 'cloud': {
      const action = positional[0] ?? 'status';
      const root = flags.root
        ? path.resolve(flags.root)
        : path.resolve(__dirname, '..', '..', '..', '..');
      const clientId = flags.clientId || process.env.FPDT_GOOGLE_CLIENT_ID || '';
      const clientSecret = flags.clientSecret || process.env.FPDT_GOOGLE_CLIENT_SECRET || '';
      const transport = clientId && clientSecret
        ? new GoogleDriveTransport(
          { clientId, clientSecret },
          path.join(stateDir, 'cloud-token.json'),
          logger,
        )
        : null;
      const cloud = new CloudEngine({
        root,
        manifestPath: path.join(__dirname, '..', CLOUD_MANIFEST_FILE),
        stateDir,
        safetyBackups: true,
        transport,
        logger,
      });

      switch (action) {
        case 'status': {
          const status = await cloud.status();
          console.log(`Flashpoint root:   ${status.root}`);
          console.log(`Cloud manifest:    ${status.manifestPath}`);
          console.log(`Config:            ${status.configured ? 'client ID and secret set' : 'not configured'}`);
          console.log(`Google Drive:      ${status.connected ? 'connected' : 'not connected'}`);
          console.log(`Flashpoint copy:   ${status.flashpointFileCount} files, ${formatBytes(status.flashpointBytes)}`);
          console.log(`Cloud backup:      ${status.cloudFileCount} files, ${formatBytes(status.cloudBytes)}`);
          console.log(`Last cloud sync:   ${status.lastSync ?? 'never'}`);
          if (status.error) {
            console.log(`Error:             ${status.error}`);
          }
          console.log('Scope:');
          for (const entry of status.scope) {
            console.log(`  ${entry}`);
          }
          return 0;
        }
        case 'sync': {
          printCloudResult(await cloud.sync());
          return 0;
        }
        case 'login': {
          if (!transport) {
            console.error('cloud login requires --client-id and --client-secret (or FPDT_GOOGLE_CLIENT_ID / FPDT_GOOGLE_CLIENT_SECRET).');
            return 2;
          }
          await transport.login(openExternalUrl);
          printCloudResult(await cloud.sync());
          return 0;
        }
        case 'logout': {
          if (transport) {
            await transport.logout();
          }
          console.log('Disconnected cloud sync from Google Drive. The cloud backup was not deleted.');
          return 0;
        }
        default:
          console.error(`Unknown cloud subcommand: ${action}\n`);
          console.log(USAGE);
          return 2;
      }
    }
    case 'system': {
      const action = positional[0] ?? 'status';
      switch (action) {
        case 'status': {
          const status = await engine.status({ scan: flags.scan });
          console.log(`System folder: ${status.system.archiveDir}`);
          console.log(`Local state:   ${status.system.localStatePath}`);
          console.log(`Local data:    ${status.system.localFileCount} files, ${formatBytes(status.system.localBytes)}`);
          console.log(`Flashpoint:    ${status.system.archiveFileCount} files, ${formatBytes(status.system.archiveBytes)}`);
          console.log(`Last sync:     ${status.system.lastSync ?? 'never'}`);
          return 0;
        }
        case 'sync':
          printResult(await engine.syncSystem('full'));
          return 0;
        case 'backup':
          printResult(await engine.syncSystem('backup'));
          return 0;
        case 'deploy':
          printResult(await engine.deploySystem());
          return 0;
        case 'delete': {
          const result = await engine.deleteSystem({ deleteLocalData: flags.local });
          console.log(
            `Deleted system data (${result.deletedArchiveFiles} Flashpoint files, ${result.deletedLocalFiles} local files).`,
          );
          return 0;
        }
        default:
          console.error(`Unknown system subcommand: ${action}\n`);
          console.log(USAGE);
          return 2;
      }
    }
    default: {
      console.error(`Unknown command: ${command}\n`);
      console.log(USAGE);
      return 2;
    }
  }
}

function parseArgs(argv: string[]): { command?: string; positional: string[]; flags: Flags } {
  const flags: Flags = { force: false, local: false, scan: false, profiles: false, help: false };
  const positional: string[] = [];
  let command: string | undefined;

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    switch (arg) {
      case '--profile':
        flags.profile = argv[++index];
        break;
      case '--archive':
      case '--flashpoint':
        flags.archive = argv[++index];
        break;
      case '--system':
        flags.system = argv[++index];
        break;
      case '--state':
        flags.state = argv[++index];
        break;
      case '--root':
        flags.root = argv[++index];
        break;
      case '--client-id':
        flags.clientId = argv[++index];
        break;
      case '--client-secret':
        flags.clientSecret = argv[++index];
        break;
      case '--policy': {
        const value = argv[++index];
        if (value === 'flashpoint' || value === 'remote') {
          flags.policy = 'remote';
        } else if (value === 'newest' || value === 'local') {
          flags.policy = value;
        } else {
          throw new Error('--policy must be newest, flashpoint or local');
        }
        break;
      }
      case '--force':
        flags.force = true;
        break;
      case '--local':
        flags.local = true;
        break;
      case '--scan':
        flags.scan = true;
        break;
      case '--profiles':
        flags.profiles = true;
        break;
      case '--help':
      case '-h':
        flags.help = true;
        break;
      default:
        if (arg.startsWith('-')) {
          throw new Error(`Unknown option: ${arg}`);
        }
        if (command === undefined) {
          command = arg;
        } else {
          positional.push(arg);
        }
    }
  }

  return { command, positional, flags };
}

function printAll(result: SyncAllResult): void {
  console.log('Profile data:');
  printResult(result.profile);
  console.log('');
  console.log('System data:');
  printResult(result.system);
}

function printCloudResult(result: CloudSyncResult): void {
  if (result.firstSync) {
    console.log('First cloud sync: cloud data was laid over the Flashpoint folder.');
  }
  console.log(
    `uploaded=${result.uploaded} downloaded=${result.downloaded} conflicts=${result.conflicts} ` +
    `stashed=${result.stashed} errors=${result.errors}`,
  );
}

function printResult(result: SyncResult): void {
  if (result.firstSync) {
    console.log('First sync on this machine: Flashpoint data was restored before matching.');
  }
  console.log(
    `uploaded=${result.uploaded} downloaded=${result.downloaded} conflicts=${result.conflicts} ` +
    `deferred=${result.deferred} stashed=${result.stashed} errors=${result.errors}`,
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

main()
  .then(code => {
    process.exitCode = code;
  })
  .catch(error => {
    console.error(errorMessage(error));
    process.exitCode = 1;
  });
