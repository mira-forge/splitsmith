/** Gate 1 (SPLITSMITH_STATE.md section 3): gap 2 (BOM front matter) and gap 5 (%% comments, $$ math). */
import { describe, expect, it } from "vitest";
import { headingCounts, parseDoc, partsByDelimiter, partsByHeading } from "../src/core/sections";
import { validatePlan, windows } from "../src/core/segment";
import { planFromParts } from "../src/core/plan";

describe("gap 2: BOM before front matter", () => {
	const raw = "\uFEFF---\ntags: [a]\n---\nbody one\n\n---\n\nbody two";
	it("is detected as front matter, so properties stay in the source", () => {
		const doc = parseDoc(raw);
		expect(doc.frontmatter).toBe("\uFEFF---\ntags: [a]\n---");
		expect(doc.bodyFrom).toBe(raw.indexOf("body one"));
		const plan = planFromParts(doc, partsByDelimiter(doc));
		expect(plan.parts.map((p) => raw.slice(p.from, p.to))).toEqual(["body one\n", "body two"]);
	});
	it("CRLF + BOM front matter, and BOM heading on line 1 without front matter", () => {
		const crlf = "\uFEFF---\r\ntags: [a]\r\n---\r\n# A\r\nx";
		expect(parseDoc(crlf).bodyFrom).toBe(crlf.indexOf("# A"));
		const h = "\uFEFF# First\nx\n# Second\ny";
		const doc = parseDoc(h);
		expect(partsByHeading(doc, 1).map((p) => p.title)).toEqual(["First", "Second"]);
	});
	it("unclosed BOM front matter is body text (as before), never lost", () => {
		const u = "\uFEFF---\ntags: [a]\nbody";
		const doc = parseDoc(u);
		expect(doc.frontmatter).toBe("");
		expect(doc.bodyFrom).toBe(0);
	});
});

describe("gap 5: headings inside %% comments and $$ math are not split points", () => {
	it.each([
		["# A\nx\n%%\n# hidden in comment\n%%\n", 1],
		["# A\n$$\n# not heading in math\n$$\n", 1],
		["# A\n%% start\n# hidden\nend %%\n# B\n", 2],
		["# A\n$$ x = 1\n# hidden\n$$\n# B\n", 2],
		["# A\n%% inline %%\n# B\n", 2],
		["# A\n$$x$$\n# B\n", 2],
		["# A\n```\n%%\n```\n# B\n", 2],
		["# A\n`%%` in code\n# B\n", 2],
		["# A\n%%\n```\n%%\n# B\n", 2],
		["# A\n%%\n# C\n", 1],
	])("%j has %i part(s)", (raw, n) => {
		expect(partsByHeading(parseDoc(raw), 1)).toHaveLength(n);
	});
	it("delimiters inside them are ignored, heading counts skip them, AI plans can't cut through them, windows don't cut inside", () => {
		const raw = "a\n\n---\n\nb\n%%\n---\n# h\n%%\nc\n$$\n---\n$$\nd";
		const doc = parseDoc(raw);
		expect(partsByDelimiter(doc)).toHaveLength(2);
		expect(headingCounts(doc)[1]).toBe(0);
		const at = doc.lines.findIndex((l) => l.text === "---" && l.inCode);
		expect(() => validatePlan(doc, [{ title: "x", start: 0, end: at - 1 }, { title: "y", start: at, end: doc.lines.length - 1 }], 4)).toThrow(/cuts through/);
		const long = parseDoc(["x", "%%", ...Array.from({ length: 50 }, () => ""), "%%", "y"].join("\n"));
		for (const w of windows(long, 20)) expect(long.lines[w.start]!.block >= 0 && long.lines[w.start - 1]?.block === long.lines[w.start]!.block).toBe(false);
	});
});
