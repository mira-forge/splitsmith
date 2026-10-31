/**
 * Free-only RC (Oct 31): one-part guard for delimiter splits (Inbox with a "---" preset never moves a note's only
 * text and leaves a bare rule), and self-referencing heading links inside a moved part stay working.
 */
import { describe, expect, it, vi } from "vitest";
import { TFile } from "./obsidian-mock";
import { applySplit, undoSplit } from "../src/core/apply";
import { parseDoc, partsByDelimiter, partsByHeading } from "../src/core/sections";
import { movesWholeNote, planFromParts } from "../src/core/plan";
import { OPTS, makeApp } from "./mock-app";

vi.stubGlobal("window", { setInterval: () => 1, open: () => null });

describe("one-part guard", () => {
	const cases: [string, string][] = [
		["text, then a delimiter and only whitespace", "Only text here\n---\n \u00a0\n"],
		["delimiter first, then text", "---\nOnly text here\n"],
		["text between two delimiters", "\n---\nOnly text\n---\n"],
		["front matter, a rule and text", "---\ntags: [a]\n---\n***\nOnly text\n"],
	];
	for (const [name, raw] of cases) {
		it(`delimiter "---" on ${name}: nothing to split`, () => {
			const doc = parseDoc(raw);
			expect(planFromParts(doc, partsByDelimiter(doc, "---"), 2).parts).toEqual([]);
		});
	}
	it("a real two-part delimiter split still plans two notes", () => {
		const doc = parseDoc("One\n\n---\nTwo\n");
		expect(planFromParts(doc, partsByDelimiter(doc, "---"), 2).parts.length).toBe(2);
	});
	it("a single part that leaves only a rule behind counts as moving the whole note", () => {
		const raw = "Only text\n\n---\n";
		expect(movesWholeNote({ raw, bodyFrom: 0, eol: "\n", parts: [{ title: "Only text", from: 0, to: 9 }] }, true)).toBe(true);
	});
	it("heading split with an intro keeps its one part (the intro stays, so it is a real split)", () => {
		const doc = parseDoc("intro\n## A\na\n");
		expect(planFromParts(doc, partsByHeading(doc, 2)).parts.length).toBe(1);
	});
});

describe("self-referencing heading links in a moved part", () => {
	const SRC = "Notes/Big.md";
	const RAW = "intro [[#Alpha]]\n## Alpha\nsee [[#Alpha]] and [[Big#Alpha|me]] and [[#^a1]]\nline ^a1\n## Beta\nback to [[#Alpha]]\n";
	for (const indexed of [true, false]) {
		it(`point at the new note's own heading (${indexed ? "indexed" : "not indexed"}); undo byte-exact`, async () => {
			const { app, vault, unindexed } = makeApp({ [SRC]: RAW }, SRC);
			if (!indexed) unindexed.add(SRC);
			const before = new Map(vault.files);
			const doc = parseDoc(RAW);
			const r = await applySplit(app as never, new TFile(SRC), planFromParts(doc, partsByHeading(doc, 2)), { ...OPTS, inherit: "none", sourceProperty: "" });
			const alpha = vault.files.get("Notes/Alpha.md")!;
			expect(alpha).not.toMatch(/\[\[Big[#|]/);
			expect(alpha).toMatch(/\[\[(Alpha)?#Alpha\]\]/);
			expect(alpha).toMatch(/\[\[(Alpha)?#\^a1\]\]/);
			expect(vault.files.get("Notes/Beta.md")!).toContain("[[Alpha#Alpha]]");
			expect(vault.files.get(SRC)!).toContain("intro [[Alpha#Alpha]]");
			expect(r.unverified).toEqual([]);
			await undoSplit(app as never, r.journal);
			expect(vault.files).toEqual(before);
		});
	}
});

describe("cache timing: a note saved seconds ago with a stale cache entry", () => {
	it("its new link to a moved heading is read from the file and repaired; undo byte-exact", async () => {
		const SRC = "Notes/Big.md";
		const RAW = "intro\n## Alpha\na\n## Beta\nb\n";
		const FRESH = "just typed [[Big#Alpha|al]] here\n";
		// Indexed (getFileCache returns an entry) but the entry has no links yet: Obsidian has not re-indexed the save.
		const { app, vault } = makeApp({ [SRC]: RAW, "Fresh.md": FRESH }, SRC);
		const stamp = (f: TFile | null) => {
			if (f && f.path === "Fresh.md") f.stat = { ...f.stat, mtime: Date.now() };
			return f;
		};
		const gm = vault.getMarkdownFiles.bind(vault);
		const gf = vault.getFileByPath.bind(vault);
		vault.getMarkdownFiles = () => gm().map((f) => stamp(f)!);
		vault.getFileByPath = (p: string) => stamp(gf(p));
		const before = new Map(vault.files);
		const doc = parseDoc(RAW);
		const r = await applySplit(app as never, new TFile(SRC), planFromParts(doc, partsByHeading(doc, 2)), { ...OPTS, inherit: "none", sourceProperty: "" });
		expect(vault.files.get("Fresh.md")).toBe("just typed [[Alpha#Alpha|al]] here\n");
		await undoSplit(app as never, r.journal);
		expect(vault.files).toEqual(before);
	});
});
