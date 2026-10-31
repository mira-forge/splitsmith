/* Minimal stand-in for the "obsidian" module so plugin code can run under vitest. */
export const notices: string[] = [];
export class Notice {
	constructor(public message: string, _t?: number) { notices.push(message); }
	setMessage(m: string) { this.message = m; return this; }
	hide() {}
}
export const Platform = { isMobile: false, isDesktop: true };
export function normalizePath(p: string) { return p.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/|\/$/g, ""); }
export const requestLog: unknown[] = [];
export async function requestUrl(req: unknown) { requestLog.push(req); return { status: 599, json: null, text: "" }; }

/** Tiny YAML writer, enough for flat properties (Obsidian's stringifyYaml in the real app). */
export function stringifyYaml(o: Record<string, unknown>): string {
	const v = (x: unknown): string => (Array.isArray(x) ? `\n${x.map((i) => `  - ${v(i)}`).join("\n")}` : typeof x === "string" ? JSON.stringify(x) : String(x));
	return Object.entries(o).map(([k, x]) => `${k}: ${v(x)}`).join("\n") + "\n";
}

export class TAbstractFile {
	/** Shape fields of the real class, so tests type-check against the real obsidian types. */
	vault: any = null;
	constructor(public path: string) {}
	get name() { return this.path.split("/").pop() ?? ""; }
	get parent(): TFolder | null { const i = this.path.lastIndexOf("/"); return this.path === "" ? null : new TFolder(i < 0 ? "" : this.path.slice(0, i)); }
}
export class TFolder extends TAbstractFile {
	children: TAbstractFile[] = [];
	isRoot() { return this.path === "" || this.path === "/"; }
}
export class TFile extends TAbstractFile {
	/** Shape fields of the real TFile, so tests type-check against the real obsidian types. */
	stat = { ctime: 0, mtime: 0, size: 0 };
	get basename() { return (this.path.split("/").pop() ?? "").replace(/\.md$/, ""); }
	get extension() { return this.path.split(".").pop() ?? ""; }
	override get parent(): TFolder { const i = this.path.lastIndexOf("/"); return new TFolder(i < 0 ? "" : this.path.slice(0, i)); }
}
export class Component {}
const el = (): any => new Proxy(function () {}, { get: (_t, k) => (k === "then" ? undefined : el()), apply: () => el() });
export class Modal {
	contentEl = el();
	modalEl = el();
	constructor(public app: unknown) {}
	open() {} close() {} setTitle() { return this; }
}
export class FuzzySuggestModal<T> extends Modal { _t?: T; setPlaceholder() {} }
export class PluginSettingTab { containerEl = el(); constructor(public app: unknown, public plugin: unknown) {} }
/** Rows drawn by `new Setting(...)`: names and button labels, so tests can check what a screen shows. */
export const settingLog: { names: string[]; buttons: string[]; texts: string[] } = { names: [], buttons: [], texts: [] };
const recorder = (): any =>
	new Proxy(function () {}, {
		get: (_t, k) => {
			if (k === "then") return undefined;
			if (k === "setName") return (n: string) => (settingLog.names.push(n), recorder());
			if (k === "setButtonText") return (n: string) => (settingLog.buttons.push(n), recorder());
			if (k === "createEl") return (_tag: string, o?: { text?: string }) => (o?.text && settingLog.texts.push(o.text), recorder());
			// Builder callbacks (addButton((b) => ...), addText((t) => ...)) get a recorder to configure. Event handlers are not run.
			if (typeof k === "string" && k.startsWith("add"))
				return (...args: unknown[]) => {
					for (const a of args) if (typeof a === "function") (a as (x: unknown) => unknown)(recorder());
					return recorder();
				};
			return recorder();
		},
		apply: () => recorder(),
	});
export class Setting {
	constructor(_el: unknown) {
		return recorder();
	}
}
export { recorder as mockElement };
export class SecretComponent {}
export class MarkdownView {}

export class MockVault {
	files = new Map<string, string>();
	folders = new Set<string>();
	trashed: string[] = [];
	/** Hook to simulate an edit landing between read and write. */
	beforeProcess: ((path: string) => void) | null = null;
	failCreateAt = -1;
	creates = 0;
	/** Fault injection: make process() on a path throw before writing, or write and then throw. */
	failProcess: { path: string; when: "before" | "after"; times?: number } | null = null;
	/** Fault injection: what actually lands on disk for a create (simulates a bad write). */
	createTransform: ((path: string, data: string) => string) | null = null;
	getMarkdownFiles() { return [...this.files.keys()].filter((p) => p.endsWith(".md")).map((p) => new TFile(p)); }
	async read(f: TFile) { return this.files.get(f.path) ?? ""; }
	async cachedRead(f: TFile) { return this.files.get(f.path) ?? ""; }
	async process(f: TFile, fn: (d: string) => string) {
		this.beforeProcess?.(f.path);
		const fp = this.failProcess;
		const fail = fp && fp.path === f.path && (fp.times === undefined || fp.times-- > 0);
		if (fail && fp.when === "before") throw new Error("EIO: process failed");
		const v = fn(this.files.get(f.path) ?? "");
		this.files.set(f.path, v);
		if (fail && fp.when === "after") throw new Error("EIO: write reported failure after writing");
		return v;
	}
	getAllLoadedFiles() { return [...[...this.files.keys()].map((p) => new TFile(p)), ...[...this.folders].map((p) => new TFolder(p))]; }
	getFolderByPath(p: string) { return this.folders.has(p) ? new TFolder(p) : null; }
	getAbstractFileByPath(p: string) { return this.files.has(p) ? new TFile(p) : this.folders.has(p) ? new TFolder(p) : null; }
	async createFolder(p: string) { this.folders.add(p); }
	getFileByPath(p: string) { return this.files.has(p) ? new TFile(p) : null; }
	async create(p: string, d: string) {
		if (this.creates++ === this.failCreateAt) throw new Error("disk full");
		if (this.files.has(p)) throw new Error("File already exists.");
		this.files.set(p, this.createTransform ? this.createTransform(p, d) : d);
		return new TFile(p);
	}
	async modify(f: TFile, d: string) { this.files.set(f.path, d); }
}

export class MockFileManager {
	constructor(private vault: MockVault) {}
	/** Like Obsidian's "shortest path when possible": the file name, or the path when another file has the same name. */
	generateMarkdownLink(f: TFile, _from: string, subpath = "", alias?: string) {
		const same = [...this.vault.files.keys()].filter((p) => p.split("/").pop() === f.path.split("/").pop()).length > 1;
		const name = same ? f.path.replace(/\.md$/, "") : f.basename;
		return `[[${name}${subpath}${alias ? `|${alias}` : ""}]]`;
	}
	async trashFile(f: TAbstractFile) { this.vault.files.delete(f.path); this.vault.trashed.push(f.path); }
}

export class Plugin {
	commands: { id: string; name: string; callback?: () => void; checkCallback?: (c: boolean) => boolean | void; editorCheckCallback?: unknown }[] = [];
	data: unknown = null;
	constructor(public app: any, public manifest: unknown) {}
	addCommand(c: any) { this.commands.push(c); return c; }
	addRibbonIcon() { return {}; }
	addSettingTab() {}
	registerInterval(id: number) { return id; }
	async loadData() { return this.data; }
	async saveData(d: unknown) { this.data = JSON.parse(JSON.stringify(d)); }
}
