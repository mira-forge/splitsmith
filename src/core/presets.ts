/**
 * Saved presets: a name, a split method and its options. Used by "Split note with a preset"
 * and by Inbox mode. Pure: no Obsidian or network access here.
 */
import { partsByDelimiter, partsByHeading, type Doc, type Part } from "./sections";
import type { LinkStyle, SplitOptions } from "./apply";
import type { InheritMode } from "./plan";

export type SplitMethod = "heading" | "delimiter" | "ai";

export interface Preset {
	id: string;
	name: string;
	method: SplitMethod;
	/** Heading level 1-6, for method "heading". */
	level: number;
	/** Delimiter line, for method "delimiter". */
	delimiter: string;
	/** Extra AI instructions, for method "ai". Empty = use the custom instructions from settings. */
	instructions: string;
	linkStyle: LinkStyle;
	/** Folder for new notes; "" = same folder as the source note. */
	folder: string;
	fileNameTemplate: string;
	inherit: InheritMode;
}

export const DEFAULT_PRESETS: Preset[] = [
	{
		id: "heading-2",
		name: "One note per heading 2",
		method: "heading",
		level: 2,
		delimiter: "---",
		instructions: "",
		linkStyle: "link",
		folder: "",
		fileNameTemplate: "{{title}}",
		inherit: "tags",
	},
];

export function newPresetId(taken: Iterable<string>, now: () => number = () => Date.now()): string {
	const used = new Set(taken);
	let id = `p${now().toString(36)}`;
	for (let n = 2; used.has(id); n++) id = `p${now().toString(36)}-${n}`;
	return id;
}

/** Fix up a preset loaded from data.json (older or hand-edited data), so every field has a valid value. */
export function cleanPreset(p: Partial<Preset>, fallbackId: string): Preset {
	const method: SplitMethod = p.method === "delimiter" || p.method === "ai" ? p.method : "heading";
	const level = Number.isInteger(p.level) && p.level! >= 1 && p.level! <= 6 ? p.level! : 2;
	const linkStyle: LinkStyle = p.linkStyle === "embed" || p.linkStyle === "none" ? p.linkStyle : "link";
	const inherit: InheritMode = p.inherit === "none" || p.inherit === "all" ? p.inherit : "tags";
	return {
		id: typeof p.id === "string" && p.id ? p.id : fallbackId,
		name: typeof p.name === "string" && p.name.trim() ? p.name.trim() : "Preset",
		method,
		level,
		delimiter: typeof p.delimiter === "string" && p.delimiter.trim() ? p.delimiter.trim() : "---",
		instructions: typeof p.instructions === "string" ? p.instructions : "",
		linkStyle,
		folder: typeof p.folder === "string" ? p.folder.trim() : "",
		fileNameTemplate: typeof p.fileNameTemplate === "string" && p.fileNameTemplate.trim() ? p.fileNameTemplate.trim() : "{{title}}",
		inherit,
	};
}

/** One-line summary for lists, e.g. "Heading 2, links, tags only". */
export function describePreset(p: Preset): string {
	const how = p.method === "heading" ? `At heading ${p.level}` : p.method === "delimiter" ? `At "${p.delimiter}" lines` : "With AI";
	const style = p.linkStyle === "link" ? "links" : p.linkStyle === "embed" ? "embeds" : "no links";
	const props = p.inherit === "none" ? "no properties" : p.inherit === "tags" ? "tags only" : "all properties";
	return `${how}, ${style}, ${props}${p.folder ? `, into ${p.folder}` : ""}`;
}

/** Split options for a preset. Link-back property and link repair always come from settings. */
export function presetOptions(p: Preset, global: Pick<SplitOptions, "sourceProperty" | "repairLinks">): SplitOptions {
	return {
		linkStyle: p.linkStyle,
		folder: p.folder,
		fileNameTemplate: p.fileNameTemplate,
		inherit: p.inherit,
		sourceProperty: global.sourceProperty,
		repairLinks: global.repairLinks,
	};
}

/** Parts for a mechanical preset. AI presets are planned by the caller (they need the user's model). */
export function mechanicalParts(doc: Doc, p: Preset): Part[] {
	if (p.method === "heading") return partsByHeading(doc, p.level);
	if (p.method === "delimiter") return partsByDelimiter(doc, p.delimiter);
	throw new Error("AI presets are planned with the model.");
}
