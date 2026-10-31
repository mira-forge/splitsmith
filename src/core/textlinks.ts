/**
 * Our own parse of links in note text (pure, tested). Used so link rewrites in the source and in new notes never
 * depend on when Obsidian's metadata cache indexes a file (Gate 3 decision 3), and to read every link back after
 * a split. Finds wikilinks ([[path#sub|alias]], ![[...]]) and markdown links ([text](path#sub), ![..](..)) in the
 * body, outside front matter, fenced code / comment / math blocks and inline code.
 */
import { headingLevel, headingText, parseDoc } from "./sections";
import { BLOCK, blockKey, normHeading } from "./links";

export { BLOCK };

export interface TextLink {
	kind: "wiki" | "md";
	/** Offsets of the whole link in the text. */
	start: number;
	end: number;
	original: string;
	embed: boolean;
	/** Link path, decoded for markdown links; "" for a same-note link like [[#Heading]] or [x](#Heading). */
	path: string;
	/** Text after the first "#", decoded ("" if none). */
	sub: string;
	/** Wikilink alias after "|", if any. */
	alias?: string;
	/** Wikilink whose alias pipe is escaped as "\\|" (how aliases are written inside a markdown table). */
	pipeEscaped?: boolean;
	/** Markdown links: offsets of the URL (inside <> if angle-bracketed) within the whole link, and its form. */
	url?: { from: number; to: number; angle: boolean };
}

const WIKI = /(!?)\[\[([^[\]|\n]*?)(?:\|([^[\]\n]*?))?\]\]/g;
const MD = /(!?)\[((?:[^[\]]|\[[^[\]\n]*\])*)\]\(\s*(<[^<>\n]*>|(?:[^()\s]|\([^()\s]*\))*)(\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/g;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

function decode(s: string): string {
	try {
		return decodeURIComponent(s);
	} catch {
		return s;
	}
}

/** Blank out inline code spans (same length), so links inside them are not seen. */
function maskInlineCode(s: string): string {
	return s.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (m) => " ".repeat(m.length));
}

/** True if `original` is a wikilink whose alias pipe is written "\\|" (table form). */
export function hasEscapedPipe(original: string): boolean {
	const l = findLinks(original)[0];
	return !!l && l.kind === "wiki" && !!l.pipeEscaped;
}

/**
 * A generated wikilink with its alias pipe escaped ("[[New#H|a]]" -> "[[New#H\\|a]]"), so it stays inside its table
 * cell. Obsidian's generateMarkdownLink never escapes it. Markdown links and links without an alias are returned as is.
 */
export function escapeAliasPipe(link: string): string {
	if (!/^!?\[\[/.test(link)) return link;
	return link.replace(/(?<!\\)\|/, "\\|");
}

export function findLinks(text: string): TextLink[] {
	const doc = parseDoc(text);
	const out: TextLink[] = [];
	// Wikilinks never span lines. Groups are read from the original text: inline code is masked only to decide what
	// is a link, so [[Filters#`wikilink`|x]] keeps its anchor (corpus finding, Gate 3 round 2).
	for (const l of doc.lines) {
		if (l.inCode || !l.text.includes("[[")) continue;
		const line = maskInlineCode(l.text);
		for (const m of line.matchAll(WIKI)) {
			const at = m.index;
			const original = l.text.slice(at, at + m[0].length);
			// Same length as the masked match, so the groups sit at the same offsets.
			const tAt = m[1]!.length + 2;
			let target = original.slice(tAt, tAt + m[2]!.length);
			// [[Note#H\|alias]] (table form): the "\" belongs to the pipe, not the link, as Obsidian reads it.
			const pipeEscaped = m[3] !== undefined && target.endsWith("\\");
			if (pipeEscaped) target = target.slice(0, -1);
			const alias = m[3] === undefined ? undefined : original.slice(tAt + m[2]!.length + 1, tAt + m[2]!.length + 1 + m[3].length);
			const hash = target.indexOf("#");
			out.push({
				kind: "wiki",
				start: l.from + at,
				end: l.from + at + m[0].length,
				original,
				embed: m[1] === "!",
				path: (hash < 0 ? target : target.slice(0, hash)).trim(),
				sub: hash < 0 ? "" : target.slice(hash + 1).trim(),
				alias,
				...(pipeEscaped ? { pipeEscaped } : {}),
			});
		}
	}
	// Markdown links: the link text may wrap onto the next lines of the same paragraph, as Obsidian reads them
	// ([“Handling Potential Failure with⏎`Result`”](#...)). Runs of non-blank lines outside code; a heading is its own run.
	const runs: (typeof doc.lines)[] = [];
	let cur: typeof doc.lines = [];
	const flush = () => {
		if (cur.length) runs.push(cur);
		cur = [];
	};
	for (const l of doc.lines) {
		if (l.inCode || !l.text.trim()) {
			flush();
			continue;
		}
		if (headingLevel(l)) {
			flush();
			runs.push([l]);
			continue;
		}
		cur.push(l);
	}
	flush();
	const wikiSpans = out.map((w) => [w.start, w.end] as const);
	for (const run of runs) {
		if (!run.some((l) => l.text.includes("]("))) continue;
		const from = run[0]!.from;
		const last = run[run.length - 1]!;
		const orig = text.slice(from, last.from + last.text.length);
		const masked = run.map((l) => maskInlineCode(l.text) + (l === last ? "" : l.eol)).join("");
		for (const m of masked.matchAll(MD)) {
			const at = m.index;
			const start = from + at;
			const end = start + m[0].length;
			if (wikiSpans.some(([a, b]) => start < b && end > a)) continue;
			const original = orig.slice(at, at + m[0].length);
			const rawAt = m[0].indexOf(m[3]!, m[1]!.length + m[2]!.length + 2);
			const rawUrl = original.slice(rawAt, rawAt + m[3]!.length);
			const angle = rawUrl.startsWith("<");
			const url = angle ? rawUrl.slice(1, -1) : rawUrl;
			if (!url || SCHEME.test(url)) continue;
			const hash = url.indexOf("#");
			const urlAt = rawAt + (angle ? 1 : 0);
			out.push({
				kind: "md",
				start,
				end,
				original,
				embed: m[1] === "!",
				path: decode(hash < 0 ? url : url.slice(0, hash)),
				sub: hash < 0 ? "" : decode(url.slice(hash + 1)),
				url: { from: urlAt, to: urlAt + url.length, angle },
			});
		}
	}
	return out.sort((a, b) => a.start - b.start);
}

/** Headings (normalised) and block ids present in a note's text, for checking that a #subpath still resolves. */
export function anchorsIn(text: string): { headings: Set<string>; blocks: Set<string> } {
	const headings = new Set<string>();
	const blocks = new Set<string>();
	for (const l of parseDoc(text).lines) {
		if (l.inCode) continue;
		if (headingLevel(l)) headings.add(normHeading(headingText(l)));
		const b = BLOCK.exec(l.text);
		if (b) blocks.add(blockKey(b[1]!));
	}
	return { headings, blocks };
}

/** True if `sub` ("Heading", "A#B", "^id" or "") names something in the note. */
export function hasAnchor(a: { headings: Set<string>; blocks: Set<string> }, sub: string): boolean {
	if (!sub) return true;
	if (sub.startsWith("^")) return a.blocks.has(blockKey(sub.slice(1)));
	return a.headings.has(normHeading(sub.split("#").pop() ?? ""));
}

/** Path of `to` relative to the folder `fromFolder` ("" = vault root), e.g. ("Out/x", "img/a.png") -> "../../img/a.png". */
export function relativePath(fromFolder: string, to: string): string {
	const a = fromFolder ? fromFolder.split("/") : [];
	const b = to.split("/");
	let i = 0;
	while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
	return [...a.slice(i).map(() => ".."), ...b.slice(i)].join("/");
}

/** Encode a path for a markdown link URL the way Obsidian writes them (spaces and a few specials escaped). */
export function encodeMdPath(p: string): string {
	return p.replace(/[ %()<>#^[\]|]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
}
