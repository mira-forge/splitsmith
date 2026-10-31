import { App, FuzzySuggestModal, TFolder } from "obsidian";
import { describePreset, type Preset } from "../core/presets";

/** Pick the inbox folder (asked once; change it later in settings). */
export class FolderPickModal extends FuzzySuggestModal<TFolder> {
	constructor(
		app: App,
		private onPick: (folder: TFolder) => void,
	) {
		super(app);
		this.setPlaceholder("Pick your inbox folder, for example daily notes or web clips");
	}
	getItems(): TFolder[] {
		return this.app.vault.getAllLoadedFiles().filter((f): f is TFolder => f instanceof TFolder && !f.isRoot());
	}
	getItemText(f: TFolder): string {
		return f.path;
	}
	onChooseItem(f: TFolder): void {
		this.onPick(f);
	}
}

/** Pick a saved preset for "Split note with a preset". */
export class PresetPickModal extends FuzzySuggestModal<Preset> {
	constructor(
		app: App,
		private presets: Preset[],
		private onPick: (p: Preset) => void,
	) {
		super(app);
		this.setPlaceholder("Split with which preset?");
	}
	getItems(): Preset[] {
		return this.presets;
	}
	getItemText(p: Preset): string {
		return `${p.name}: ${describePreset(p)}`;
	}
	onChooseItem(p: Preset): void {
		this.onPick(p);
	}
}
