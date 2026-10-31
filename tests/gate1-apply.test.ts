/**
 * Gate 1 (SPLITSMITH_STATE.md section 3 gaps 1 and 7, section 4 item 4): every apply leaves the vault
 * either fully old, or fully new with a journal that Undo can use. Failures after the source rewrite are
 * reported as "Split done, but ...; Undo is available", never "Nothing was changed".
 */
import { describe, expect, it, vi } from "vitest";
import { TFile, notices } from "./obsidian-mock";
import SplitsmithPlugin from "../src/main";
import { applySplit, undoSplit } from "../src/core/apply";
import { parseDoc, partsByHeading } from "../src/core/sections";
import { planFromParts } from "../src/core/plan";
import { NOTE, OPTS, SRC, makeApp } from "./mock-app";

vi.stubGlobal("window", { setInterval: () => 1, open: () => null });

const OTHER = "See [[Big#Alpha]] and [[Big#^blk1]].";
const OTHER2 = "Also [[Big#Beta detail]].";

function setup() {
	const env = makeApp({ [SRC]: NOTE, "Other.md": OTHER, "Other2.md": OTHER2 });
	env.linkAt("Other.md", "[[Big#Alpha]]", "Big#Alpha");
	env.linkAt("Other.md", "[[Big#^blk1]]", "Big#^blk1");
	env.linkAt("Other2.md", "[[Big#Beta detail]]", "Big#Beta detail");
	const doc = parseDoc(NOTE);
	return { ...env, plan: planFromParts(doc, partsByHeading(doc, 2)) };
}

const snapshot = (files: Map<string, string>) => new Map(files);

describe("gap 1: failure after the source rewrite is reported honestly and stays undoable", () => {
	it("link repair throws on the 2nd file: result has a warning, journal records the edits already made, undo restores everything", async () => {
		const { app, vault, plan } = setup();
		const before = snapshot(vault.files);
		vault.failProcess = { path: "Other2.md", when: "before" };
		const r = await applySplit(app as never, new TFile(SRC), plan, OPTS);
		expect(r.warning).toMatch(/^Split done, but link repair failed .*Undo is available\.$/);
		expect(vault.files.get("Other.md")).toBe("See [[Alpha#Alpha]] and [[Alpha#^blk1]].");
		expect(vault.files.get("Other2.md")).toBe(OTHER2);
		expect(r.journal.linkEdits.map((e) => e.path)).toEqual(["Other.md"]);
		expect(r.linksUpdated).toBe(2);
		expect(r.journal.after).toBe(vault.files.get(SRC));
		vault.failProcess = null;
		const u = await undoSplit(app as never, r.journal);
		expect(u.linksReverted).toBe(2);
		expect(vault.files).toEqual(before);
	});

	it("link repair writes a file and then reports an error: that write is still journaled and undone", async () => {
		const { app, vault, plan } = setup();
		const before = snapshot(vault.files);
		vault.failProcess = { path: "Other.md", when: "after" };
		const r = await applySplit(app as never, new TFile(SRC), plan, OPTS);
		expect(r.warning).toMatch(/link repair failed/);
		expect(r.journal.linkEdits.map((e) => e.path)).toEqual(["Other.md"]);
		vault.failProcess = null;
		await undoSplit(app as never, r.journal);
		expect(vault.files).toEqual(before);
	});

	it("link lookup itself throws (metadata cache): split stays done, warning set, journal valid", async () => {
		const { app, vault, plan } = setup();
		const before = snapshot(vault.files);
		Object.defineProperty(app.metadataCache, "resolvedLinks", { get: () => { throw new Error("cache not ready"); } });
		const r = await applySplit(app as never, new TFile(SRC), plan, OPTS);
		expect(r.warning).toMatch(/link repair failed \(cache not ready\)/);
		expect(r.created).toHaveLength(2);
		await undoSplit(app as never, r.journal);
		expect(vault.files).toEqual(before);
	});

	it("source write lands but process() reports an error: treated as done (warning + journal), not 'nothing was changed'", async () => {
		const { app, vault, plan } = setup();
		const before = snapshot(vault.files);
		vault.failProcess = { path: SRC, when: "after", times: 1 };
		const r = await applySplit(app as never, new TFile(SRC), plan, { ...OPTS, repairLinks: false });
		expect(r.warning).toMatch(/^Split done, but Obsidian reported an error while saving the source note .*Undo is available\.$/);
		expect(vault.files.get("Notes/Alpha.md")).toBeDefined();
		await undoSplit(app as never, r.journal);
		expect(vault.files).toEqual(before);
	});

	it("plugin.apply: saves the journal and shows 'Split done, but link repair failed; Undo is available', never 'Nothing was changed'", async () => {
		const { app, vault, plan } = setup();
		const before = snapshot(vault.files);
		const p = new SplitsmithPlugin(app as never, {} as never);
		await p.onload();
		vault.failProcess = { path: "Other2.md", when: "before" };
		await p.apply(new TFile(SRC), plan, "link");
		const n = notices.at(-1)!;
		expect(n).toMatch(/Split done, but link repair failed/);
		expect(n).toMatch(/Undo is available/);
		expect(n).toMatch(/Created 2 notes/);
		expect(n).not.toMatch(/Nothing was changed/i);
		expect(p.settings.lastSplit?.linkEdits.map((e) => e.path)).toEqual(["Other.md"]);
		expect((p as unknown as { data: { lastSplit: unknown } }).data.lastSplit).toBeTruthy(); // persisted
		vault.failProcess = null;
		await p.undo();
		expect(vault.files).toEqual(before);
	});

	it("plugin.apply: if saving the journal fails, the notice still says the split is done", async () => {
		const { app, plan } = setup();
		const p = new SplitsmithPlugin(app as never, {} as never);
		await p.onload();
		p.saveData = async () => { throw new Error("disk full"); };
		await p.apply(new TFile(SRC), plan, "link");
		expect(notices.at(-1)).toMatch(/^Created 2 notes\..*Undo could not be saved to disk/);
		expect(p.settings.lastSplit).toBeTruthy();
	});
});

describe("gap 7 + fault injection: fully old, or fully new plus journal", () => {
	it("a new note that does not read back exactly is caught before the source is touched", async () => {
		const { app, vault, plan } = setup();
		const before = snapshot(vault.files);
		vault.createTransform = (p, d) => (p.endsWith("Beta ☕.md") ? d.slice(0, -1) : d);
		await expect(applySplit(app as never, new TFile(SRC), plan, OPTS)).rejects.toThrow(/did not read back exactly.*nothing was changed/);
		expect(vault.files).toEqual(before);
		expect(vault.trashed).toEqual(["Notes/Alpha.md", "Notes/Beta ☕.md"]);
	});

	it("vault.create fails at every part k of n: nothing changes", async () => {
		const raw = Array.from({ length: 5 }, (_, i) => `# P${i}\ntext ${i}`).join("\n");
		for (let k = 0; k < 5; k++) {
			const { app, vault } = makeApp({ "Big.md": raw }, "Big.md");
			const before = snapshot(vault.files);
			vault.failCreateAt = k;
			const doc = parseDoc(raw);
			await expect(applySplit(app as never, new TFile("Big.md"), planFromParts(doc, partsByHeading(doc, 1)), OPTS)).rejects.toThrow(/nothing was changed/);
			expect(vault.files).toEqual(before);
			expect(vault.trashed).toHaveLength(k);
		}
	});

	it("source process() throws before writing: nothing changes", async () => {
		const { app, vault, plan } = setup();
		const before = snapshot(vault.files);
		vault.failProcess = { path: SRC, when: "before" };
		await expect(applySplit(app as never, new TFile(SRC), plan, OPTS)).rejects.toThrow(/nothing was changed/);
		expect(vault.files).toEqual(before);
	});

	it("a link generator that throws (step 3) rolls back instead of leaving orphan notes", async () => {
		const { app, vault, plan } = setup();
		const before = snapshot(vault.files);
		let calls = 0;
		const orig = app.fileManager.generateMarkdownLink.bind(app.fileManager);
		app.fileManager.generateMarkdownLink = ((...a: Parameters<typeof orig>) => {
			if (++calls > 2) throw new Error("boom");
			return orig(...a);
		}) as typeof orig;
		await expect(applySplit(app as never, new TFile(SRC), plan, OPTS)).rejects.toThrow(/The split failed, nothing was changed: boom/);
		expect(vault.files).toEqual(before);
	});

	it("source changed between preview and write (already covered in plugin.test) also leaves link files alone", async () => {
		const { app, vault, plan } = setup();
		vault.beforeProcess = (p) => {
			if (p === SRC) vault.files.set(SRC, NOTE + "x");
		};
		await expect(applySplit(app as never, new TFile(SRC), plan, OPTS)).rejects.toThrow(/changed while splitting/);
		expect(vault.files.get("Other.md")).toBe(OTHER);
		expect([...vault.files.keys()].sort()).toEqual(["Notes/Big.md", "Other.md", "Other2.md"]);
	});
});
