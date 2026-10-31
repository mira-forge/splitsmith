/**
 * Markdown structure for splitting. Pure functions, no Obsidian imports, so they are unit-tested.
 *
 * Byte-exact: every line keeps its own line ending ("\n", "\r\n" or "" for a last line without one) and
 * its character offsets in the original note, so any range of lines can be cut out of the original
 * string verbatim. Lines inside fenced code blocks are never treated as headings or delimiters
 * (Note Refactor issue #43: "takes comments in code blocks as headings").
 */

export interface Line {
	/** Line text without its line ending. */
	text: string;
	/** The line ending that followed it in the original ("" only for a final line without one). */
	eol: string;
	/** 0-based line number in the whole note (front matter included). */
	n: number;
	/** Offsets into the original string: [from, to) covers text + eol. */
	from: number;
	to: number;
	inCode: boolean;
	/** Index of the fenced code block this line belongs to (fences included), or -1. */
	block: number;
}

export interface Doc {
	/** The note exactly as read. */
	raw: string;
	/** Raw front matter including both --- fences but not the final line ending, or "" if none. */
	frontmatter: string;
	/** Offset where the body starts (right after the front matter's closing line ending). */
	bodyFrom: number;
	/** Body lines after the front matter. */
	lines: Line[];
	/** Line ending used for text the plugin inserts: the note's first line ending, else "\n". */
	eol: string;
}

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;

export function tokenize(raw: string): { text: string; eol: string; from: number; to: number }[] {
	const out: { text: string; eol: string; from: number; to: number }[] = [];
	let i = 0;
	while (i < raw.length) {
		const nl = raw.indexOf("\n", i);
		if (nl < 0) {
			out.push({ text: raw.slice(i), eol: "", from: i, to: raw.length });
			break;
		}
		const cr = nl > i && raw[nl - 1] === "\r";
		out.push({ text: raw.slice(i, cr ? nl - 1 : nl), eol: cr ? "\r\n" : "\n", from: i, to: nl + 1 });
		i = nl + 1;
	}
	return out;
}

/** True for the opening/closing line of front matter. A UTF-8 BOM may precede the first one. */
function isFmFence(text: string, first: boolean): boolean {
	return (first ? text.replace(/^\uFEFF/, "") : text) === "---";
}

/** Number of non-overlapping occurrences of `tok` in `s`. */
function count(s: string, tok: string): number {
	s = s.replace(/`[^`]*`/g, ""); // inline code is literal text
	let n = 0;
	for (let i = s.indexOf(tok); i >= 0; i = s.indexOf(tok, i + tok.length)) n++;
	return n;
}

export function parseDoc(raw: string): Doc {
	const all = tokenize(raw);
	let start = 0;
	let frontmatter = "";
	let bodyFrom = 0;
	// Front matter: "---" on the very first line (a leading BOM is allowed, gap 2), closed by a later "---".
	if (all[0] && isFmFence(all[0].text, true)) {
		const end = all.findIndex((l, i) => i > 0 && l.text === "---");
		if (end > 0) {
			const close = all[end]!;
			frontmatter = raw.slice(0, close.to - close.eol.length);
			bodyFrom = close.to;
			start = end + 1;
		}
	}
	const lines: Line[] = [];
	// Opaque regions where nothing is a heading or delimiter and no cut may fall inside (gap 5):
	// fenced code (``` / ~~~), %% comment blocks and $$ math blocks.
	let mode: "none" | "fence" | "comment" | "math" = "none";
	let fence = "";
	let blocks = -1;
	for (let i = start; i < all.length; i++) {
		const t = all[i]!;
		const text = i === 0 ? t.text.replace(/^\uFEFF/, "") : t.text;
		let inCode = mode !== "none";
		const wasIn = mode !== "none";
		if (mode === "none") {
			const m = FENCE.exec(text);
			if (m) {
				const marker = m[1]!;
				fence = marker[0]!.repeat(marker.length);
				mode = "fence";
				inCode = true;
				blocks++;
			} else if (count(text, "%%") % 2 === 1) {
				// An unclosed %% opens a comment that runs until the next %%. The opening line itself
				// starts outside the comment, so a heading before the %% still counts.
				mode = "comment";
				inCode = /^\s*%%/.test(text);
				blocks++;
			} else if (/^\s*\$\$/.test(text) && count(text, "$$") % 2 === 1) {
				mode = "math";
				inCode = true;
				blocks++;
			}
		} else if (mode === "fence") {
			const m = FENCE.exec(text);
			if (m && m[1]![0] === fence[0] && m[1]!.length >= fence.length && text.trim() === m[1]) mode = "none";
		} else if (mode === "comment") {
			if (count(text, "%%") % 2 === 1) mode = "none";
		} else if (mode === "math") {
			if (count(text, "$$") % 2 === 1) mode = "none";
		}
		// The opening line of a region belongs to it (no cut right after it) even when it is not opaque itself.
		const inBlock = inCode || wasIn || mode !== "none";
		lines.push({ ...t, n: i, inCode, block: inBlock ? blocks : -1 });
	}
	return { raw, frontmatter, bodyFrom, lines, eol: all.find((l) => l.eol)?.eol ?? "\n" };
}

export function headingLevel(l: Line): number {
	if (l.inCode) return 0;
	const m = /^ {0,3}(#{1,6})[ \t]+\S/.exec(bodyText(l));
	return m ? m[1]!.length : 0;
}

/** Line text with a leading BOM removed on the note's first line. */
function bodyText(l: Line): string {
	return l.n === 0 ? l.text.replace(/^\uFEFF/, "") : l.text;
}

export function headingText(l: Line): string {
	return bodyText(l).replace(/^ {0,3}#{1,6}[ \t]+/, "").replace(/[ \t]+#+[ \t]*$/, "").trim();
}

/** How many headings of each level (index 1-6) the body has, outside code. */
export function headingCounts(doc: Doc): number[] {
	const c = [0, 0, 0, 0, 0, 0, 0];
	for (const l of doc.lines) c[headingLevel(l)]!++;
	c[0] = 0;
	return c;
}

/** A contiguous run of body lines that will become one new note. Inclusive 0-based indices into Doc.lines. */
export interface Part {
	title: string;
	start: number;
	end: number;
}

/** Split at every heading of exactly `level` (1-6). A part runs until the next heading of that level or higher. Text before the first one stays. */
export function partsByHeading(doc: Doc, level: number): Part[] {
	const parts: Part[] = [];
	let cur: Part | null = null;
	for (let i = 0; i < doc.lines.length; i++) {
		const l = doc.lines[i]!;
		const h = headingLevel(l);
		if (!h || h > level) continue;
		if (cur) parts.push({ ...cur, end: i - 1 });
		cur = h === level ? { title: headingText(l), start: i, end: i } : null;
	}
	if (cur) parts.push({ ...cur, end: doc.lines.length - 1 });
	return parts;
}

const BREAK = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;

/**
 * Split at lines that equal the delimiter (default a thematic break "---"). Delimiter lines are not
 * moved: they stay in the source note between the links. A "---" right under a paragraph line is a
 * setext heading underline, not a break, so it is ignored.
 */
export function partsByDelimiter(doc: Doc, delimiter = "---"): Part[] {
	const d = delimiter.trim();
	const isBreak = BREAK.test(d);
	const parts: Part[] = [];
	let s = 0;
	const push = (e: number) => {
		const t = firstText(doc, s, e);
		if (t !== null) parts.push({ title: t, start: s, end: e });
	};
	doc.lines.forEach((l, i) => {
		if (l.inCode || l.text.trim() !== d) return;
		if (isBreak && i > 0 && doc.lines[i - 1]!.text.trim() !== "" && !doc.lines[i - 1]!.inCode) return; // setext underline
		push(i - 1);
		s = i + 1;
	});
	push(doc.lines.length - 1);
	// One part means the note has no delimiter between two pieces of text: everything outside it is delimiter
	// lines, rules or blanks. Moving it would move the whole note, so there is nothing to split.
	return parts.length > 1 ? parts : [];
}

/** Everything from the cursor's line to the end of the note becomes one new note. */
export function partAtLine(doc: Doc, bodyLine: number): Part[] {
	const t = firstText(doc, bodyLine, doc.lines.length - 1);
	return t === null ? [] : [{ title: t, start: bodyLine, end: doc.lines.length - 1 }];
}

export function firstText(doc: Doc, s: number, e: number): string | null {
	for (let i = Math.max(0, s); i <= e; i++) {
		const t = doc.lines[i]?.text.trim();
		// Skip blank lines, rules and delimiters such as "---" or "***": they make poor titles.
		if (t && !/^([-*_=~+])(\s*\1){2,}$/.test(t)) return t.replace(/^#{1,6}\s+/, "").slice(0, 80);
	}
	return null;
}

/** Body line index containing a character offset of the raw note (-1 inside front matter). */
export function lineAtOffset(doc: Doc, offset: number): number {
	if (offset < doc.bodyFrom) return -1;
	const i = doc.lines.findIndex((l) => offset < l.to);
	return i < 0 ? doc.lines.length - 1 : i;
}

const WIN_RESERVED = /^(con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])(\..*)?$/i;
const MAX_TITLE = 120;

/** Cut to at most `max` user-perceived characters (grapheme clusters, else code points): never a lone surrogate. */
function cutGraphemes(s: string, max: number): string {
	const Seg = (Intl as unknown as { Segmenter?: new (l?: string, o?: { granularity: string }) => { segment(s: string): Iterable<{ segment: string }> } }).Segmenter;
	const units = Seg ? Array.from(new Seg(undefined, { granularity: "grapheme" }).segment(s), (x) => x.segment) : Array.from(s);
	return units.length > max ? units.slice(0, max).join("") : s;
}

/**
 * File-name safe title. Obsidian rejects * " \ / < > : | ? # ^ [ ]; control characters become spaces;
 * no leading dots (hidden files), no trailing dots or spaces (Windows drops them), no Windows device
 * names (CON, NUL, COM1, LPT1, ... with or without an extension, any case), at most 120 characters
 * cut on character boundaries (gap 4).
 */
export function safeTitle(t: string): string {
	let s = Array.from(t.replace(/\s\^[\w-]+\s*$/, ""), (c) => (c.charCodeAt(0) < 32 || c === "\u007f" ? " " : c))
		.join("")
		.replace(/[*"\\/<>:|?#^[\]]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^\.+/, "");
	s = cutGraphemes(s, MAX_TITLE).replace(/[\s.]+$/, "").trim();
	if (WIN_RESERVED.test(s)) s = s.replace(/^([^.]*)/, "$1_");
	return s || "Untitled";
}

/** Display helper only (preview); never used for what is written. */
export function partText(doc: Doc, p: { start: number; end: number }): string {
	return doc.lines
		.slice(p.start, p.end + 1)
		.map((l) => l.text)
		.join("\n")
		.replace(/^\n+|\n+$/g, "");
}
