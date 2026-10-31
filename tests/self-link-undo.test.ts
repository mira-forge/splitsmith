/**
 * Gate 3 corpus finding: a moved part that links to a heading of its own note by name ([[Big#Beta detail]])
 * is itself repaired once Obsidian has indexed the new note. The new note then differs from what was
 * created, and Undo used to refuse it as "edited after the split". Seen on 11 of 2,234 splits of the
 * Obsidian help vault in real Obsidian 1.14.5.
 */
import { describe, expect, it, vi } from "vitest";
import { TFile } from "./obsidian-mock";
import { applySplit, undoSplit } from "../src/core/apply";
import { parseDoc, partsByHeading } from "../src/core/sections";
import { planFromParts } from "../src/core/plan";
import { NOTE, OPTS, SRC, makeApp } from "./mock-app";

vi.stubGlobal("window", { setInterval: () => 1, open: () => null });

const RAW = NOTE.replace("alpha text ^blk1", "alpha text ^blk1 see [[Big#Beta detail]]");

function setup(indexNewNotes: boolean) {
	const env = makeApp({ [SRC]: RAW, "Other.md": "Also [[Big#Beta detail]]." });
	env.linkAt("Other.md", "[[Big#Beta detail]]", "Big#Beta detail");
	const create = env.vault.create.bind(env.vault);
	// Like Obsidian's metadata cache, index the new note's own links as soon as it exists.
	env.vault.create = async (p: string, d: string) => {
		const f = await create(p, d);
		if (indexNewNotes && d.includes("[[Big#Beta detail]]")) env.linkAt(p, "[[Big#Beta detail]]", "Big#Beta detail");
		return f;
	};
	const doc = parseDoc(RAW);
	return { ...env, plan: planFromParts(doc, partsByHeading(doc, 2)) };
}

describe("self-links inside moved parts", () => {
	it("are repaired in the new note, and Undo still restores the vault byte for byte", async () => {
		const { app, vault, plan } = setup(true);
		const before = new Map(vault.files);
		const r = await applySplit(app as never, new TFile(SRC), plan, OPTS);
		const alpha = r.created.find((p) => vault.files.get(p)!.includes("alpha text"))!;
		expect(vault.files.get(alpha)).not.toContain("[[Big#Beta detail]]");
		// Since Gate 3 decision 3 the new note's link comes from our own parse (ownEdits), and new notes are left out of the
		// cache-based inbound repair, so an early index cannot rewrite it a second time.
		expect(r.journal.linkEdits.map((e) => e.path)).toEqual(["Other.md"]);
		expect(r.journal.ownEdits?.map((e) => e.path)).toEqual([alpha]);
		expect(vault.files.get(alpha)).toContain("[[Beta ☕#Beta detail]]");
		expect(r.unverified).toEqual([]);
		const u = await undoSplit(app as never, r.journal);
		expect(u.linksSkipped).toBe(0);
		expect(vault.files).toEqual(before);
	});

	it("a real edit to the new note after the split is still refused", async () => {
		const { app, vault, plan } = setup(true);
		const r = await applySplit(app as never, new TFile(SRC), plan, OPTS);
		const alpha = r.created.find((p) => vault.files.get(p)!.includes("alpha text"))!;
		vault.files.set(alpha, vault.files.get(alpha)! + "\nmy edit");
		await expect(undoSplit(app as never, r.journal)).rejects.toThrow(/edited after the split/);
		expect(vault.files.get(alpha)).toMatch(/my edit$/);
	});

	it("without indexing (cache not ready) the new note's link is still rewritten, and Undo works", async () => {
		const { app, vault, plan } = setup(false);
		const before = new Map(vault.files);
		const r = await applySplit(app as never, new TFile(SRC), plan, OPTS);
		expect(r.journal.linkEdits.map((e) => e.path)).toEqual(["Other.md"]);
		const alpha = r.created.find((p) => vault.files.get(p)!.includes("alpha text"))!;
		expect(vault.files.get(alpha)).toContain("see [[Beta ☕#Beta detail]]");
		expect(r.unverified).toEqual([]);
		await undoSplit(app as never, r.journal);
		expect(vault.files).toEqual(before);
	});
});
