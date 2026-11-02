import { App, PluginSettingTab, SecretComponent, Setting, type SettingDefinitionItem } from "obsidian";
import type SplitsmithPlugin from "./main";
import { PRESETS, type ProviderKind } from "./ai/providers";
import { MAX_AI_PARTS } from "./config";
import type { Journal, LinkStyle } from "./core/apply";
import type { InheritMode } from "./core/plan";
import { DEFAULT_PRESETS, describePreset, newPresetId, type Preset } from "./core/presets";
import type { DoneMap } from "./core/inbox";
import { PresetModal } from "./ui/preset-modal";

export interface SplitsmithSettings {
	linkStyle: LinkStyle;
	folder: string;
	fileNameTemplate: string;
	inherit: InheritMode;
	sourceProperty: string;
	repairLinks: boolean;
	delimiter: string;
	preset: string;
	kind: ProviderKind;
	baseUrl: string;
	model: string;
	/** Name of the entry in Obsidian's secret storage that holds the API key (not the key itself). */
	apiKeySecret: string;
	temperature: number;
	language: string;
	instructions: string;
	/** Undo journal for the most recent split. */
	lastSplit: Journal | null;
	/** saved presets (name + split method + options). */
	presets: Preset[];
	/** the inbox folder ("" = not chosen yet) and the preset it uses. */
	inboxFolder: string;
	inboxPresetId: string;
	/** notes already processed by Inbox mode, path -> fingerprint of their text at that time. */
	inboxDone: DoneMap;
	/** Undo record for the most recent inbox batch (set instead of lastSplit). */
	lastBatch: BatchRecord | null;
	/** Show the one-line "flashcards with Cardsmith" link in the notice after a split. */
	showCardsmithLink: boolean;
}

export interface BatchRecord {
	at: number;
	/** In the order applied; undone newest first. */
	journals: Journal[];
	/** inboxDone entries before the batch (null = no entry), restored by undo. */
	prevDone: Record<string, string | null>;
}

export const DEFAULT_SETTINGS: SplitsmithSettings = {
	linkStyle: "link",
	folder: "",
	fileNameTemplate: "{{title}}",
	inherit: "tags",
	sourceProperty: "source",
	repairLinks: true,
	delimiter: "---",
	preset: "ollama",
	kind: PRESETS.ollama!.kind,
	baseUrl: PRESETS.ollama!.baseUrl,
	model: PRESETS.ollama!.model,
	apiKeySecret: "",
	temperature: 0,
	language: "",
	instructions: "",
	lastSplit: null,
	presets: DEFAULT_PRESETS,
	inboxFolder: "",
	inboxPresetId: DEFAULT_PRESETS[0]!.id,
	inboxDone: {},
	lastBatch: null,
	showCardsmithLink: true,
};

/**
 * One settings row. The same list drives both renderers (same pattern as Cardsmith 0.1.2):
 * - Obsidian 1.13+: getSettingDefinitions() returns these as declarative definitions, so every
 *   row (name, description and aliases) shows up in Obsidian's settings search.
 * - Obsidian 1.11.4 to 1.12.x: display() builds the same rows imperatively.
 */
export interface Row {
	name: string;
	desc?: string;
	aliases?: string[];
	/** Adds the controls. May return the Setting (which is thenable), so the type is unknown, not void. */
	build: (setting: Setting) => unknown;
}

export interface Section {
	heading?: string;
	rows: Row[];
}

export class SplitsmithSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private plugin: SplitsmithPlugin,
	) {
		super(app, plugin);
	}

	/**
	 * Re-render after a change that adds, removes or relabels rows. Feature-detects the
	 * 1.13+ update() (declarative re-render); older builds re-run the imperative renderer.
	 */
	private refresh(): void {
		const update = (this as { update?: () => void }).update;
		if (typeof update === "function") update.call(this);
		else this.renderLegacy();
	}

	/** Obsidian 1.13+: declarative definitions, indexed by the settings search. */
	getSettingDefinitions(): SettingDefinitionItem[] {
		return this.sections().map((sec) => ({
			type: "group" as const,
			heading: sec.heading,
			items: sec.rows.map((r) => ({
				name: r.name,
				desc: r.desc,
				aliases: r.aliases,
				render: (setting: Setting) => {
					setting.setName(r.name);
					if (r.desc) setting.setDesc(r.desc);
					r.build(setting);
				},
			})),
		}));
	}

	/** Fallback renderer for Obsidian before 1.13.0 (minAppVersion is 1.11.4). Not called on 1.13+. */
	display(): void {
		this.renderLegacy();
	}

	private renderLegacy(): void {
		const { containerEl } = this;
		containerEl.empty();
		for (const sec of this.sections()) {
			if (sec.heading) new Setting(containerEl).setName(sec.heading).setHeading();
			for (const r of sec.rows) {
				const setting = new Setting(containerEl).setName(r.name);
				if (r.desc) setting.setDesc(r.desc);
				r.build(setting);
			}
		}
	}

	/** Exposed for tests: the rows both renderers draw. */
	sections(): Section[] {
		const s = this.plugin.settings;
				const save = () => this.plugin.saveSettings();
		const text = (name: string, desc: string | undefined, aliases: string[], get: () => string, set: (v: string) => void, placeholder?: string): Row => ({
			name,
			desc,
			aliases,
			build: (st) =>
				st.addText((t) => {
					if (placeholder) t.setPlaceholder(placeholder);
					t.setValue(get()).onChange(async (v) => {
						set(v);
						await save();
					});
				}),
		});

		const split: Row[] = [
			{
				name: "Replace each part with",
				desc: "What stays in the original note where a part was moved out. You can change it in the preview too.",
				aliases: ["link style", "embed", "transclude"],
				build: (st) =>
					st.addDropdown((d) =>
						d
							.addOption("link", "A link")
							.addOption("embed", "An embed")
							.addOption("none", "Nothing")
							.setValue(s.linkStyle)
							.onChange(async (v) => {
								s.linkStyle = v as LinkStyle;
								await save();
							}),
					),
			},
			text("Folder for new notes", "Leave empty to put new notes next to the original.", ["folder", "location", "output"], () => s.folder, (v) => (s.folder = v.trim()), "Same folder as the note"),
			text(
				"File name template",
				"Use {{title}}, {{source}} (original note name), {{n}} (part number) and {{date}}.",
				["file name", "filename", "title", "template"],
				() => s.fileNameTemplate,
				(v) => (s.fileNameTemplate = v.trim() || "{{title}}"),
			),
			{
				name: "Copy properties to new notes",
				aliases: ["properties", "tags", "front matter", "YAML", "inherit"],
				build: (st) =>
					st.addDropdown((d) =>
						d
							.addOption("none", "None")
							.addOption("tags", "Tags only")
							.addOption("all", "All except aliases")
							.setValue(s.inherit)
							.onChange(async (v) => {
								s.inherit = v as InheritMode;
								await save();
							}),
					),
			},
			text(
				"Link back property",
				"Property in each new note that links to the original note. Leave empty for none.",
				["source", "backlink", "property"],
				() => s.sourceProperty,
				(v) => (s.sourceProperty = v.trim()),
			),
			{
				name: "Update links to moved headings and blocks",
				desc: "Links in other notes to a heading or block that moved are pointed at its new note.",
				aliases: ["link repair", "backlinks", "block references"],
				build: (st) =>
					st.addToggle((t) =>
						t.setValue(s.repairLinks).onChange(async (v) => {
							s.repairLinks = v;
							await save();
						}),
					),
			},
			text("Delimiter", "A line that marks where to split, for the split by delimiter command.", ["separator", "divider"], () => s.delimiter, (v) => (s.delimiter = v.trim() || "---")),
			{
				name: "Show a suggestion for Cardsmith after a split",
				desc: "Adds one line to the split's notice linking to Cardsmith, a Mira Forge plugin that turns notes into flashcards. Nothing is sent anywhere unless you select it.",
				aliases: ["Cardsmith", "flashcards", "link", "suggestion"],
				build: (st) =>
					st.addToggle((t) =>
						t.setValue(s.showCardsmithLink).onChange(async (v) => {
							s.showCardsmithLink = v;
							await save();
						}),
					),
			},
		];

		const ai: Row[] = [
			{
				name: "Model provider",
				desc: "The model only chooses where to cut and what to call each part. It never writes note text. Requests go directly from this device to the provider you pick.",
				aliases: ["AI", "OpenAI", "Anthropic", "Ollama", "local model", "LLM"],
				build: (st) =>
					st.addDropdown((d) => {
						for (const [id, p] of Object.entries(PRESETS)) d.addOption(id, p.label);
						d.setValue(s.preset).onChange(async (v) => {
							const p = PRESETS[v];
							if (!p) return;
							s.preset = v;
							s.kind = p.kind;
							s.baseUrl = p.baseUrl;
							s.model = p.model;
							await save();
							this.refresh();
						});
					}),
			},
		];
		if (s.kind !== "anthropic") {
			ai.push(
				text(
					"Base URL",
					s.kind === "ollama" ? "Where Ollama is listening." : "OpenAI-compatible endpoint, ending in /v1 for most providers.",
					["endpoint", "server", "host"],
					() => s.baseUrl,
					(v) => (s.baseUrl = v.trim()),
				),
			);
		}
		ai.push(text("Model", undefined, ["model name"], () => s.model, (v) => (s.model = v.trim())));
		if (s.kind !== "ollama") {
			ai.push({
				name: "API key",
				desc: "Stored in Obsidian's secret storage on this device, not in your vault files. Never sent anywhere except the provider above.",
				aliases: ["token", "secret", "key"],
				build: (st) =>
					st.addComponent((el) =>
						new SecretComponent(this.app, el).setValue(s.apiKeySecret).onChange(async (v) => {
							s.apiKeySecret = v ?? "";
							await save();
						}),
					),
			});
		}
		ai.push(
			text(
				"Title language",
				`Leave empty to match each note's language. AI split makes up to ${MAX_AI_PARTS} notes.`,
				["language", "translate"],
				() => s.language,
				(v) => (s.language = v),
				"Same as note",
			),
			{
				name: "Custom instructions",
				desc: "Extra guidance for where to cut, for example one note per meeting decision.",
				aliases: ["prompt", "instructions"],
				build: (st) =>
					st.addTextArea((t) => {
						t.setValue(s.instructions);
						t.onChange(async (v) => {
							s.instructions = v;
							await save();
						});
					}),
			},
		);

		return [{ rows: split }, { heading: "AI split", rows: ai }, { heading: "Inbox and presets", rows: this.inboxRows() }];
	}

	private inboxRows(): Row[] {
		const s = this.plugin.settings;
		const save = () => this.plugin.saveSettings();
		const rows: Row[] = [
			{
				name: "Inbox folder",
				desc: "Notes in this folder and its subfolders are listed by the process inbox command until Splitsmith has split them, and again when they change.",
				aliases: ["inbox", "folder", "daily notes", "batch"],
				build: (st) =>
					st.addText((t) =>
						t.setPlaceholder("Inbox").setValue(s.inboxFolder).onChange(async (v) => {
							s.inboxFolder = v.trim();
							await save();
						}),
					),
			},
			{
				name: "Inbox preset",
				desc: "Used by default when you process the inbox. You can pick another one each time.",
				aliases: ["inbox", "preset"],
				build: (st) =>
					st.addDropdown((d) => {
						for (const p of s.presets) d.addOption(p.id, p.name);
						d.setValue(s.inboxPresetId).onChange(async (v) => {
							s.inboxPresetId = v;
							await save();
						});
					}),
			},
		];
		for (const p of s.presets) {
			rows.push({
				name: p.name,
				desc: describePreset(p),
				aliases: ["preset"],
				build: (st) => {
					st.addButton((b) =>
						b.setButtonText("Edit").onClick(() =>
							new PresetModal(this.app, p, async (next) => {
								s.presets = s.presets.map((x) => (x.id === p.id ? next : x));
								await save();
								this.refresh();
							}).open(),
						),
					);
					if (s.presets.length > 1) {
						st.addButton((b) =>
							b.setButtonText("Delete").onClick(async () => {
								s.presets = s.presets.filter((x) => x.id !== p.id);
								if (s.inboxPresetId === p.id) s.inboxPresetId = s.presets[0]!.id;
								await save();
								this.refresh();
							}),
						);
					}
				},
			});
		}
		rows.push({
			name: "Add a preset",
			desc: "A name, a split method (heading level, delimiter or AI) and its options.",
			aliases: ["preset", "new preset"],
			build: (st) =>
				st.addButton((b) =>
					b.setButtonText("Add preset").onClick(() => {
						const base = s.presets[0] ?? DEFAULT_PRESETS[0]!;
						const draft: Preset = { ...base, id: newPresetId(s.presets.map((x) => x.id)), name: "New preset" };
						new PresetModal(this.app, draft, async (next) => {
							s.presets = [...s.presets, next];
							await save();
							this.refresh();
						}).open();
					}),
				),
		});
		return rows;
	}
}
