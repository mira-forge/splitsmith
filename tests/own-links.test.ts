/**
 * Gate 3 decisions 2 and 3, and item A: link rewrites from our own parse of the text.
 *  - Links in the rest of the source to its own moved headings and blocks point at the new note, alias kept.
 *  - Links inside moved text are rewritten without waiting for the metadata cache to index the new notes.
 *  - Relative markdown links in moved text still resolve when the new notes land in another folder.
 *  - The read-back reports any link it could not confirm instead of passing silently.
 * Undo restores every byte in all cases.
 */
import { describe, expect, it, vi } from "vitest";
import { TFile } from "./obsidian-mock";
import { applySplit, undoSplit, unverifiedLine } from "../src/core/apply";
import { parseDoc, partsByHeading } from "../src/core/sections";
import { planFromParts } from "../src/core/plan";
import { anchorsIn, encodeMdPath, findLinks, relativePath } from "../src/core/textlinks";
import { normHeading } from "../src/core/links";
import { OPTS, makeApp } from "./mock-app";

vi.stubGlobal("window", { setInterval: () => 1, open: () => null });

const SRC = "Notes/Big.md";
const O = { ...OPTS, inherit: "none" as const, sourceProperty: "" };
const split2 = (raw: string) => {
	const doc = parseDoc(raw);
	return planFromParts(doc, partsByHeading(doc, 2));
};

describe("findLinks (own parse)", () => {
	it("finds wikilinks and markdown links with their parts, and skips code, inline code, URLs and front matter", () => {
		const raw = [
			"---", 'up: "[[Big#Alpha]]"', "---",
			"a [[Big#Alpha|al]] b ![[pic.png]] [[#Beta]] [[Big]] [[Big#Alpha#Sub]]",
			"[x](#Alpha) ![i](../img.png) [s](<sub/my file.md>) [e](My%20File.md#Sec%20One) [u](https://x.y/a.md) [m](mailto:a@b)",
			"`[[Big#Code]]` and ``[y](no.md)``",
			"```", "[[Big#Fenced]]", "```",
			"[t](a.md \"title\")",
		].join("\n");
		const l = findLinks(raw);
		expect(l.map((x) => [x.kind, x.embed, x.path, x.sub, x.alias ?? null])).toEqual([
			["wiki", false, "Big", "Alpha", "al"],
			["wiki", true, "pic.png", "", null],
			["wiki", false, "", "Beta", null],
			["wiki", false, "Big", "", null],
			["wiki", false, "Big", "Alpha#Sub", null],
			["md", false, "", "Alpha", null],
			["md", true, "../img.png", "", null],
			["md", false, "sub/my file.md", "", null],
			["md", false, "My File.md", "Sec One", null],
			["md", false, "a.md", "", null],
		]);
		for (const x of l) expect(raw.slice(x.start, x.end)).toBe(x.original);
		const angle = l[7]!;
		expect(angle.original.slice(angle.url!.from, angle.url!.to)).toBe("sub/my file.md");
		const titled = l[9]!;
		expect(titled.original.slice(titled.url!.from, titled.url!.to)).toBe("a.md");
	});
	it("relativePath and encodeMdPath", () => {
		expect(relativePath("Out/Deep", "img.png")).toBe("../../img.png");
		expect(relativePath("Notes", "Notes/sub/a.md")).toBe("sub/a.md");
		expect(relativePath("", "Notes/a.md")).toBe("Notes/a.md");
		expect(relativePath("A/B", "A/C/d.md")).toBe("../C/d.md");
		expect(encodeMdPath("../My File (1).md")).toBe("../My%20File%20%281%29.md");
	});
});

describe("decision 2: links in the rest of the source to its own moved headings", () => {
	const RAW = [
		"Intro: see [[#Alpha]], [[Big#Beta ☕|the beta part]], ![[Big#^blk1]], [x](#Alpha), [y](Big.md#Beta%20%E2%98%95) and [[#Intro head]].",
		"Block by markdown link: [z](#^blk1).",
		"### Intro head",
		"```",
		"[[#Alpha]] in code stays",
		"```",
		"",
		"## Alpha",
		"alpha text ^blk1",
		"",
		"## Beta ☕",
		"beta",
	].join("\r\n");
	it("are rewritten to [[NewNote#Heading]] (alias kept) in the same write, and Undo restores them byte for byte", async () => {
		const { app, vault } = makeApp({ [SRC]: RAW }, SRC);
		const before = new Map(vault.files);
		const r = await applySplit(app as never, new TFile(SRC), split2(RAW), O);
		const out = vault.files.get(SRC)!;
		expect(out.split("\r\n")[0]).toBe(
			"Intro: see [[Alpha#Alpha]], [[Beta ☕#Beta ☕|the beta part]], ![[Alpha#^blk1]], [x](Alpha.md#Alpha), [y](Beta%20☕.md#Beta%20☕) and [[#Intro head]].",
		);
		expect(out.split("\r\n")[1]).toBe("Block by markdown link: [z](Alpha.md#^blk1).");
		expect(out).toContain("[[#Alpha]] in code stays");
		expect(r.journal.after).toBe(out);
		expect(r.linksRewritten).toBe(6);
		expect(r.unverified).toEqual([]);
		await undoSplit(app as never, r.journal);
		expect(vault.files).toEqual(before);
	});
	it("are left alone when link repair is off", async () => {
		const { app, vault } = makeApp({ [SRC]: RAW }, SRC);
		const r = await applySplit(app as never, new TFile(SRC), split2(RAW), { ...O, repairLinks: false });
		expect(vault.files.get(SRC)!.split("\r\n")[0]).toBe(RAW.split("\r\n")[0]);
		expect(r.linksRewritten).toBe(0);
	});
});

describe("decision 3: rewrites in new notes come from our own parse, not the index", () => {
	const RAW = [
		"## Keep",
		"intro",
		"",
		"# Top",
		"## Alpha",
		"see [[#Beta]], [[#Alpha]], [[Big#Beta|b]], [[#Keep]], [[#^bb]] and ![[Big#^aa]]",
		"x ^aa",
		"## Beta",
		"back to [[#Alpha]] and [[#Nope]]",
		"y ^bb",
	].join("\n");
	it("rewrites them while the cache has not indexed the new notes (a late index), and Undo restores everything", async () => {
		const { app, vault } = makeApp({ [SRC]: RAW }, SRC);
		// The mock never indexes the new notes: getFileCache returns no links for them.
		const before = new Map(vault.files);
		const doc = parseDoc(RAW);
		const plan = planFromParts(doc, partsByHeading(doc, 2).filter((p) => p.title !== "Keep"));
		const r = await applySplit(app as never, new TFile(SRC), plan, O);
		expect(r.created).toEqual(["Notes/Alpha.md", "Notes/Beta.md"]);
		expect(vault.files.get("Notes/Alpha.md")).toContain("see [[Beta#Beta]], [[#Alpha]], [[Beta#Beta|b]], [[Big#Keep]], [[Beta#^bb]] and ![[Alpha#^aa]]");
		expect(vault.files.get("Notes/Beta.md")).toContain("back to [[Alpha#Alpha]] and [[#Nope]]");
		// [[#Nope]] was already broken before the split, so it is not reported.
		expect(r.unverified).toEqual([]);
		expect(r.journal.ownEdits!.map((e) => [e.path, e.applied.length])).toEqual([["Notes/Alpha.md", 5], ["Notes/Beta.md", 1]]);
		await undoSplit(app as never, r.journal);
		expect(vault.files).toEqual(before);
	});

	it("an inbound note the cache has not indexed yet is still repaired from our own parse", async () => {
		const RAW2 = "intro\n## Alpha\na\n## Beta\nb\n";
		const { app, vault, unindexed } = makeApp({ [SRC]: RAW2, "Late.md": "to [[Big#Alpha]] and [[Big#Beta|bb]] and [[Big]]" }, SRC);
		unindexed.add("Late.md");
		const before = new Map(vault.files);
		const r = await applySplit(app as never, new TFile(SRC), split2(RAW2), O);
		expect(vault.files.get("Late.md")).toBe("to [[Alpha#Alpha]] and [[Beta#Beta|bb]] and [[Big]]");
		expect(r.linksUpdated).toBe(2);
		expect(r.unverified).toEqual([]);
		await undoSplit(app as never, r.journal);
		expect(vault.files).toEqual(before);
	});

	it("the read-back reports links it could not confirm (stale index, unindexed markdown link) instead of passing", async () => {
		const RAW2 = "intro\n## Alpha\na\n## Beta\nb\n";
		const { app, vault, linkAt, unindexed } = makeApp({ [SRC]: RAW2, "Stale.md": "xx [[Big#Alpha]]", "LateMd.md": "go [a](Big.md#Beta)" }, SRC);
		// A stale cache entry: the cache's offsets no longer match the text, so the edit is skipped.
		linkAt("Stale.md", "[[Big#Alpha]]", "Big#Alpha");
		vault.files.set("Stale.md", "xxyy [[Big#Alpha]]");
		unindexed.add("LateMd.md");
		const r = await applySplit(app as never, new TFile(SRC), split2(RAW2), O);
		expect(r.linksSkipped).toBe(1);
		expect(r.unverified.sort()).toEqual(["LateMd.md: [a](Big.md#Beta)", "Stale.md: [[Big#Alpha]]"]);
		expect(unverifiedLine(r.unverified)).toMatch(/^Could not confirm that 2 links still resolve, check by hand: /);
		const u = await undoSplit(app as never, r.journal);
		expect(u.linksSkipped).toBe(0);
		expect(vault.files.get(SRC)).toBe(RAW2);
	});
});

describe("item A: relative markdown links in moved text, new notes in another folder", () => {
	const files = {
		"img.png": "PNG",
		"Notes/other.md": "o",
		"Notes/sub/file.md": "f",
		"Notes/pic.png": "P",
		"Notes/My File.md": "m",
		"Out/Deep/other.md": "a different note with the same name",
	};
	const RAW = [
		"intro",
		"## Part",
		"![a](../img.png) [o](other.md) [s](sub/file.md) ![p](./pic.png) [w](<sub/file.md>) [m](My%20File.md) [e](https://x.y/a.md) [[other]] [[sub/file]] [b](../nowhere.png)",
	].join("\n");
	it("are rewritten relative to the new note's folder when they would no longer resolve, and Undo restores every byte", async () => {
		const { app, vault } = makeApp({ ...files, [SRC]: RAW }, SRC);
		vault.folders.add("Out/Deep");
		const before = new Map(vault.files);
		const r = await applySplit(app as never, new TFile(SRC), split2(RAW), { ...O, folder: "Out/Deep" });
		expect(r.created).toEqual(["Out/Deep/Part.md"]);
		const moved = vault.files.get("Out/Deep/Part.md")!.split("\n")[1];
		expect(moved).toBe(
			"![a](../../img.png) [o](../../Notes/other.md) [s](sub/file.md) ![p](../../Notes/pic.png) [w](<sub/file.md>) [m](My%20File.md) [e](https://x.y/a.md) [[Notes/other]] [[sub/file]] [b](../nowhere.png)",
		);
		// "sub/file.md" and "My File.md" still resolve (Obsidian matches the path's end), so they stay as written.
		// [o](other.md) and [[other]] would now hit Out/Deep/other.md, a different note, so they are pointed back.
		// [b](../nowhere.png) was broken before the split and stays as it was.
		// Every link resolves from the new note to the same file it resolved to from the original folder.
		const was = findLinks(RAW).map((l) => app.metadataCache.getFirstLinkpathDest(l.path, SRC)?.path ?? null);
		const now = findLinks(vault.files.get("Out/Deep/Part.md")!).map((l) => app.metadataCache.getFirstLinkpathDest(l.path, "Out/Deep/Part.md")?.path ?? null);
		expect(now).toEqual(was);
		expect(was).toEqual(["img.png", "Notes/other.md", "Notes/sub/file.md", "Notes/pic.png", "Notes/sub/file.md", "Notes/My File.md", "Notes/other.md", "Notes/sub/file.md", null]);
		expect(r.unverified).toEqual([]);
		await undoSplit(app as never, r.journal);
		expect(vault.files).toEqual(before);
	});
	it("stay byte-identical when the new notes land in the same folder", async () => {
		const { app, vault } = makeApp({ ...files, [SRC]: RAW }, SRC);
		const r = await applySplit(app as never, new TFile(SRC), split2(RAW), O);
		expect(vault.files.get("Notes/Part.md")!.split("\n")[1]).toBe(RAW.split("\n")[2]);
		expect(r.journal.ownEdits).toBeUndefined();
	});
});

describe("double space after the heading marks (Advanced Note Composer #115)", () => {
	it("'##  Title' splits losslessly and undoes byte for byte", async () => {
		const RAW = "intro\n##  Title  with  spaces\nbody\n##   Other\nmore\n";
		const { app, vault } = makeApp({ [SRC]: RAW, "Ref.md": "[[Big#Title with spaces]]" }, SRC);
		const before = new Map(vault.files);
		const r = await applySplit(app as never, new TFile(SRC), split2(RAW), O);
		expect(r.created.map((p) => vault.files.get(p))).toEqual(["##  Title  with  spaces\nbody\n", "##   Other\nmore\n"]);
		await undoSplit(app as never, r.journal);
		expect(vault.files).toEqual(before);
	});
});

describe("Gate 3 corpus re-check findings", () => {
	it("a block id on its own line under its paragraph moves with it, and links to it are repaired", async () => {
		const RAW = "intro\n## Alpha\nA question?\nThe answer.\n^faq-1\n\n## Beta\nb\n";
		const { app, vault, linkAt } = makeApp({ [SRC]: RAW, "Ref.md": "see [[Big#^faq-1]] and [[Big#^faq-1|faq]]", "Late.md": "![[Big#^faq-1]]" }, SRC);
		linkAt("Ref.md", "[[Big#^faq-1]]", "Big#^faq-1");
		linkAt("Ref.md", "[[Big#^faq-1|faq]]", "Big#^faq-1", "faq");
		const before = new Map(vault.files);
		const r = await applySplit(app as never, new TFile(SRC), split2(RAW), O);
		expect(vault.files.get("Ref.md")).toBe("see [[Alpha#^faq-1]] and [[Alpha#^faq-1|faq]]");
		expect(r.unverified).toEqual([]);
		await undoSplit(app as never, r.journal);
		expect(vault.files).toEqual(before);
	});
	it("a new note never takes the name of a note in another folder, so links by name keep their target", async () => {
		const RAW = "intro\n## Settings\nsee [[Settings#Excluded files]]\n## Beta\nb\n";
		const files = { [SRC]: RAW, "Other/Settings.md": "## Excluded files\nx\n", "Notes/Ref.md": "[[Settings]]" };
		const { app, vault } = makeApp(files, SRC);
		const before = new Map(vault.files);
		const r = await applySplit(app as never, new TFile(SRC), split2(RAW), O);
		expect(r.journal.created.map((c) => c.path)).toEqual(["Notes/Settings 2.md", "Notes/Beta.md"]);
		expect(vault.files.get("Notes/Settings 2.md")).toBe("## Settings\nsee [[Settings#Excluded files]]\n");
		expect(app.metadataCache.getFirstLinkpathDest("Settings", "Notes/Ref.md")?.path).toBe("Other/Settings.md");
		expect(r.unverified).toEqual([]);
		await undoSplit(app as never, r.journal);
		expect(vault.files).toEqual(before);
	});
});

describe("Gate 3 corpus re-run 2 findings (matched against Obsidian 1.14's own resolveSubpath and block parser)", () => {
	it("heading keys match the way Obsidian resolves them (punctuation blanked, case-insensitive)", () => {
		// Probed in real Obsidian: #hasTag reaches "`hasTag()`"; a GitHub-style slug does not reach its heading.
		expect(normHeading("`hasTag()`")).toBe(normHeading("hasTag"));
		expect(normHeading("Handling Potential Failure with `Result`")).toBe(normHeading("Handling Potential Failure with Result"));
		expect(normHeading("handling-potential-failure-with-result")).not.toBe(normHeading("Handling Potential Failure with Result"));
		expect(normHeading("C++ & Rust: a/b")).toBe("c rust a b");
		expect(normHeading("snake_case-name's")).toBe("snake_case-name's");
	});
	it("block ids are found right after inline markup, as Obsidian reads them, and matched case-insensitively", () => {
		const { blocks } = anchorsIn(["a ^b1", "![[x.png]]^b2", "[t](u)^b4", "**bold**^b5", "`c`^b6", "x ^B19", "foo^b9", "x]^b8"].join("\n\n"));
		expect([...blocks].sort()).toEqual(["b1", "b19", "b2", "b4", "b5", "b6"]);
	});
	it("findLinks keeps anchors with inline code and reads markdown links whose text wraps onto the next line", () => {
		const raw = "see [[Big#`wikilink`|w]] and [[#`move`|move]] and `[[Big#Code]]`\n[“Handling\n`Result`”](#Beta) and [x](a.md)\n\n## [not](joined.md)\nnext";
		const l = findLinks(raw);
		expect(l.map((x) => [x.kind, x.path, x.sub, x.alias ?? null])).toEqual([
			["wiki", "Big", "`wikilink`", "w"],
			["wiki", "", "`move`", "move"],
			["md", "", "Beta", null],
			["md", "a.md", "", null],
			["md", "joined.md", "", null],
		]);
		for (const x of l) expect(raw.slice(x.start, x.end)).toBe(x.original);
	});
	it("inbound links reach a heading or block the Obsidian way and are repaired; Undo restores every byte", async () => {
		const RAW = "intro\n## Alpha\n### `hasTag()`\nt\n\n![[img.png]]^version-image\n## Beta\nb\n";
		const ref = "by [[Big#hasTag|`hasTag`]], ![[Big#^version-image]] and [[Big#^VERSION-image|v]]";
		const { app, vault, linkAt } = makeApp({ [SRC]: RAW, "Ref.md": ref }, SRC);
		linkAt("Ref.md", "[[Big#hasTag|`hasTag`]]", "Big#hasTag", "`hasTag`");
		linkAt("Ref.md", "![[Big#^version-image]]", "Big#^version-image", undefined, true);
		linkAt("Ref.md", "[[Big#^VERSION-image|v]]", "Big#^VERSION-image", "v");
		const before = new Map(vault.files);
		const r = await applySplit(app as never, new TFile(SRC), split2(RAW), O);
		expect(vault.files.get("Ref.md")).toBe("by [[Alpha#`hasTag()`|`hasTag`]], ![[Alpha#^version-image]] and [[Alpha#^VERSION-image|v]]");
		expect(r.unverified).toEqual([]);
		await undoSplit(app as never, r.journal);
		expect(vault.files).toEqual(before);
	});
	it("links in moved text to headings with inline code, and wrapped markdown links, are rewritten; Undo restores every byte", async () => {
		const RAW = [
			"intro",
			"## Formatting",
			"not to be confused with [[Big#`wikilink`|wikilink]]; see [[#`move`|move]] and [“Comparing the",
			"Guess”](#Comparing%20the%20Guess).",
			"### `wikilink`",
			"w",
			"## Commands",
			"### `move`",
			"m",
			"## Comparing the Guess",
			"c",
		].join("\n");
		const { app, vault } = makeApp({ [SRC]: RAW }, SRC);
		const before = new Map(vault.files);
		const r = await applySplit(app as never, new TFile(SRC), split2(RAW), O);
		const f = vault.files.get("Notes/Formatting.md")!;
		expect(f).toContain("not to be confused with [[Formatting#`wikilink`|wikilink]]; see [[Commands#`move`|move]] and [“Comparing the\nGuess”](Comparing%20the%20Guess.md#Comparing%20the%20Guess).");
		expect(r.unverified).toEqual([]);
		await undoSplit(app as never, r.journal);
		expect(vault.files).toEqual(before);
	});
});
