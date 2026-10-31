/** Gate 1 (SPLITSMITH_STATE.md section 3): gap 3 (file name template) and gap 4 (safeTitle). */
import { describe, expect, it } from "vitest";
import { TFile } from "./obsidian-mock";
import { applySplit } from "../src/core/apply";
import { parseDoc, partsByHeading, safeTitle } from "../src/core/sections";
import { fileNameFrom, planFromParts } from "../src/core/plan";
import { OPTS, makeApp } from "./mock-app";

describe("gap 3: file name template inserts values literally", () => {
	const v = (title: string) => ({ source: "S$1", title, n: 1, date: "2026-10-26" });
	it.each(["$&", "x$'y", "a$`b", "$$", "$1", "{{title}}", "{{source}}"])("title case %#", (t) => {
		expect(fileNameFrom("{{title}}", v(t))).toBe(t);
		expect(fileNameFrom("{{source}} - {{title}} {{n}}", v(t))).toBe(`S$1 - ${t} 1`);
	});
	it("end to end: a heading '$& and $'' becomes a note with that name", async () => {
		const raw = "intro\n# Price $& and $' x\nbody";
		const { app, vault } = makeApp({ "Big.md": raw }, "Big.md");
		const doc = parseDoc(raw);
		const r = await applySplit(app as never, new TFile("Big.md"), planFromParts(doc, partsByHeading(doc, 1)), { ...OPTS, inherit: "none", sourceProperty: "" });
		expect(r.created).toEqual(["Price $& and $' x.md"]);
		expect(vault.files.get("Price $& and $' x.md")).toBe(raw.slice("intro\n".length));
	});
});

describe("gap 4: safeTitle", () => {
	it.each([
		["CON", "CON_"], ["nul", "nul_"], ["COM1", "COM1_"], ["lpt9", "lpt9_"], ["Aux.txt", "Aux_.txt"], ["com¹", "com¹_"], ["PRN ", "PRN_"],
		["CONSOLE", "CONSOLE"], ["COM10", "COM10"], ["Title.", "Title"], ["Title. . ", "Title"], ["Title ", "Title"], ["...", "Untitled"], [".obsidian", "obsidian"],
		["a\u0000b", "a b"], ["$&", "$&"], ["a/b:c", "a b c"], ["con.", "con_"],
	])("%j -> %j", (input, out) => {
		expect(safeTitle(input)).toBe(out);
	});
	it("never ends in a lone surrogate or a broken emoji, at any offset", () => {
		const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
		for (const pre of ["", "a", "ab", "abc"]) {
			for (const e of ["🧪", "👩‍👩‍👧", "🇺🇸", "e\u0301"]) {
				const s = safeTitle(pre + e.repeat(130));
				expect(lone.test(s)).toBe(false);
				expect(s.endsWith(e)).toBe(true);
				expect([...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(s)].length).toBe(120);
			}
		}
	});
});
