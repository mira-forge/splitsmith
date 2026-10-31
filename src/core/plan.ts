/**
 * The lossless guarantee. A SplitPlan is a list of non-overlapping character ranges of the original
 * note; each range moves, byte for byte, into a new note. Nothing is ever retyped, trimmed inside a
 * range, or generated: the source keeps every byte outside the ranges, and gets a link where each
 * range was. verifyLossless() checks the exact strings that are about to be written: putting each
 * new note's body back in place of its link must give the original note, byte for byte.
 * Splitsmith refuses to write anything when that check fails.
 */
import type { Doc, Part } from "./sections";

export interface PlanPart {
	title: string;
	/** [from, to) offsets into SplitPlan.raw. */
	from: number;
	to: number;
}

export interface SplitPlan {
	raw: string;
	/** Offset where the body starts; ranges may not touch the front matter. */
	bodyFrom: number;
	eol: string;
	parts: PlanPart[];
}

export class PlanError extends Error {}

const BLANK = /^[ \t]*$/;

/**
 * Line ranges to a plan. Blank lines at the edges of a part stay in the source, around the link.
 * `minParts`: a delimiter split must yield at least 2 notes; with fewer, plan nothing ("Nothing to split"), so a
 * "---" preset never moves a note's only text out and leaves a bare rule behind (Gate 3 round 3, one-part guard).
 */
export function planFromParts(doc: Doc, parts: Part[], minParts = 1): SplitPlan {
	const out: PlanPart[] = [];
	for (const p of parts) {
		let s = p.start;
		let e = p.end;
		while (s <= e && BLANK.test(doc.lines[s]!.text)) s++;
		while (e >= s && BLANK.test(doc.lines[e]!.text)) e--;
		if (s > e) continue;
		const from = doc.lines[s]!.from;
		const to = doc.lines[e]!.to;
		// A part that is only whitespace (e.g. a lone "\r" or a no-break space) stays in the source,
		// like blank lines; checkPlan would otherwise refuse the whole plan as "A part is empty".
		if (!doc.raw.slice(from, to).trim()) continue;
		out.push({ title: p.title, from, to });
	}
	const plan = { raw: doc.raw, bodyFrom: doc.bodyFrom, eol: doc.eol, parts: out };
	checkPlan(plan);
	// One part that holds the whole body (no delimiter in the note, or a single section and nothing else) is not a
	// split: it would only move the note into a new one. Plan nothing; callers report "Nothing to split".
	if (movesWholeNote(plan, true) || plan.parts.length < minParts) plan.parts = [];
	return plan;
}

/** True when the plan is a single part and the source would keep nothing but its properties, whitespace and rules. */
export function movesWholeNote(plan: SplitPlan, ignoreRules = false): boolean {
	if (plan.parts.length !== 1) return false;
	const p = plan.parts[0]!;
	// For split methods (ignoreRules), rules and delimiter lines ("---", "***") left behind are not text: keeping only
	// them still moves the note. An explicit selection keeps today's rule (the user chose exactly what to move).
	const rest = (plan.raw.slice(plan.bodyFrom, p.from) + plan.raw.slice(p.to)).split(/\r?\n/).filter((l) => !ignoreRules || !/^\s*([-*_=~+])(\s*\1){2,}\s*$/.test(l));
	return !rest.join("\n").trim();
}

/** Extract an exact selection (may start or end mid-line). */
export function planFromSelection(doc: Doc, from: number, to: number, title: string): SplitPlan {
	if (to < from) [from, to] = [to, from];
	if (from < doc.bodyFrom) throw new PlanError("The selection includes the note's properties. Select body text only.");
	if (!doc.raw.slice(from, to).trim()) throw new PlanError("Select some text to extract first.");
	const plan = { raw: doc.raw, bodyFrom: doc.bodyFrom, eol: doc.eol, parts: [{ title, from, to }] };
	checkPlan(plan);
	if (movesWholeNote(plan)) throw new PlanError("Nothing to split: that would move the whole note into a new one.");
	return plan;
}

/** Structural checks: in order, no overlap, inside the body, never empty. Throws PlanError. */
export function checkPlan(plan: SplitPlan): void {
	let last = plan.bodyFrom;
	for (const p of plan.parts) {
		if (!Number.isInteger(p.from) || !Number.isInteger(p.to)) throw new PlanError("A part has an invalid range.");
		if (p.from < last) throw new PlanError(p.from < plan.bodyFrom ? "A part overlaps the note's properties." : "Two parts overlap.");
		if (p.to <= p.from || p.to > plan.raw.length) throw new PlanError("A part has an invalid range.");
		if (!plan.raw.slice(p.from, p.to).trim()) throw new PlanError("A part is empty.");
		last = p.to;
	}
}

/** Preview edit: join part i with the next one, including whatever sits between them. */
export function mergeWithNext(plan: SplitPlan, i: number): SplitPlan {
	const a = plan.parts[i];
	const b = plan.parts[i + 1];
	if (!a || !b) return plan;
	const parts = [...plan.parts.slice(0, i), { title: a.title, from: a.from, to: b.to }, ...plan.parts.slice(i + 2)];
	return { ...plan, parts };
}

/** Preview edit: leave part i in the source note. */
export function dropPart(plan: SplitPlan, i: number): SplitPlan {
	return { ...plan, parts: plan.parts.filter((_, k) => k !== i) };
}

export function partBody(plan: SplitPlan, i: number): string {
	const p = plan.parts[i]!;
	return plan.raw.slice(p.from, p.to);
}

export interface Marker {
	/** Where the inserted link starts in the new source text, and its length (0 when no link is inserted). */
	at: number;
	len: number;
	part: number;
}

export interface RenderedSplit {
	source: string;
	markers: Marker[];
	parts: { prefix: string; content: string }[];
}

/**
 * Build the exact text to write. `link(i)` is the link line text for part i ("" for none).
 * `prefix(i)` is the text Splitsmith adds at the top of new note i (properties), usually "".
 */
export function render(plan: SplitPlan, link: (i: number) => string, prefix: (i: number) => string): RenderedSplit {
	let source = "";
	let cur = 0;
	const markers: Marker[] = [];
	const parts: RenderedSplit["parts"] = [];
	plan.parts.forEach((p, i) => {
		source += plan.raw.slice(cur, p.from);
		const body = plan.raw.slice(p.from, p.to);
		const l = link(i);
		const ins = l ? l + (/\r?\n$/.exec(body)?.[0] ?? "") : "";
		markers.push({ at: source.length, len: ins.length, part: i });
		source += ins;
		cur = p.to;
		const pre = prefix(i);
		parts.push({ prefix: pre, content: pre + body });
	});
	source += plan.raw.slice(cur);
	return { source, markers, parts };
}

export type LosslessResult = { ok: true } | { ok: false; reason: string };

/** Put every new note's body back where its link is and compare with the original, byte for byte. */
export function verifyLossless(original: string, r: RenderedSplit): LosslessResult {
	if (!r.parts.length) return { ok: false, reason: "Nothing to split." };
	if (r.markers.length !== r.parts.length) return { ok: false, reason: "Each new note must be linked exactly once." };
	const bodies: string[] = [];
	for (const p of r.parts) {
		if (!p.content.startsWith(p.prefix)) return { ok: false, reason: "A new note does not start with its properties block." };
		const b = p.content.slice(p.prefix.length);
		if (!b.trim()) return { ok: false, reason: "A new note would be empty." };
		bodies.push(b);
	}
	let out = "";
	let cur = 0;
	let prevPart = -1;
	for (const m of r.markers) {
		if (m.part !== prevPart + 1) return { ok: false, reason: "New notes are out of order." };
		if (m.at < cur || m.at + m.len > r.source.length) return { ok: false, reason: "Links overlap." };
		out += r.source.slice(cur, m.at) + bodies[m.part]!;
		cur = m.at + m.len;
		prevPart = m.part;
	}
	out += r.source.slice(cur);
	if (out === original) return { ok: true };
	let i = 0;
	while (i < out.length && out[i] === original[i]) i++;
	return { ok: false, reason: `The split would change the note's text near character ${i}.` };
}

/** Properties block for a new note: inherited properties plus an optional source link. "" when there are none. */
export function buildPrefix(props: Record<string, unknown>, yaml: (o: Record<string, unknown>) => string, eol: string): string {
	if (!Object.keys(props).length) return "";
	let y = yaml(props).replace(/\r\n/g, "\n");
	if (!y.endsWith("\n")) y += "\n";
	return ("---\n" + y + "---\n").replace(/\n/g, eol);
}

export type InheritMode = "none" | "tags" | "all";
const NEVER_INHERIT = new Set(["aliases", "alias", "position"]);

export function inheritedProps(fm: Record<string, unknown> | null | undefined, mode: InheritMode, sourceKey: string, sourceLink: string | null): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	if (fm && mode !== "none") {
		for (const [k, v] of Object.entries(fm)) {
			if (NEVER_INHERIT.has(k.toLowerCase()) || k === sourceKey) continue;
			if (mode === "tags" && k.toLowerCase() !== "tags" && k.toLowerCase() !== "tag") continue;
			out[k] = v;
		}
	}
	if (sourceLink && sourceKey.trim()) out[sourceKey.trim()] = sourceLink;
	return out;
}

/** File name from a template: {{source}}, {{title}}, {{n}} (1-based), {{date}} (YYYY-MM-DD). */
export function fileNameFrom(template: string, v: { source: string; title: string; n: number; date: string }): string {
	const t = template.trim() || "{{title}}";
	// One pass with a function replacer: values are inserted literally ("$&", "$'" in a title stay as typed,
	// gap 3) and a value that itself contains "{{title}}" is not expanded again.
	const vals: Record<string, string> = { source: v.source, title: v.title, n: String(v.n), date: v.date };
	return t.replace(/\{\{\s*(source|title|n|date)\s*\}\}/g, (_m, k: string) => vals[k]!);
}

/** Pick "Name.md", "Name 2.md", ... that is not taken on disk or earlier in the same split. */
export function uniquePath(folder: string, base: string, taken: (p: string) => boolean, reserved: Set<string>): string {
	const dir = folder && folder !== "/" ? folder.replace(/\/+$/, "") + "/" : "";
	for (let k = 1; k < 10000; k++) {
		const p = `${dir}${base}${k === 1 ? "" : ` ${k}`}.md`;
		if (!taken(p) && !reserved.has(p.toLowerCase())) {
			reserved.add(p.toLowerCase());
			return p;
		}
	}
	throw new PlanError("Could not find a free file name.");
}

/** Short, stable fingerprint for the undo journal (FNV-1a, 32-bit, plus length). */
export function fingerprint(s: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return `${s.length}:${(h >>> 0).toString(16)}`;
}
