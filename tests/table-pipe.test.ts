/**
 * Table-escaped aliases: inside a markdown table an aliased wikilink is written
 * [[Note#Heading\|alias]] ("Pipe (used in tables): \|" in Obsidian's help). A rewrite must keep the "\|", or the bare
 * "|" splits the table cell. Covered in both rewrite paths (the split note's own links, and inbound links in other
 * notes), each with the note indexed and not yet indexed. Undo restores every byte.
 */
import { describe, expect, it, vi } from "vitest";
import { TFile } from "./obsidian-mock";
import { applySplit, undoSplit } from "../src/core/apply";
import { parseDoc, partsByHeading } from "../src/core/sections";
import { planFromParts } from "../src/core/plan";
import { findLinks } from "../src/core/textlinks";
import { OPTS, makeApp } from "./mock-app";

vi.stubGlobal("window", { setInterval: () => 1, open: () => null });

const SRC = "Notes/Big.md";
const O = { ...OPTS, inherit: "none" as const, sourceProperty: "" };
const split2 = (raw: string) => {
	const doc = parseDoc(raw);
	return planFromParts(doc, partsByHeading(doc, 2));
};
/** Cells per table row (lines starting with "|"), counting only unescaped pipes. */
export const tableCells = (text: string) =>
	text.split(/\r?\n/).filter((l) => l.trimStart().startsWith("|")).map((l) => (l.match(/(?<!\\)\|/g) ?? []).length);

describe("findLinks reads a table-escaped alias the way Obsidian does", () => {
	it("[[Big#Alpha\\|al]]: path Big, sub Alpha, alias al, escaped pipe noted", () => {
		const [l] = findLinks("| [[Big#Alpha\\|al]] |");
		expect([l!.path, l!.sub, l!.alias, l!.pipeEscaped]).toEqual(["Big", "Alpha", "al", true]);
		const [n] = findLinks("[[Big\\|al]]");
		expect([n!.path, n!.sub, n!.alias, n!.pipeEscaped]).toEqual(["Big", "", "al", true]);
		const [p] = findLinks("[[Big#Alpha|al]]");
		expect([p!.path, p!.sub, p!.alias, !!p!.pipeEscaped]).toEqual(["Big", "Alpha", "al", false]);
	});
});

describe("own links in the split note's tables", () => {
	const RAW = [
		"intro [[#Alpha|plain]]",
		"| col | link |",
		"| - | - |",
		"| a | [[#Alpha\\|al]] |",
		"| b | [[Big#Beta\\|be]] and ![[#^blk\\|emb]] |",
		"",
		"## Alpha",
		"| x | y |",
		"| - | - |",
		"| moved | [[#Beta\\|to beta]] |",
		"## Beta",
		"beta ^blk",
	].join("\n");
	for (const indexed of [true, false]) {
		it(`keeps \\| in source and moved tables (source ${indexed ? "indexed" : "not yet indexed"}); undo byte-exact`, async () => {
			const { app, vault, unindexed } = makeApp({ [SRC]: RAW }, SRC);
			if (!indexed) unindexed.add(SRC);
			const before = new Map(vault.files);
			const r = await applySplit(app as never, new TFile(SRC), split2(RAW), O);
			const src = vault.files.get(SRC)!.split("\n");
			expect(src[0]).toBe("intro [[Alpha#Alpha|plain]]");
			expect(src[3]).toBe("| a | [[Alpha#Alpha\\|al]] |");
			expect(src[4]).toBe("| b | [[Beta#Beta\\|be]] and ![[Beta#^blk\\|emb]] |");
			expect(vault.files.get("Notes/Alpha.md")!).toContain("| moved | [[Beta#Beta\\|to beta]] |");
			expect(tableCells(vault.files.get(SRC)!)).toEqual(tableCells(RAW).slice(0, 4));
			expect(tableCells(vault.files.get("Notes/Alpha.md")!)).toEqual([3, 3, 3]);
			expect(r.unverified).toEqual([]);
			await undoSplit(app as never, r.journal);
			expect(vault.files).toEqual(before);
		});
	}
});

describe("inbound links in another note's table", () => {
	const RAW = "intro\n## Alpha\na ^blk\n## Beta\nb\n";
	const REF = "| x | link |\n| - | - |\n| r | [[Big#Alpha\\|al]] |\n| s | ![[Big#^blk\\|b]] [[Big#Beta|plain]] |\n";
	for (const indexed of [true, false]) {
		it(`keeps \\| (other note ${indexed ? "indexed" : "not yet indexed"}); undo byte-exact`, async () => {
			const { app, vault, linkAt, unindexed } = makeApp({ [SRC]: RAW, "Ref.md": REF }, SRC);
			// What Obsidian 1.14.5 indexes for these (read from the real app): the "\" is not part of the link.
			linkAt("Ref.md", "[[Big#Alpha\\|al]]", "Big#Alpha", "al");
			linkAt("Ref.md", "![[Big#^blk\\|b]]", "Big#^blk", "b", true);
			linkAt("Ref.md", "[[Big#Beta|plain]]", "Big#Beta", "plain");
			if (!indexed) unindexed.add("Ref.md");
			const before = new Map(vault.files);
			const r = await applySplit(app as never, new TFile(SRC), split2(RAW), O);
			const ref = vault.files.get("Ref.md")!.split("\n");
			expect(ref[2]).toBe("| r | [[Alpha#Alpha\\|al]] |");
			expect(ref[3]).toBe("| s | ![[Alpha#^blk\\|b]] [[Beta#Beta|plain]] |");
			expect(tableCells(vault.files.get("Ref.md")!)).toEqual(tableCells(REF));
			expect(r.unverified).toEqual([]);
			await undoSplit(app as never, r.journal);
			expect(vault.files).toEqual(before);
		});
	}
});
