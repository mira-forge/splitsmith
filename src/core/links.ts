/**
 * Link repair planner (pure, tested). After a split, links elsewhere in the vault such as
 * [[Source#Heading]] or [[Source#^block]] would point at text that moved. This works out which new
 * note now holds each heading or block and what the link should point to. The plugin then rewrites
 * only those exact link spans, and only if the span still matches what was read.
 */
import { headingLevel, headingText, type Doc } from "./sections";
import type { SplitPlan } from "./plan";

export interface InboundRef {
	/** File that contains the link. */
	path: string;
	/** Offsets of the whole link text in that file, from Obsidian's metadata cache. */
	start: number;
	end: number;
	original: string;
	/** Link target as written, e.g. "Source#Heading" or "Source#^abc". */
	link: string;
	displayText?: string;
	embed: boolean;
}

export interface PartAnchors {
	/** Normalised heading text of the part's first line, if it is a heading. */
	lead: string | null;
	headings: Map<string, string>;
	blocks: Set<string>;
}

export interface LinkEdit {
	path: string;
	start: number;
	end: number;
	oldText: string;
	part: number;
	/** "" (whole note), "#Heading" or "#^block". */
	subpath: string;
	alias?: string;
	embed: boolean;
}

/**
 * Heading key, matched the way Obsidian resolves [[Note#Heading]]: it blanks out ! " # $ % & ( ) * + , . / : ; < = > ? @
 * [ \\ ] ^ ` { | } ~, collapses whitespace and compares case-insensitively. So [[Functions#hasTag]] reaches "### `hasTag()`"
 * (checked against Obsidian 1.14's own resolveSubpath; corpus finding, Gate 3 round 2).
 */
export function normHeading(s: string): string {
	return s
		.replace(/[!"#$%&()*+,./:;<=>?@[\\\]^`{|}~]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase();
}

/**
 * A block id at the end of a line ("text ^id", a line that is only "^id", or right after inline markup such as
 * "![[img.png]]^id", "**b**^id", "`c`^id", as Obsidian reads them). Obsidian compares ids case-insensitively, so
 * callers key them with blockKey().
 */
export const BLOCK = /(?:^|\s|\]\]|[)*_`$%=~])\^([A-Za-z0-9-]+)\s*$/;
export const blockKey = (id: string) => id.toLowerCase();

export function anchorsFor(doc: Doc, plan: SplitPlan): PartAnchors[] {
	return plan.parts.map((p) => {
		const a: PartAnchors = { lead: null, headings: new Map(), blocks: new Set() };
		let first = true;
		for (const l of doc.lines) {
			if (l.from < p.from || l.from >= p.to) continue;
			if (l.inCode) {
				first = false;
				continue;
			}
			if (headingLevel(l)) {
				const t = headingText(l);
				if (first) a.lead = normHeading(t);
				if (!a.headings.has(normHeading(t))) a.headings.set(normHeading(t), t); // first one wins, as in Obsidian
			}
			const b = BLOCK.exec(l.text);
			if (b) a.blocks.add(blockKey(b[1]!));
			if (l.text.trim()) first = false;
		}
		return a;
	});
}

export function planLinkEdits(refs: InboundRef[], anchors: PartAnchors[]): LinkEdit[] {
	const out: LinkEdit[] = [];
	for (const r of refs) {
		const hash = r.link.indexOf("#");
		if (hash < 0) continue; // a link to the whole note still points at the source, which stays
		const sub = r.link.slice(hash + 1);
		let part = -1;
		let subpath = "";
		if (sub.startsWith("^")) {
			const id = sub.slice(1);
			part = anchors.findIndex((a) => a.blocks.has(blockKey(id)));
			subpath = `#^${id}`;
		} else {
			const last = sub.split("#").pop() ?? "";
			const key = normHeading(last);
			part = anchors.findIndex((a) => a.headings.has(key));
			// Always keep the heading ([[NewNote#Heading]]), also when it is the new note's first line (Gate 3 decision 2).
			if (part >= 0) subpath = `#${anchors[part]!.headings.get(key)}`;
		}
		if (part < 0) continue;
		const aliased = r.original.includes("|") || !r.original.includes("[[");
		out.push({
			path: r.path,
			start: r.start,
			end: r.end,
			oldText: r.original,
			part,
			subpath,
			alias: aliased && r.displayText ? r.displayText : undefined,
			embed: r.embed,
		});
	}
	return out;
}

/** Apply edits to one file's text. Spans that no longer match are skipped. Returns new text and applied edits in new coordinates. */
export function applyEdits(text: string, edits: { start: number; end: number; oldText: string; newText: string }[]) {
	const sorted = [...edits].sort((a, b) => a.start - b.start);
	let out = "";
	let cur = 0;
	const applied: { start: number; oldText: string; newText: string }[] = [];
	let skipped = 0;
	for (const e of sorted) {
		if (e.start < cur || text.slice(e.start, e.end) !== e.oldText) {
			skipped++;
			continue;
		}
		out += text.slice(cur, e.start);
		applied.push({ start: out.length, oldText: e.oldText, newText: e.newText });
		out += e.newText;
		cur = e.end;
	}
	out += text.slice(cur);
	return { text: out, applied, skipped };
}

/** Undo applyEdits: put each oldText back where newText still sits. */
export function revertEdits(text: string, applied: { start: number; oldText: string; newText: string }[]) {
	const sorted = [...applied].sort((a, b) => a.start - b.start);
	let out = "";
	let cur = 0;
	let skipped = 0;
	for (const e of sorted) {
		const end = e.start + e.newText.length;
		if (e.start < cur || text.slice(e.start, end) !== e.newText) {
			skipped++;
			continue;
		}
		out += text.slice(cur, e.start) + e.oldText;
		cur = end;
	}
	out += text.slice(cur);
	return { text: out, skipped };
}
