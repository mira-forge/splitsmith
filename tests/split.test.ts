import { describe, expect, it } from "vitest";
import { firstText, headingCounts, lineAtOffset, parseDoc, partAtLine, partsByDelimiter, partsByHeading, partText, safeTitle, tokenize } from "../src/core/sections";
import { buildSegmentPrompt, parsePlan, validatePlan } from "../src/core/segment";

const NOTE = ["---", "tags: [a]", "---", "Intro line", "## One", "text 1", "```py", "## not a heading", "```", "## Two", "text 2"].join("\n");

describe("sections", () => {
	const doc = parseDoc(NOTE);
	it("keeps front matter separate, with exact offsets", () => {
		expect(doc.frontmatter).toBe("---\ntags: [a]\n---");
		expect(doc.lines[0]!.text).toBe("Intro line");
		expect(NOTE.slice(doc.bodyFrom)).toMatch(/^Intro line/);
		expect(doc.lines.map((l) => NOTE.slice(l.from, l.to)).join("")).toBe(NOTE.slice(doc.bodyFrom));
	});
	it("ignores headings inside code blocks", () => {
		const parts = partsByHeading(doc, 2);
		expect(parts.map((p) => p.title)).toEqual(["One", "Two"]);
		expect(partText(doc, parts[0]!)).toContain("## not a heading");
		expect(headingCounts(doc)[2]).toBe(2);
	});
	it("nested headings: a higher-level heading ends the part and stays in the note", () => {
		const d = parseDoc("# Book\n## A\na\n### A.1\na1\n# Appendix\nx\n## B\nb");
		const parts = partsByHeading(d, 2);
		expect(parts.map((p) => [p.title, p.start, p.end])).toEqual([["A", 1, 4], ["B", 7, 8]]);
		expect(partsByHeading(d, 3).map((p) => [p.title, p.start, p.end])).toEqual([["A.1", 3, 4]]);
	});
	it("splits by delimiter, ignoring setext underlines and code", () => {
		const d = parseDoc("a\n\n---\nb\n\n---\nc");
		expect(partsByDelimiter(d).map((p) => partText(d, p))).toEqual(["a", "b", "c"]);
		const setext = parseDoc("Title\n---\nbody\n\n---\nnext\n```\n---\n```");
		expect(partsByDelimiter(setext).map((p) => p.title)).toEqual(["Title", "next"]);
		const custom = parseDoc("one\n%%split%%\ntwo");
		expect(partsByDelimiter(custom, "%%split%%").map((p) => p.title)).toEqual(["one", "two"]);
	});
	it("tokenizes CRLF, LF and a missing final newline exactly", () => {
		const t = tokenize("a\r\nb\nc");
		expect(t.map((l) => [l.text, l.eol])).toEqual([["a", "\r\n"], ["b", "\n"], ["c", ""]]);
		expect(tokenize("")).toEqual([]);
		expect(parseDoc("x\r\ny\r\n").eol).toBe("\r\n");
	});
	it("cursor split and offsets", () => {
		const d = parseDoc("---\na: 1\n---\nl0\nl1\nl2");
		expect(lineAtOffset(d, 0)).toBe(-1);
		expect(lineAtOffset(d, d.lines[1]!.from + 1)).toBe(1);
		expect(partAtLine(d, 1)).toEqual([{ title: "l1", start: 1, end: 2 }]);
	});
	it("makes file-safe titles", () => {
		expect(safeTitle("What is [x]? a/b")).toBe("What is x a b");
		expect(safeTitle("..hidden\u0007")).toBe("hidden");
		expect(safeTitle("   ")).toBe("Untitled");
		expect(safeTitle("Café ☕ 日本")).toBe("Café ☕ 日本");
	});
});

describe("AI plan validation", () => {
	const doc = parseDoc("l0\nl1\nl2\n```\ncode\n```\nl6");
	it("numbers lines and never asks for text back", () => {
		const p = buildSegmentPrompt(doc, { maxParts: 4 });
		expect(p.user.split("\n")[0]).toBe("0| l0");
		expect(p.system).toContain("Do not rewrite");
		expect(p.system).toContain("from 0 to 6");
	});
	it("accepts a full, ordered plan and makes titles file-safe", () => {
		const plan = parsePlan('Sure: {"parts":[{"title":"A/B?","start":0,"end":2},{"title":"C","start":3,"end":6}]}');
		expect(validatePlan(doc, plan, 4)).toEqual([{ title: "A B", start: 0, end: 2 }, { title: "C", start: 3, end: 6 }]);
	});
	it("rejects dropped (skipped) lines", () => {
		expect(() => validatePlan(doc, [{ title: "A", start: 0, end: 1 }, { title: "B", start: 3, end: 6 }], 4)).toThrow(/skips lines 2 to 2/);
	});
	it("rejects overlapping ranges", () => {
		expect(() => validatePlan(doc, [{ title: "A", start: 0, end: 3 }, { title: "B", start: 2, end: 6 }], 4)).toThrow(/overlapping/);
		expect(() => validatePlan(doc, [{ title: "A", start: 0, end: 6 }, { title: "B", start: 0, end: 6 }], 4)).toThrow(/overlapping/);
	});
	it("rejects missing lines at the end, out-of-range and reversed ranges", () => {
		expect(() => validatePlan(doc, [{ title: "A", start: 0, end: 5 }], 4)).toThrow(/leaves out lines 6 to 6/);
		expect(() => validatePlan(doc, [{ title: "A", start: 0, end: 9 }], 4)).toThrow(/invalid range/);
		expect(() => validatePlan(doc, [{ title: "A", start: 0, end: -1 }], 4)).toThrow(/invalid range/);
	});
	it("rejects non-numeric lines, empty titles and empty plans", () => {
		expect(() => validatePlan(doc, parsePlan('{"parts":[{"title":"A","start":"x","end":6}]}'), 4)).toThrow(/non-numeric/);
		expect(() => validatePlan(doc, parsePlan('{"parts":[{"title":1.5,"start":0,"end":6}]}'), 4)).toThrow(/no title/);
		expect(() => validatePlan(doc, [], 4)).toThrow(/empty/);
		expect(() => validatePlan(doc, [{ title: "A", start: 0.5, end: 6 }], 4)).toThrow(/non-numeric/);
	});
	it("rejects a cut inside a code block but allows a cut right at its fence", () => {
		expect(() => validatePlan(doc, [{ title: "A", start: 0, end: 3 }, { title: "B", start: 4, end: 6 }], 4)).toThrow(/code block/);
		expect(() => validatePlan(doc, [{ title: "A", start: 0, end: 4 }, { title: "B", start: 5, end: 6 }], 4)).toThrow(/code block/);
		expect(validatePlan(doc, [{ title: "A", start: 0, end: 2 }, { title: "B", start: 3, end: 5 }, { title: "C", start: 6, end: 6 }], 4)).toHaveLength(3);
		const two = parseDoc("```\na\n```\n```\nb\n```");
		expect(validatePlan(two, [{ title: "A", start: 0, end: 2 }, { title: "B", start: 3, end: 5 }], 4)).toHaveLength(2);
	});
	it("enforces the part cap", () => {
		const plan = [0, 1, 2, 3, 4].map((i) => ({ title: "t", start: i === 3 ? 3 : i, end: i === 4 ? 6 : i === 3 ? 5 : i }));
		expect(() => validatePlan(doc, plan, 4)).toThrow(/limit is 4/);
	});
	it("rejects replies that are not a plan", () => {
		expect(() => parsePlan("I can't help with that")).toThrow(/did not return/);
		expect(() => parsePlan("{not json}")).toThrow(/not valid JSON/);
		expect(() => parsePlan('{"cuts":[]}')).toThrow(/no parts/);
	});
	it("titles skip delimiter lines and drop trailing block ids", () => {
		const doc = parseDoc("---\n\nthird part ^p3\n");
		expect(firstText(doc, 0, 2)).toBe("third part ^p3");
		expect(safeTitle("third part ^p3")).toBe("third part");
		expect(safeTitle("a ^ b")).toBe("a b");
	});
});
