/**
 * fast-check generators shared by the no-text-loss suites (tests/property.test.ts, tests/inbox-property.test.ts).
 * Moved here unchanged from property.test.ts in Gate 2 so a second suite can reuse them without re-running the first.
 */
import fc from "fast-check";

export const SEED = Number(process.env.FC_SEED ?? 20261030);
export const RUNS = Number(process.env.FC_RUNS ?? 5000);
export const PARAMS = { seed: SEED, numRuns: RUNS, endOnFailure: false } as const;

// ---------- generators ----------

const SPECIAL_LINES = [
	// headings at every level, not-headings, setext, breaks
	"# H1", "## H2 ^blk", "### H3 #tag", "#### H4", "##### H5", "###### H6", "####### seven", "#notheading", "#", "#\ttab heading",
	"  ## indented2", "    # indented code", "Setext", "===", "---", "***", "___", "- - -", "+++",
	// code fences
	"```", "~~~", "````md", "```js", "  ```", "````",
	// callouts and quotes
	"> [!note] Callout", "> [!tip]- Folded", "> # heading in callout", "> ```", "> > nested", ">",
	// %% comments and $$ math
	"%%", "%% # in comment %%", "%% start", "end %%", "text %% inline %% more", "$$", "$$ x = 1", "x $$", "# in math?", "$$x^2$$", "`%%` code",
	// footnotes, embeds, links, block ids
	"[^1]: footnote def", "[^note]:", "Text with ref[^1]", "![[Embed.png]]", "![[Note#Sec|alias]]", "[[#Same note heading]]", "[[Other#^abc]]",
	"para ^block-id", "^standalone-id", "<div># html</div>", "- [ ] task", "\t- nested", "| a | b |", "|---|---|",
	// front-matter-like and odd characters
	"\uFEFF---", "\uFEFF# bom heading", "a\rlone", "\r", "zero\u200bwidth", "e\u0301", "🧪🔥👩‍👩‍👧", "🇺🇸", "日本語 עברית العربية", "\u202Ertl override",
	"\u0000nul", "\u0000", "tab\there", "  ", "", "x".repeat(500), "CON", "$& $' $`", "trailing.  ",
];
/** Lines that open a region swallowing the rest of the note when unbalanced; kept rare so headings still occur. */
const OPENERS = new Set(["```", "~~~", "````md", "```js", "  ```", "````", "%%", "%% start", "end %%", "$$", "$$ x = 1", "x $$", "> ```"]);
const HEADING = fc.tuple(fc.integer({ min: 1, max: 6 }), fc.oneof(fc.string({ unit: "grapheme", minLength: 1, maxLength: 20 }), fc.constantFrom("Alpha", "Beta ☕", "CON", "$&", "Title.", "日本語", "a/b", "^blk")))
	.map(([n, t]) => `${"#".repeat(n)} ${t}`);
/** A balanced fenced/comment/math block with heading- and delimiter-like lines inside. */
const BLOCK = fc.tuple(
	fc.constantFrom<[string, string]>(["```", "```"], ["~~~", "~~~"], ["````md", "````"], ["%%", "%%"], ["%% note", "end %%"], ["$$", "$$"], ["$$ a", "b $$"]),
	fc.array(fc.constantFrom("# inside", "## inside", "---", "***", "text", "", "```", "%%%%", "$x$"), { maxLength: 5 }),
).map(([[open, close], inner]) => [open, ...inner.filter((l) => !(l === "```" && open.startsWith("```"))), close].join("\n"));
const LINE = fc.oneof(
	{ weight: 20, arbitrary: fc.constantFrom(...SPECIAL_LINES.filter((l) => !OPENERS.has(l))) },
	{ weight: 15, arbitrary: HEADING },
	{ weight: 5, arbitrary: BLOCK },
	{ weight: 1, arbitrary: fc.constantFrom(...OPENERS) },
	{ weight: 10, arbitrary: fc.string({ unit: "grapheme", maxLength: 40 }) },
	{ weight: 4, arbitrary: fc.string({ unit: "binary", maxLength: 20 }) }, // any code points, incl. lone surrogates
);
const EOL = fc.constantFrom("\n", "\r\n", "\n", "\r\n", "\r\r\n");
const FRONT_MATTER = fc.oneof(
	fc.constant(""),
	fc.tuple(fc.constantFrom("", "\uFEFF"), fc.constantFrom("\n", "\r\n"), fc.array(fc.constantFrom("tags: [a]", "title: x", "aliases: [y]", "k: ---", "  ---", "key: |", "  # not heading", ""), { maxLength: 4 }), fc.boolean())
		.map(([bom, e, props, closed]) => bom + ["---", ...props, ...(closed ? ["---"] : [])].join(e) + e),
);
const BODY_LINES = fc.array(fc.tuple(LINE, EOL), { maxLength: 120, size: "max" });
/** Rarely, a long note (1-4k lines) made by repeating a generated chunk, to keep generation fast. */
const LONG_LINES = fc.tuple(fc.array(fc.tuple(LINE, EOL), { minLength: 5, maxLength: 40, size: "max" }), fc.integer({ min: 30, max: 100 })).map(([chunk, k]) => Array.from({ length: k }, () => chunk).flat());

export const NOTE = fc
	.record({
		fm: FRONT_MATTER,
		lines: fc.oneof({ weight: 49, arbitrary: BODY_LINES }, { weight: 1, arbitrary: LONG_LINES }),
		last: fc.boolean(),
	})
	.map(({ fm, lines, last }) => {
		let s = fm;
		lines.forEach(([l, e], i) => {
			s += l + (i < lines.length - 1 || last ? e : "");
		});
		return s;
	});

