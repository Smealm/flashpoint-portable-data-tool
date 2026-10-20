# FPDT — Flashpoint Portable Data Tool

A [Flashpoint](https://flashpointarchive.org/) Launcher extension that makes Flashpoint's **non-portable data somewhat portable**.

Flashpoint itself lives in one folder and can be moved easily. A lot of the data you actually care about does not.
Games write saves to fixed Windows folders, and playlists and themes live in places that are easy to lose when you
move or reinstall Flashpoint.

FPDT keeps a copy of that data inside your Flashpoint folder, restores it automatically, and can optionally back
the whole lot up to your own Google Drive.

> Windows only.

## What it does

- **Keeps game saves with Flashpoint.** It finds save data that games write outside the Flashpoint folder, copies
  it into the folder, and puts it back before you play.
- **Backs up while you play.** When a game writes a save, FPDT updates the portable copy shortly afterwards.
- **Works with Windows accounts.** Each Windows user gets their own profile, plus one shared profile for
  machine-wide data.
- **Makes moving Flashpoint easier.** Copy the Flashpoint folder to another PC, pick or copy the right profile,
  and the save data comes with it.
- **Optionally backs up to Google Drive.** Saves, playlists, themes, and a few Flashpoint app files can go to a
  private app folder in your own Drive.

### What "somewhat portable" means

The data still has to live in the fixed Windows folders while a game is running. FPDT just keeps a portable copy
elsewhere and keeps the two in step. If you copy only the Flashpoint folder and leave FPDT's data behind, FPDT
cannot recover it.

## Why it exists

Some Flashpoint data is **unrecoverable** if it is lost:

- Save data that games insist on writing to `%APPDATA%`, `%USERPROFILE%\AppData\LocalLow`, or `%PROGRAMDATA%`.
- Playlists you made yourself. If they are not online anywhere, losing them means recreating them by hand.
- Playlists you downloaded may be re-findable, but you still have to source and place them again.

Some data is **recoverable but annoying**:

- Community themes are often hard to find again and tedious to reinstall. FPDT backs those up too.

## What it does not do

- It does not make games or the Flashpoint collection itself portable, and it does not back up game files.
- It does not recover data that was never saved by FPDT or never uploaded to the cloud.
- It does not sync deletions. If you delete a tracked save, profile, or playlist, FPDT may restore it on the next
  sync. That is deliberate: it is safer than copying a deletion everywhere.
- It does not touch other files in your Google Drive. Cloud sync uses only the hidden app data folder, and only
  the paths listed below.
- It does not work on macOS or Linux.

## Install

1. Download the latest release zip.
2. Extract it into `Data/Extensions/FPDT` inside your Flashpoint folder. The folder name must be `FPDT`.
3. Start Flashpoint. FPDT creates its folders and runs the first sync automatically.

The zip contains everything needed to run: `package.json`, `dist/`, and this README. The source code and tests are
in the GitHub repository.

To build from source: `npm install`, then `npm run build`.

## Using it

Open **Config → FPDT - Portable Save Data → Save Data Manager**.

From there you can:

- sync all save data now
- choose, copy, deploy, or delete a profile
- sync or deploy the shared system data
- connect Google Drive and sync the cloud backup
- open the folders FPDT uses

The manager shows what is tracked in Windows and what is stored in the Flashpoint folder, with clear labels for
each. In the UI, **local** means this PC's Windows folders and **Flashpoint** means the portable copy.

There is also a command line for offline use:

```
node dist/cli.js status
node dist/cli.js sync
node dist/cli.js backup
node dist/cli.js deploy <profile>
node dist/cli.js cloud status
node dist/cli.js cloud sync
```

Run `node dist/cli.js help` for all commands.

## Cloud sync (optional)

Cloud sync is off by default. It uses **your own** Google Cloud project, so there is no FPDT account or server in
the middle.

1. In the Google Cloud console, create a project and enable the **Google Drive API**.
2. Create an OAuth client of type **Desktop app**.
3. Put its client ID and client secret into FPDT's config.
4. Enable **Cloud Sync**, open the manager, and choose **Cloud sync... → Connect Google Drive**.

The browser opens Google's consent screen. FPDT requests one permission:
`https://www.googleapis.com/auth/drive.appdata`. That permission can only see FPDT's own hidden folder. It cannot
see or change the rest of your Drive.

### What gets backed up

- All FPDT save profiles and the shared system data
- `Data/Playlists`
- `Data/Themes` (can be large; the first upload takes longer)
- Flashpoint Navigator's `webappsstore.sqlite`
- Portable Shockwave preferences for PJ851 and PJ9
- The `Legacy` folders of games that saved to their original online servers rather than to a normal save folder

These are the exact paths, relative to your Flashpoint folder:

```
Data/Playlists/
Data/Themes/
Data/Extensions/FPDT/profiles/
Data/Extensions/FPDT/.global/
FPSoftware/fpnavigator-portable/User/flashpointnavigator/Profiles/Default/webappsstore.sqlite
FPSoftware/Shockwave/PJ851/Prefs/
FPSoftware/Shockwave/PJ9/Prefs/
Legacy/cgi-bin/www.xgenstudios.com/motherload/savedata/
Legacy/cgi-bin/api.xgenstudios.com/stickrpg2/
Legacy/cgi-bin/www.elementsthegame.com/saves/
Legacy/htdocs/www.pom-baer.at/spiele/weltenbauer/welten/
Legacy/htdocs/httpsmynk.ninjakiwi.com/database/userdata/
Legacy/htdocs/awesomehouseparty.com/house/bfahp.sqlite
Legacy/htdocs/www.dinodan.com/DinoDan.db
Legacy/htdocs/api.tetrisfriends.com/_backend/users/
Legacy/htdocs/www.sensoryworld.org/amf/users.json
Legacy/htdocs/pbskids.org/designsquad/games/fidgit/php/fidgit.db
```

That covers MotherLoad, Stick RPG 2, Elements, POM-BÄR Weltenbauer, Bloons Super Monkey 2, Big Fat Awesome
House Party, Dino Dan, Tetris Friends Battle 2P, Sensory World, and DESIGNit BUILDit FIDGit. The `Legacy` saves are
listed on [Flashpoint's save data page](https://flashpointarchive.org/datahub/Save_Data_Locations).

If your collection nests the portable files inside a `Flashpoint` subfolder, the same paths are found there
instead. Nothing else is uploaded or restored.

### How it behaves

- The cloud copy is applied **to the Flashpoint folder**, then the normal sync applies it to Windows. Cloud sync
  never writes Windows save files directly.
- If there is no cloud backup manifest yet, or no FPDT cloud manifest, **the cloud copy wins and is laid over the
  Flashpoint folder**. That is what makes an existing backup actually apply.
- Later conflicts use the newest file; ties go to the cloud. Overwritten versions are kept in
  `Data/Extensions/FPDT/.cloud-conflicts` when safety backups are enabled.
- Before launch, FPDT first pulls cloud changes, then does its normal sync. Automatic uploads happen in the
  background.
- Deleting something locally does not delete the cloud copy. To remove cloud data, use Google Drive's
  **Settings → Manage apps → Delete hidden app data**.

## What is stored where

Inside the Flashpoint folder:

```
Data/Extensions/FPDT/
  profiles/<Windows account>/   save data for that Windows account
  .global/                     shared machine-wide data
  cloud.json                   cloud sync's record of what was agreed
  .conflicts/                  overwritten save files kept for safety
  .cloud-conflicts/            overwritten files from cloud sync
```

On this Windows account:

```
%LOCALAPPDATA%\FPDT\
  <profile>.json     this machine's copy of the save-data state
  .global.json       this machine's copy of the system state
  cloud-token.json   Google Drive access token, only when connected
  .cloud-tmp\        temporary upload copies, removed after use
```

FPDT keeps its own files in the locations above. It reads and writes the documented Windows save folders, and
only when cloud sync is connected, the Google app data folder. No other permanent locations are modified.

## Good to know

- Keep one Flashpoint instance per folder. Two copies writing the same profiles can race.
- Cloud sync is tied to the Google account and OAuth client that created the backup. Changing the client ID hides
  the old backup from the new client until you switch back.
- Google OAuth projects left in **Testing** mode expire refresh tokens after 7 days. Set the project to
  **In production** to avoid reconnecting every week.
- `Data/Themes` can be big. The first cloud upload sends it once; later syncs only send changes.
- Windows may deny writes under `%PROGRAMDATA%` if an installer locked down a folder. Running Flashpoint once as
  administrator usually fixes the folder permissions.

## Development

Requires Node 18+ and TypeScript.

```
npm install
npm run build
npm run typecheck
npm test
```

`npm test` builds the extension and runs the sync, cloud, and launcher-wiring tests.
