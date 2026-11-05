/*
 * Live Fold Sync: keeps heading/list fold state in sync between devices, including notes
 * that are already open.
 *
 * Obsidian keeps each note's folds in localStorage (`${appId}-note-fold-${path}`) through
 * app.foldManager, which every open note calls (debounced 500ms) after a fold change and
 * when it is closed. This plugin hooks foldManager.savePath to copy local changes into its
 * data.json (synced by Obsidian Sync or any other file sync), and watches data.json for
 * changes from other devices, which it writes to localStorage and applies to open notes.
 *
 * data.json keeps the Sync Folds format, so its data carries over:
 *   { "enableSync": true, "folds": "<JSON string of { path: { folds: [{from, to}], lines } }>" }
 */
const { Plugin, MarkdownView, Notice, debounce } = require("obsidian");

const POLL_MS = 2000;
const WRITE_DELAY_MS = 300;
const LEGACY_DATA = "plugins/sync-folds/data.json";

// Fold infos are equal when the same lines are folded; `to` can differ between devices
// because Obsidian recomputes it from the document.
function sameFolds(a, b) {
	if (!a || !a.folds.length) return !b || !b.folds.length;
	if (!b || !b.folds.length) return false;
	if (a.lines !== b.lines) return false;
	const af = a.folds.map((f) => f.from).sort((x, y) => x - y);
	const bf = b.folds.map((f) => f.from).sort((x, y) => x - y);
	return af.length === bf.length && af.every((v, i) => v === bf[i]);
}

function parseFolds(data) {
	try {
		const folds = JSON.parse(data && data.folds ? data.folds : "{}");
		return folds && typeof folds === "object" ? folds : {};
	} catch (e) {
		console.error("Live Fold Sync: unreadable folds in data.json", e);
		return null;
	}
}

module.exports = class LiveFoldSync extends Plugin {
	async onload() {
		this.folds = {}; // path -> fold info, as last read from or written to data.json
		this.dirty = new Set(); // paths changed on this device and not yet written
		this.lastLocal = {}; // path -> folds open notes on this device last showed
		this.pending = {}; // path -> incoming folds that an open note could not take yet
		this.lastRaw = null; // data.json text as last read or written, to spot changes
		this.busy = Promise.resolve();
		this.prefix = this.app.appId + "-note-fold-";

		await this.loadInitial();
		this.hookFoldManager();

		this.app.workspace.onLayoutReady(() => {
			for (const path of Object.keys(this.folds)) this.applyToViews(path, this.folds[path]);
			this.registerInterval(window.setInterval(() => this.poll(), POLL_MS));
		});
		this.registerDomEvent(document, "visibilitychange", () => this.poll());
		this.registerEvent(this.app.vault.on("modify", (file) => this.retryPending(file.path)));
		this.registerEvent(this.app.workspace.on("file-open", (file) => file && this.retryPending(file.path)));
		this.registerEvent(this.app.vault.on("rename", (file, oldPath) => this.onRename(file.path, oldPath)));

		this.addCommand({
			id: "sync-now",
			name: "Sync folds now",
			callback: async () => {
				await this.serial(() => this.sync(true));
				new Notice("Folds synced");
			},
		});
	}

	onunload() {
		if (this.origSavePath) this.app.foldManager.savePath = this.origSavePath;
	}

	// Called by Obsidian (desktop, and mobile when it notices) when data.json changes on disk.
	async onExternalSettingsChange() {
		await this.serial(() => this.sync(false));
	}

	serial(fn) {
		this.busy = this.busy.then(fn, fn).catch((e) => console.error("Live Fold Sync:", e));
		return this.busy;
	}

	storageGet(path) {
		try {
			return JSON.parse(localStorage.getItem(this.prefix + path));
		} catch {
			return null;
		}
	}

	storageSet(path, info) {
		if (info && info.folds.length) localStorage.setItem(this.prefix + path, JSON.stringify(info));
		else localStorage.removeItem(this.prefix + path);
	}

	async loadInitial() {
		const adapter = this.app.vault.adapter;
		const dataPath = this.manifest.dir + "/data.json";
		let raw = (await adapter.exists(dataPath)) ? await adapter.read(dataPath) : null;
		let folds = raw ? parseFolds(JSON.parse(raw)) : {};

		if (!raw) {
			// First run: take Sync Folds' data if it is there, else this device's folds.
			const legacy = this.app.vault.configDir + "/" + LEGACY_DATA;
			if (await adapter.exists(legacy)) folds = parseFolds(JSON.parse(await adapter.read(legacy))) || {};
			for (let i = 0; i < localStorage.length; i++) {
				const key = localStorage.key(i);
				if (!key.startsWith(this.prefix)) continue;
				const path = key.slice(this.prefix.length);
				if (!(path in folds)) folds[path] = this.storageGet(path);
			}
			for (const path of Object.keys(folds)) if (!folds[path]) delete folds[path];
			this.folds = folds;
			await this.write();
		} else {
			this.folds = folds || {};
			this.lastRaw = raw;
		}
		// data.json is the shared truth: bring this device's localStorage in line with it.
		for (const [path, info] of Object.entries(this.folds)) {
			if (!sameFolds(this.storageGet(path), info)) this.storageSet(path, info);
		}
	}

	hookFoldManager() {
		const fm = this.app.foldManager;
		const orig = (this.origSavePath = fm.savePath);
		const plugin = this;
		fm.savePath = function (path, info) {
			if (!plugin.onLocalSave(path, info)) return;
			return orig.call(this, path, info);
		};
	}

	// An open note on this device reported its folds. Returns false to drop the save.
	onLocalSave(path, info) {
		if (info && !info.folds.length) info = null;
		const pending = this.pending[path];
		if (pending !== undefined) {
			// The note could not show incoming folds yet. If it reports the folds it already
			// had (e.g. it is being closed), keep the incoming ones instead of overwriting them.
			if (sameFolds(info, this.lastLocal[path])) return false;
			delete this.pending[path];
		}
		this.lastLocal[path] = info;
		if (sameFolds(info, this.folds[path])) return true; // nothing new, e.g. folds we just applied
		if (info) this.folds[path] = info;
		else delete this.folds[path];
		this.dirty.add(path);
		this.scheduleWrite();
		return true;
	}

	scheduleWrite = debounce(() => this.serial(() => this.sync(true)), WRITE_DELAY_MS, true);

	async poll() {
		if (document.visibilityState !== "visible") return;
		const dataPath = this.manifest.dir + "/data.json";
		const stat = await this.app.vault.adapter.stat(dataPath).catch(() => null);
		if (!stat) return;
		const key = stat.mtime + ":" + stat.size;
		if (key === this.lastStat) return;
		this.lastStat = key;
		await this.serial(() => this.sync(false));
	}

	// Reads data.json, applies changes from other devices, then writes this device's
	// unsaved changes on top if there are any (or if `write` is set).
	async sync(write) {
		const adapter = this.app.vault.adapter;
		const dataPath = this.manifest.dir + "/data.json";
		const raw = (await adapter.exists(dataPath)) ? await adapter.read(dataPath) : null;
		if (raw !== null && raw !== this.lastRaw) {
			let data;
			try {
				data = JSON.parse(raw);
			} catch {
				// Half-written by the sync service; try again shortly.
				window.setTimeout(() => this.serial(() => this.sync(false)), POLL_MS);
				return;
			}
			const incoming = parseFolds(data);
			if (incoming) {
				this.lastRaw = raw;
				const paths = new Set([...Object.keys(incoming), ...Object.keys(this.folds)]);
				for (const path of paths) {
					if (this.dirty.has(path)) continue;
					const info = incoming[path] || null;
					if (sameFolds(info, this.folds[path] || null)) continue;
					if (info) this.folds[path] = info;
					else delete this.folds[path];
					this.receive(path, info);
				}
			}
		}
		if (write || this.dirty.size) await this.write();
	}

	async write() {
		this.dirty.clear();
		const data = Object.assign({ enableSync: true }, await this.loadData(), { folds: JSON.stringify(this.folds) });
		await this.saveData(data);
		const dataPath = this.manifest.dir + "/data.json";
		this.lastRaw = await this.app.vault.adapter.read(dataPath);
		const stat = await this.app.vault.adapter.stat(dataPath);
		if (stat) this.lastStat = stat.mtime + ":" + stat.size;
	}

	// Folds for `path` changed on another device.
	receive(path, info) {
		if (!(path in this.lastLocal)) this.lastLocal[path] = this.storageGet(path);
		this.storageSet(path, info);
		this.applyToViews(path, info);
	}

	applyToViews(path, info) {
		let missed = false;
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			const view = leaf.view;
			if (!(view instanceof MarkdownView) || !view.file || view.file.path !== path) continue;
			const mode = view.currentMode;
			const current = mode.getFoldInfo && mode.getFoldInfo();
			if (!current) continue;
			if (info && info.lines !== current.lines) {
				missed = true; // Obsidian ignores folds for a different version of the note
				continue;
			}
			if (sameFolds(current, info)) continue;
			mode.applyFoldInfo(info);
			if (view.metadataEditor && view.metadataEditor.setCollapse) {
				view.metadataEditor.setCollapse(!!info && info.folds.some((f) => f.from === 0), false);
			}
		}
		if (missed) this.pending[path] = info;
		else {
			delete this.pending[path];
			this.lastLocal[path] = info;
		}
	}

	retryPending(path) {
		if (!(path in this.pending)) return;
		// Give the open note a moment to load the new text before checking its line count.
		window.setTimeout(() => {
			if (path in this.pending) this.applyToViews(path, this.pending[path]);
		}, 500);
	}

	onRename(path, oldPath) {
		// Obsidian leaves a renamed note's folds under the old name; move them along.
		const info = this.folds[oldPath] || this.storageGet(oldPath);
		if (!info) return;
		localStorage.removeItem(this.prefix + oldPath);
		this.storageSet(path, info);
		delete this.folds[oldPath];
		this.folds[path] = info;
		this.dirty.add(oldPath);
		this.dirty.add(path);
		this.scheduleWrite();
	}
};
