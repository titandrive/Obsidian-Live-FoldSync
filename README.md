# Live Fold Sync

Obsidian plugin that syncs folded headings and lists between devices, including notes that are
already open (desktop and mobile). It replaces Sync Folds, which only restored folds the next
time a note was opened, and keeps its `data.json` format.

- Local fold changes are caught at `app.foldManager.savePath` and written to `data.json`.
- `data.json` changes from other devices are picked up via `onExternalSettingsChange` and by
  polling the file's mtime every 2s while the app is in the foreground (mobile doesn't always
  get the notification), then written to localStorage and applied to open notes with
  `view.currentMode.applyFoldInfo()`.
- If an open note can't take incoming folds yet (its text hasn't synced), they are retried when
  the note changes, and closing the note doesn't overwrite them with its old folds.

No build step: `main.js` is plain JavaScript. Install by copying `main.js` and `manifest.json`
to `<vault>/.obsidian/plugins/live-fold-sync/`.
