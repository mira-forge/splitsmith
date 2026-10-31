import { App, Modal, Setting } from "obsidian";
import type { LinkStyle } from "../core/apply";
import type { InheritMode } from "../core/plan";
import { cleanPreset, type Preset, type SplitMethod } from "../core/presets";

/** Edit one saved preset. Nothing is saved until you select save. */
export class PresetModal extends Modal {
	private draft: Preset;
	constructor(
		app: App,
		preset: Preset,
		private onSave: (p: Preset) => Promise<void>,
	) {
		super(app);
		this.draft = { ...preset };
	}
	onOpen(): void {
		this.setTitle("Preset");
		this.draw();
	}
	private draw(): void {
		const { contentEl } = this;
		contentEl.empty();
		const d = this.draft;
		new Setting(contentEl).setName("Name").addText((t) => t.setValue(d.name).onChange((v) => (d.name = v)));
		new Setting(contentEl).setName("Split method").addDropdown((dd) =>
			dd
				.addOption("heading", "At a heading level")
				.addOption("delimiter", "At a delimiter line")
				.addOption("ai", "With AI (your model)")
				.setValue(d.method)
				.onChange((v) => {
					d.method = v as SplitMethod;
					this.draw();
				}),
		);
		if (d.method === "heading") {
			new Setting(contentEl).setName("Heading level").addDropdown((dd) => {
				for (let l = 1; l <= 6; l++) dd.addOption(String(l), `Heading ${l}`);
				dd.setValue(String(d.level)).onChange((v) => (d.level = Number(v)));
			});
		} else if (d.method === "delimiter") {
			new Setting(contentEl).setName("Delimiter").setDesc("A line that marks where to split.").addText((t) => t.setValue(d.delimiter).onChange((v) => (d.delimiter = v)));
		} else {
			new Setting(contentEl)
				.setName("Instructions for the model")
				.setDesc("Leave empty to use the custom instructions from settings.")
				.addTextArea((t) => t.setValue(d.instructions).onChange((v) => (d.instructions = v)));
		}
		new Setting(contentEl).setName("Replace each part with").addDropdown((dd) =>
			dd
				.addOption("link", "A link")
				.addOption("embed", "An embed")
				.addOption("none", "Nothing")
				.setValue(d.linkStyle)
				.onChange((v) => (d.linkStyle = v as LinkStyle)),
		);
		new Setting(contentEl)
			.setName("Folder for new notes")
			.setDesc("Leave empty to put new notes next to the original.")
			.addText((t) => t.setPlaceholder("Same folder as the note").setValue(d.folder).onChange((v) => (d.folder = v)));
		new Setting(contentEl)
			.setName("File name template")
			.setDesc("Use {{title}}, {{source}}, {{n}} and {{date}}.")
			.addText((t) => t.setValue(d.fileNameTemplate).onChange((v) => (d.fileNameTemplate = v)));
		new Setting(contentEl).setName("Copy properties to new notes").addDropdown((dd) =>
			dd
				.addOption("none", "None")
				.addOption("tags", "Tags only")
				.addOption("all", "All except aliases")
				.setValue(d.inherit)
				.onChange((v) => (d.inherit = v as InheritMode)),
		);
		new Setting(contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) =>
				b
					.setButtonText("Save")
					.setCta()
					.onClick(async () => {
						this.close();
						await this.onSave(cleanPreset(this.draft, this.draft.id));
					}),
			);
	}
	onClose(): void {
		this.contentEl.empty();
	}
}
