/**
 * Gate 3 item 2: "Undo last split" still works after Obsidian restarts.
 * The undo record lives in data.json (plugin.saveData). A restart is simulated by throwing the plugin
 * instance away, sending its saved data through JSON text (what data.json holds on disk) and loading a
 * new plugin instance on the same vault. The new instance is free (no license loaded): undo is never gated.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TFile, notices } from "./obsidian-mock";
import SplitsmithPlugin from "../src/main";
import { parseDoc, partsByHeading } from "../src/core/sections";
import { planFromParts } from "../src/core/plan";
import { DEFAULT_PRESETS, type Preset } from "../src/core/presets";
import { chosenBatch } from "../src/ui/inbox-modal";
import { NOTE, SRC, makeApp } from "./mock-app";

vi.stubGlobal("window", { setInterval: () => 1, open: () => null });

type WithData = { data: unknown };
const A = "Inbox/A.md";
const C = "Inbox/C.md";
const noteA = "Intro A\r\n\r\n## A one\r\nfirst\r\n\r\n## A two\r\nsecond ☕\r\n";
const noteC = "Intro C\n\n## C one\nc1 ^blk\n\n## C two\nc2\n";


/** Quit Obsidian: keep only what data.json would hold on disk, then start a fresh plugin on the same vault. */
async function restart(app: unknown, old: SplitsmithPlugin): Promise<{ p: SplitsmithPlugin; diskText: string }> {
	const diskText = JSON.stringify((old as unknown as WithData).data);
	const p = new SplitsmithPlugin(app as never, {} as never);
	(p as unknown as WithData).data = JSON.parse(diskText);
	await p.onload();
	return { p, diskText };
}
const undoCommand = (p: SplitsmithPlugin) => {
	const c = (p as unknown as { commands: { id: string; checkCallback?: (c: boolean) => boolean | void }[] }).commands.find((x) => x.id === "undo-last-split")!;
	return c.checkCallback!;
};

beforeEach(() => void (notices.length = 0));

describe("undo after an Obsidian restart (persisted journal)", () => {
	it("single split: the journal is in data.json, the undo command is available after restart and restores the vault byte for byte", async () => {
		const other = "See [[Big#Alpha]] and [[Big#^blk1]].";
		const { app, vault, linkAt } = makeApp({ [SRC]: NOTE, "Other.md": other });
		linkAt("Other.md", "[[Big#Alpha]]", "Big#Alpha");
		linkAt("Other.md", "[[Big#^blk1]]", "Big#^blk1");
		const before = new Map(vault.files);
		const p1 = new SplitsmithPlugin(app as never, {} as never);
		await p1.onload();
		const doc = parseDoc(NOTE);
		await p1.apply(new TFile(SRC), planFromParts(doc, partsByHeading(doc, 2)), "link");
		expect(notices.at(-1)).toMatch(/Run "Undo last split" to reverse it\.$/);
		expect(vault.files.get("Other.md")).not.toBe(other);

		const { p, diskText } = await restart(app, p1);
		expect(diskText).toContain('"lastSplit":{');
		expect(p.settings.lastSplit?.sourcePath).toBe(SRC);
		expect(undoCommand(p)(true)).toBe(true);
		undoCommand(p)(false);
		await vi.waitFor(() => expect(p.settings.lastSplit).toBeNull());
		expect(vault.files).toEqual(before);
		expect(notices.at(-1)).toMatch(/^Split undone: restored the original note and moved 2 new notes to the trash\./);
		// The cleared journal is saved too, so a second restart has nothing left to undo.
		const again = await restart(app, p);
		expect(again.p.settings.lastSplit).toBeNull();
		expect(undoCommand(again.p)(true)).toBe(false);
	});

	it("single split: after restart, undo still refuses if the note was edited, and keeps the journal", async () => {
		const { app, vault } = makeApp({ [SRC]: NOTE });
		const p1 = new SplitsmithPlugin(app as never, {} as never);
		await p1.onload();
		const doc = parseDoc(NOTE);
		await p1.apply(new TFile(SRC), planFromParts(doc, partsByHeading(doc, 2)), "link");
		const { p } = await restart(app, p1);
		vault.files.set(SRC, vault.files.get(SRC)! + "\r\nedited after restart");
		const edited = new Map(vault.files);
		await p.undo();
		expect(vault.files).toEqual(edited);
		expect(notices.at(-1)).toMatch(/edited after the split/);
		expect(p.settings.lastSplit).not.toBeNull();
	});

	it("inbox batch (Pro): after restart on a free/offline start, undo reverses the whole batch and restores the done list", async () => {
		const { app, vault } = makeApp({ [A]: noteA, [C]: noteC, "Inbox/Done.md": "already done\n" });
		vault.folders.add("Inbox");
		const p1 = new SplitsmithPlugin(app as never, {} as never);
		await p1.onload();
		p1.settings.inboxFolder = "Inbox";
		p1.settings.inboxDone = { "Inbox/Done.md": { fp: "x", len: 13 } } as never;
		const doneBefore = JSON.parse(JSON.stringify(p1.settings.inboxDone));
		const before = new Map(vault.files);
		const preset: Preset = { ...DEFAULT_PRESETS[0]!, folder: "Out" };
		const plans = await p1.planInbox([A, C].map((x) => new TFile(x)), preset);
		await p1.applyInbox(chosenBatch(plans, [true, true], plans.map((x) => x.plan!.parts.map(() => true))), [], preset);
		expect(p1.settings.lastBatch?.journals).toHaveLength(2);

		const { p, diskText } = await restart(app, p1);
		expect(diskText).toContain('"lastBatch":{');
		expect(p.settings.lastBatch?.journals.map((j) => j.sourcePath)).toEqual([A, C]);
		expect(undoCommand(p)(true)).toBe(true);
		await p.undo();
		expect(vault.files).toEqual(before);
		expect(p.settings.lastBatch).toBeNull();
		expect(p.settings.inboxDone).toEqual(doneBefore);
		expect(notices.at(-1)).toMatch(/^Batch undone: restored 2 notes/);
		const again = await restart(app, p);
		expect(again.p.settings.lastBatch).toBeNull();
	});
});
