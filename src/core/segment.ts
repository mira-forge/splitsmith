import { safeTitle, type Doc, type Part } from "./sections";

/**
 * AI segmentation that cannot lose or rewrite text.
 * The model only sees numbered lines and returns boundaries plus titles; it never returns note text.
 * The plugin then cuts the user's original lines verbatim. validatePlan() rejects any plan that
 * drops, duplicates, overlaps or reorders a line, so a bad model reply fails loudly instead of losing
 * content (Note Refactor issues #65, #66: content loss; InsightA rewrites the source instead of moving it).
 */

export interface AiPart {
	title: string;
	start: number;
	end: number;
}

/** A run of body lines sent in one request: [start, end] inclusive. */
export interface Window {
	start: number;
	end: number;
}

export function numberedBody(doc: Doc, w: Window = { start: 0, end: doc.lines.length - 1 }): string {
	const out: string[] = [];
	for (let i = w.start; i <= w.end; i++) out.push(`${i}| ${doc.lines[i]!.text}`);
	return out.join("\n");
}

export function buildSegmentPrompt(
	doc: Doc,
	opts: { maxParts: number; instructions?: string; language?: string; window?: Window },
): { system: string; user: string } {
	const w = opts.window ?? { start: 0, end: doc.lines.length - 1 };
	const system = [
		"You split a Markdown note into self-contained atomic notes, one idea each.",
		"You receive the note as numbered lines. Do not rewrite, summarise or quote the text.",
		'Reply with JSON only: {"parts":[{"title":"...","start":0,"end":12}, ...]}',
		`Rules: parts are contiguous, in order, cover every line from ${w.start} to ${w.end} exactly once, and never cut inside a code block, list item or table.`,
		`Use at most ${opts.maxParts} parts. Titles are short, specific, and work as file names.`,
		opts.language ? `Write titles in ${opts.language}.` : "Write titles in the note's language.",
		opts.instructions ? `Extra instructions from the user: ${opts.instructions}` : "",
	]
		.filter(Boolean)
		.join("\n");
	return { system, user: numberedBody(doc, w) };
}

export function parsePlan(reply: string): AiPart[] {
	const m = /\{[\s\S]*\}/.exec(reply);
	if (!m) throw new Error("The model did not return a split plan.");
	let j: unknown;
	try {
		j = JSON.parse(m[0]);
	} catch {
		throw new Error("The model's split plan was not valid JSON.");
	}
	const parts = (j as { parts?: unknown }).parts;
	if (!Array.isArray(parts)) throw new Error("The model's split plan had no parts.");
	return parts.map((p) => {
		const o = (p ?? {}) as Record<string, unknown>;
		return { title: typeof o.title === "string" ? o.title.trim() : "", start: Number(o.start), end: Number(o.end) };
	});
}

/**
 * Throws with a user-readable reason unless the plan covers every line of the window exactly once,
 * in order, without cutting a code block. Titles are made file-name safe.
 */
export function validatePlan(doc: Doc, plan: AiPart[], maxParts: number, w: Window = { start: 0, end: doc.lines.length - 1 }): Part[] {
	if (!plan.length) throw new Error("The split plan was empty.");
	if (plan.length > maxParts) throw new Error(`The plan has ${plan.length} parts; the limit is ${maxParts}.`);
	let expect = w.start;
	for (const p of plan) {
		if (!Number.isInteger(p.start) || !Number.isInteger(p.end)) throw new Error("The split plan had non-numeric line numbers.");
		if (p.start < expect) throw new Error(`The split plan has overlapping parts at line ${p.start}.`);
		if (p.start > expect) throw new Error(`The split plan skips lines ${expect} to ${p.start - 1}.`);
		if (p.end < p.start || p.end > w.end) throw new Error(`The split plan had an invalid range (${p.start}-${p.end}).`);
		const here = doc.lines[p.start]!;
		const prev = doc.lines[p.start - 1];
		if (prev && here.block >= 0 && here.block === prev.block) throw new Error(`The split plan cuts through a code block at line ${p.start}.`);
		if (!p.title.trim()) throw new Error("A part in the split plan had no title.");
		expect = p.end + 1;
	}
	if (expect !== w.end + 1) throw new Error(`The split plan leaves out lines ${expect} to ${w.end}.`);
	return plan.map((p) => ({ title: safeTitle(p.title), start: p.start, end: p.end }));
}

/**
 * Cut the body into windows of at most `maxChars` (numbered-line characters), only at blank lines or
 * headings outside code, so each fits one model request. A single oversized block becomes its own window.
 */
export function windows(doc: Doc, maxChars: number): Window[] {
	const n = doc.lines.length;
	if (!n) return [];
	const cost = (i: number) => doc.lines[i]!.text.length + String(i).length + 3;
	const cuttable = (i: number) => {
		const l = doc.lines[i]!;
		return !l.inCode && (l.text.trim() === "" || /^ {0,3}#{1,6}[ \t]/.test(l.text));
	};
	const out: Window[] = [];
	let start = 0;
	let size = 0;
	let lastCut = -1;
	for (let i = 0; i < n; i++) {
		size += cost(i);
		if (i > start && cuttable(i)) lastCut = i;
		if (size > maxChars && lastCut > start) {
			out.push({ start, end: lastCut - 1 });
			start = lastCut;
			size = 0;
			for (let k = start; k <= i; k++) size += cost(k);
			lastCut = -1;
		}
	}
	out.push({ start, end: n - 1 });
	return out;
}

/** Make titles unique within one plan ("Topic", "Topic 2", ...), case-insensitively. */
export function dedupeTitles(parts: Part[]): Part[] {
	const seen = new Map<string, number>();
	return parts.map((p) => {
		const k = p.title.toLowerCase();
		const c = (seen.get(k) ?? 0) + 1;
		seen.set(k, c);
		return c === 1 ? p : { ...p, title: `${p.title} ${c}` };
	});
}
