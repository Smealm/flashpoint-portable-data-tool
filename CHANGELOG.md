# Changelog

All notable changes to FPDT are documented here. Versions follow
[semantic versioning](https://semver.org/); the extension targets Flashpoint
Launcher 12.2.0.

## [0.1.2] - 2026-10-20

Optimization release. Sync is much cheaper on repeat runs; the on-disk format,
settings and behaviour are unchanged, so existing installs need no migration.

### Changed

- Manifests are held in memory for the life of the launcher instead of being
  re-read and re-parsed on every sync, status query and manager redraw. Each
  read is validated against the file's size and modification time, so edits made
  by another process (the CLI, a second launcher) are still picked up, and
  concurrent loads of the same manifest share one read.
- Save data manager redraws and `status` calls no longer touch the disk once a
  manifest is resident.
- An unchanged sync no longer rewrites the manifest files. Previously a full
  sync that found nothing to do still rewrote every manifest it had loaded.
- Manifests are loaded once at launcher startup, before the startup sync, behind
  a short progress dialog. Startup shows what it is waiting for instead of
  appearing to idle; the dialog is skipped on launchers without dialog support
  and sync continues normally if it is dismissed.
- A failed sync drops the resident manifests, so the next attempt starts from a
  clean read rather than trusting possibly half-applied state.

### Notes

- Manifest format is unchanged (`MANIFEST_VERSION` 1), file contents are
  byte-identical apart from the `updatedAt` timestamp.
- Cold start is not faster: the first read of each manifest is still a full
  parse. The warmup only makes that visible and ordered.
- Resident manifests are capped and the least recently used ones are dropped
  first, so a large collection cannot grow memory without bound.

## [0.1.1] - 2026-10-20

### Added

- Cloud sync backs up the Flashpoint games that save inside the collection's own
  `Legacy` folder: Motherload, Stick RPG 2, Elements, Weltenbauer, Nitrome
  userdata, Awesome House Party, Dino Dan, Tetris Friends, Sensory World and
  Fidgit. Both the `Legacy/...` and nested `Flashpoint/Legacy/...` layouts are
  covered, and the README lists every path cloud sync handles.
- Existing installs pick the new paths up on the next cloud sync; no reinstall
  or re-connect is needed.

## [0.1.0] - 2026-10-20

First public release.

### Added

- Windows save data for each account, plus the shared machine-wide data, stored
  inside the Flashpoint folder.
- Automatic restore before a game starts and backups while you play.
- Per-account profiles for moving saves between machines, with copy, deploy and
  delete in the save data manager.
- Optional private Google Drive sync for saves, playlists, community themes,
  Flashpoint Navigator state and portable Shockwave preferences. Off by default,
  uses your own Google Cloud desktop OAuth client, and only touches its hidden
  app data folder.

[0.1.2]: https://github.com/Smealm/flashpoint-portable-data-tool/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/Smealm/flashpoint-portable-data-tool/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Smealm/flashpoint-portable-data-tool/releases/tag/v0.1.0
