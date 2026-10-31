/** Inbox mode and saved presets (Gate 2 item 4): listing, presets, batch apply, rollback, undo, free-only (no gating). */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockVault, TFile, notices, requestLog } from "./obsidian-mock";
import SplitsmithPlugin from "../src/main";
import { applyBatch, BatchError, inFolder, pendingNotes, pruneDone, rebasePlan, undoBatch } from "../src/core/inbox";
import { cleanPreset, DEFAULT_PRESETS, describePreset, mechanicalParts, newPresetId, presetOptions, type Preset } from "../src/core/presets";
import { parseDoc, partsByHeading } from "../src/core/sections";
import { fingerprint, planFromParts, type SplitPlan } from "../src/core/plan";
import { chosenBatch } from "../src/ui/inbox-modal";
import { OPTS, makeApp } from "./mock-app";

vi.stubGlobal("window", { setInterval: () => 1, open: () => null });

const A = "Inbox/A.md";
const B = "Inbox/B.md";
const C = "Inbox/C.md";
const noteA = "Intro A\n\n## A one\nfirst\n\n## A two\nsecond\n";
const noteB = "Intro B\n\n## B one\nsee [[Big#Alpha]]\n\n## B two\nmore\n";
const noteC = "Intro C\n\n## C one\nc1\n\n## C two\nc2\n";
const OPT = { ...OPTS, repairLinks: false, folder: "Out" };
const plan2 = (raw: string): SplitPlan => {
	const d = parseDoc(raw);
	return planFromParts(d, partsByHeading(d, 2));
};
const file = (p: string) => new TFile(p);

async function loadedPlugin(files: Record<string, string>) {
	const { app, vault, linkAt } = makeApp(files);
	vault.folders.add("Inbox");
	const p = new SplitsmithPlugin(app as never, {} as never);
	await p.onload();
	return { app, vault, p, linkAt };
}

beforeEach(() => {
	notices.length = 0;
	requestLog.length = 0;
});

describe("inbox listing", () => {
	it("lists new and changed markdown notes in the folder and its subfolders only, sorted", async () => {
		const { app, vault } = makeApp({ [A]: noteA, [B]: noteB, "Inbox/Sub/D.md": "d", "Inbox2/E.md": "e", "Other.md": "o", "Inbox/x.png": "bin" });
		const done = { [A]: fingerprint(noteA), [B]: fingerprint("old text") };
		const list = await pendingNotes(app as never, "Inbox", done);
		expect(list.map((x) => [x.file.path, x.status])).toEqual([
			[B, "changed"],
			["Inbox/Sub/D.md", "new"],
		]);
		vault.files.set(A, noteA + "edit");
		expect((await pendingNotes(app as never, "Inbox/", done)).map((x) => x.file.path)).toContain(A);
		expect(inFolder("Inbox2/E.md", "Inbox")).toBe(false);
		expect(inFolder("Any.md", "/")).toBe(true);
	});
	it("pruneDone drops notes that no longer exist", () => {
		const { app } = makeApp({ [A]: noteA });
		expect(pruneDone(app as never, { [A]: "x", "Gone.md": "y" })).toEqual({ [A]: "x" });
	});
});

describe("presets", () => {
	it("cleanPreset repairs bad data; defaults are valid; options keep link-back and repair from settings", () => {
		expect(cleanPreset({ method: "nope" as never, level: 9, name: "  ", delimiter: "" }, "f")).toMatchObject({ id: "f", method: "heading", level: 2, name: "Preset", delimiter: "---", linkStyle: "link", inherit: "tags" });
		expect(cleanPreset(DEFAULT_PRESETS[0]!, "x")).toEqual(DEFAULT_PRESETS[0]);
		const p = cleanPreset({ method: "delimiter", delimiter: "***", linkStyle: "embed", folder: " Out ", inherit: "none" }, "d");
		expect(describePreset(p)).toBe('At "***" lines, embeds, no properties, into Out');
		expect(presetOptions(p, { sourceProperty: "src", repairLinks: false })).toEqual({ linkStyle: "embed", folder: "Out", fileNameTemplate: "{{title}}", inherit: "none", sourceProperty: "src", repairLinks: false });
		expect(mechanicalParts(parseDoc("a\n\n***\nb\n\n***\nc"), p).map((x) => x.title)).toEqual(["a", "b", "c"]);
		expect(mechanicalParts(parseDoc(noteA), DEFAULT_PRESETS[0]!).map((x) => x.title)).toEqual(["A one", "A two"]);
		expect(newPresetId(["p1"], () => 1)).toBe("p1-2");
	});
});

describe("rebasePlan", () => {
	it("maps a reviewed plan through link edits made earlier in the batch, and refuses anything else", () => {
		const plan = plan2(noteB);
		const at = noteB.indexOf("[[Big#Alpha]]");
		const edited = noteB.replace("[[Big#Alpha]]", "[[Alpha thing]]");
		const r = rebasePlan(plan, edited, [[{ start: at, oldText: "[[Big#Alpha]]", newText: "[[Alpha thing]]" }]])!;
		expect(r.raw).toBe(edited);
		expect(r.parts.map((x) => edited.slice(x.from, x.to))).toEqual(plan.parts.map((x) => noteB.slice(x.from, x.to).replace("[[Big#Alpha]]", "[[Alpha thing]]")));
		expect(r.parts.map((x) => x.title)).toEqual(plan.parts.map((x) => x.title));
		expect(rebasePlan(plan, edited + "user typed", [[{ start: at, oldText: "[[Big#Alpha]]", newText: "[[Alpha thing]]" }]])).toBeNull();
		expect(rebasePlan(plan, edited, [[{ start: at, oldText: "[[Nope]]", newText: "[[Alpha thing]]" }]])).toBeNull();
		// An edit straddling a part boundary is refused.
		const b = plan.parts[1]!.from;
		const straddle = noteB.slice(0, b - 2) + "XX" + noteB.slice(b + 2);
		expect(rebasePlan(plan, straddle, [[{ start: b - 2, oldText: noteB.slice(b - 2, b + 2), newText: "XX" }]])).toBeNull();
	});
});

describe("applyBatch: all or nothing", () => {
	it("splits every note, journals each, and undoBatch restores the vault exactly", async () => {
		const { app, vault } = makeApp({ [A]: noteA, [C]: noteC });
		const before = new Map(vault.files);
		const r = await applyBatch(app as never, [A, C].map((p) => ({ file: file(p), plan: plan2(vault.files.get(p)!), options: OPT })));
		expect(r.journals).toHaveLength(2);
		expect(r.results.flatMap((x) => x.result.created)).toEqual(["Out/A one.md", "Out/A two.md", "Out/C one.md", "Out/C two.md"]);
		expect(vault.files.get(A)).toBe("Intro A\n\n[[A one]]\n\n[[A two]]\n");
		const u = await undoBatch(app as never, r.journals);
		expect(u).toEqual({ undone: 2, remaining: [] });
		expect(vault.files).toEqual(before);
	});

	it("a write that lands but reports an error (process-after) is verified on disk and counts as done, not rolled back", async () => {
		const { app, vault } = makeApp({ [A]: noteA, [C]: noteC });
		vault.failProcess = { path: C, when: "after", times: 1 };
		const r = await applyBatch(app as never, [A, C].map((p) => ({ file: file(p), plan: plan2(vault.files.get(p)!), options: OPT })));
		expect(r.journals.map((j) => j.after)).toEqual([vault.files.get(A), vault.files.get(C)]);
	});

	for (const fault of ["create", "process-before", "read-back"] as const) {
		it(`partial failure (${fault}) on the last note rolls back the earlier notes: vault unchanged`, async () => {
			const { app, vault } = makeApp({ [A]: noteA, [B]: noteB, [C]: noteC });
			const before = new Map(vault.files);
			if (fault === "create") vault.failCreateAt = 4; // first create of C
			if (fault === "process-before") vault.failProcess = { path: C, when: "before" };
			if (fault === "read-back") vault.createTransform = (p, d) => (p.includes("C two") ? d + "corrupt" : d);
			const items = [A, B, C].map((p) => ({ file: file(p), plan: plan2(vault.files.get(p)!), options: OPT }));
			const err = await applyBatch(app as never, items).catch((e: unknown) => e);
			expect(err).toBeInstanceOf(BatchError);
			expect((err as BatchError).remaining).toEqual([]);
			expect((err as Error).message).toMatch(/^Inbox\/C\.md: .*The 2 notes already split in this batch were undone, so nothing was changed\.$/);
			expect(vault.files).toEqual(before);
		});
	}

	it("a note edited after the review is refused; earlier notes are undone", async () => {
		const { app, vault } = makeApp({ [A]: noteA, [B]: noteB });
		const before = new Map(vault.files);
		const items = [A, B].map((p) => ({ file: file(p), plan: plan2(vault.files.get(p)!), options: OPT }));
		vault.files.set(B, noteB + "typed later");
		before.set(B, noteB + "typed later");
		await expect(applyBatch(app as never, items)).rejects.toThrow(/Inbox\/B\.md changed after the review\. The 1 note already split in this batch was undone/);
		expect(vault.files).toEqual(before);
	});

	it("if rollback is refused (a new note was edited mid-run), it stops and returns what is still undoable", async () => {
		const { app, vault } = makeApp({ [A]: noteA, [B]: noteB, [C]: noteC });
		vault.failProcess = { path: C, when: "before" };
		vault.beforeProcess = (p) => {
			if (p === C) vault.files.set("Out/A one.md", "edited by the user");
		};
		const items = [A, B, C].map((p) => ({ file: file(p), plan: plan2(vault.files.get(p)!), options: OPT }));
		const err = (await applyBatch(app as never, items).catch((e: unknown) => e)) as BatchError;
		expect(err).toBeInstanceOf(BatchError);
		expect(err.remaining.map((j) => j.sourcePath)).toEqual([A]);
		expect(err.message).toMatch(/Rolling back the batch stopped at Inbox\/A\.md: .*1 split is still in place/);
		expect(vault.files.get(B)).toBe(noteB); // B was undone
		expect(vault.files.get("Out/A one.md")).toBe("edited by the user"); // the user's edit was kept
	});

	it("cross-note link repair inside one batch: B's link to a moved heading is updated, B still splits losslessly, undo reverts all", async () => {
		const big = "Top\n\n## Alpha\nalpha\n\n## Beta\nbeta\n";
		const { app, vault, linkAt } = makeApp({ "Notes/Big.md": big, [B]: noteB });
		linkAt(B, "[[Big#Alpha]]", "Big#Alpha");
		const before = new Map(vault.files);
		const items = [
			{ file: file("Notes/Big.md"), plan: plan2(big), options: { ...OPT, repairLinks: true } },
			{ file: file(B), plan: plan2(noteB), options: OPT },
		];
		const r = await applyBatch(app as never, items);
		expect(r.journals[0]!.linkEdits.map((x) => x.path)).toEqual([B]);
		expect(vault.files.get("Out/B one.md")).toContain("[[Alpha#Alpha]]");
		expect(vault.files.get(B)).toBe("Intro B\n\n[[B one]]\n\n[[B two]]\n");
		await undoBatch(app as never, r.journals);
		expect(vault.files).toEqual(before);
	});
});

describe("plugin: Inbox mode and presets", () => {
	it("free-only: no license, no network; presets load from defaults", async () => {
		const { app, vault } = makeApp({ [A]: noteA });
		const p = new SplitsmithPlugin(app as never, {} as never);
		await p.onload();
		const cmd = (p as unknown as { commands: { id: string }[] }).commands.find((c) => c.id === "split-with-preset")!;
		expect(cmd).toBeDefined();
		expect(vault.files.size).toBe(1);
		expect(requestLog).toHaveLength(0);
		expect(p.settings.presets).toEqual(DEFAULT_PRESETS);
		expect(p.settings.presets).not.toBe(DEFAULT_PRESETS);
	});

	it('one-part guard: Inbox with a "---" preset never moves a note whose split gives one part', async () => {
		const one = "Only text here\n---\n \u00a0\n";
		const lead = "---\nLead text only\n";
		const two = "First\n\n---\nSecond\n";
		const { vault, p } = await loadedPlugin({ "Inbox/One.md": one, "Inbox/Lead.md": lead, "Inbox/Two.md": two });
		const preset = cleanPreset({ ...DEFAULT_PRESETS[0]!, id: "d", name: "Rule", method: "delimiter", delimiter: "---", folder: "Out" }, "d");
		const files = ["Inbox/Lead.md", "Inbox/One.md", "Inbox/Two.md"].map(file);
		const plans = await p.planInbox(files, preset);
		expect(plans.map((x) => [x.file.path, x.plan ? x.plan.parts.length : x.skip!.reason])).toEqual([
			["Inbox/Lead.md", "Nothing to split"],
			["Inbox/One.md", "Nothing to split"],
			["Inbox/Two.md", 2],
		]);
		expect(vault.files.get("Inbox/One.md")).toBe(one);
	});

	it("plan (no writes), apply batch, mark done, list is then clear; undo restores the vault and the done list", async () => {
		const { vault, p } = await loadedPlugin({ [A]: noteA, [B]: "no headings here\n", [C]: noteC });
		p.settings.inboxFolder = "Inbox";
		const preset: Preset = { ...DEFAULT_PRESETS[0]!, folder: "Out" };
		const before = new Map(vault.files);
		const plans = await p.planInbox([A, B, C].map(file), preset);
		expect(vault.files).toEqual(before);
		expect(plans.map((x) => x.skip?.kind ?? "plan")).toEqual(["plan", "nothing", "plan"]);
		const chosen = chosenBatch(plans, [true, false, true], plans.map((x) => (x.plan ? x.plan.parts.map(() => true) : [])));
		await p.applyInbox(chosen, [file(B)], preset);
		expect(notices.at(-1)).toMatch(/^Inbox: split 2 notes into 4 new notes\. Nothing to split in 1 note, left untouched: B\. Run "Undo last split" to reverse the whole batch\.$/);
		expect(p.settings.lastBatch?.journals).toHaveLength(2);
		expect(p.settings.lastSplit).toBeNull();
		// Sources, nothing-to-split notes and the new notes are all marked, so new notes in the inbox are not listed again.
		expect(Object.keys(p.settings.inboxDone).sort()).toEqual([A, B, C, "Out/A one.md", "Out/A two.md", "Out/C one.md", "Out/C two.md"].sort());
		expect(await pendingNotes(p.app as never, "Inbox", p.settings.inboxDone)).toEqual([]);
		await p.undo();
		expect(vault.files).toEqual(before);
		expect(p.settings.inboxDone).toEqual({});
		expect(p.settings.lastBatch).toBeNull();
		expect(notices.at(-1)).toMatch(/^Batch undone: restored 2 notes/);
	});

	it("a failing batch leaves the vault unchanged, no undo entry, nothing marked done", async () => {
		const { vault, p } = await loadedPlugin({ [A]: noteA, [C]: noteC });
		const preset: Preset = { ...DEFAULT_PRESETS[0]!, folder: "Out" };
		const before = new Map(vault.files);
		const plans = await p.planInbox([A, C].map(file), preset);
		vault.failProcess = { path: C, when: "before" };
		await p.applyInbox(chosenBatch(plans, [true, true], [[true, true], [true, true]]), [], preset);
		expect(vault.files).toEqual(before);
		expect(p.settings.lastBatch).toBeNull();
		expect(p.settings.inboxDone).toEqual({});
		expect(notices.at(-1)).toMatch(/nothing was changed\.$/);
	});

	it("review choices: unticked notes and parts are left alone; titles are cleaned", () => {
		const plans = [{ file: file(A), plan: plan2(noteA) }, { file: file(C), plan: plan2(noteC) }];
		plans[0]!.plan.parts[0]!.title = "CON";
		const out = chosenBatch(plans, [true, false], [[true, false], [true, true]]);
		expect(out).toHaveLength(1);
		expect(out[0]!.plan.parts.map((x) => x.title)).toEqual(["CON_"]);
		expect(chosenBatch(plans, [true, true], [[false, false], [false, false]])).toEqual([]);
	});

	it("loadSettings repairs stored presets and keeps a valid inbox preset id", async () => {
		const { app } = makeApp({});
		const p = new SplitsmithPlugin(app as never, {} as never);
		(p as unknown as { data: unknown }).data = { presets: [{ name: "Mine", method: "delimiter" }], inboxPresetId: "gone" };
		await p.onload();
		expect(p.settings.presets).toHaveLength(1);
		expect(p.settings.presets[0]).toMatchObject({ id: "preset-1", name: "Mine", method: "delimiter", delimiter: "---" });
		expect(p.settings.inboxPresetId).toBe("preset-1");
	});

	it("AI presets: requests go only to the user's provider, with the preset's instructions", async () => {
		const { vault, p } = await loadedPlugin({ [A]: noteA });
		Object.assign(p.settings, { kind: "openai", baseUrl: "https://api.openai.com/v1", model: "m", apiKeySecret: "k", instructions: "GLOBAL" });
		const bodies: string[] = [];
		const hosts: string[] = [];
		p.http = async (r) => {
			hosts.push(new URL(r.url).host);
			bodies.push(r.body!);
			return { status: 200, json: { choices: [{ message: { content: '{"parts":[{"title":"Intro","start":0,"end":1},{"title":"One","start":2,"end":4},{"title":"Two","start":5,"end":6}]}' } }] }, text: "" };
		};
		const before = new Map(vault.files);
		const plans = await p.planInbox([file(A)], { ...DEFAULT_PRESETS[0]!, method: "ai", instructions: "PRESET STYLE" });
		expect(vault.files).toEqual(before);
		expect(plans[0]!.plan?.parts.length).toBeGreaterThan(0);
		expect(hosts).toEqual(["api.openai.com"]);
		expect(bodies[0]).toContain("PRESET STYLE");
		expect(bodies[0]).not.toContain("GLOBAL");
		expect(requestLog).toHaveLength(0);
	});
});

void MockVault;
