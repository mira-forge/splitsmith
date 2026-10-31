/**
 * Gate 3 decision 1: a note with no delimiter, or a heading split that finds only one section, is a no-op.
 * The note is left untouched and reported as "Nothing to split". A whole note is never moved into a new one.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TFile, notices } from "./obsidian-mock";
import SplitsmithPlugin from "../src/main";
import { parseDoc, partsByDelimiter, partsByHeading } from "../src/core/sections";
import { movesWholeNote, planFromParts, planFromSelection, PlanError } from "../src/core/plan";
import { applySplit } from "../src/core/apply";
import { skippedSummary } from "../src/core/inbox";
import { DEFAULT_PRESETS, type Preset } from "../src/core/presets";
import { chosenBatch } from "../src/ui/inbox-modal";
import { makeApp } from "./mock-app";

vi.stubGlobal("window", { setInterval: () => 1, open: () => null });

const OPTS = { folder: "", fileNameTemplate: "{{title}}", linkStyle: "link" as const, inherit: "none" as const, sourceProperty: "", repairLinks: true };

beforeEach(() => void (notices.length = 0));

describe("nothing to split: whole-note moves are no-ops", () => {
	it.each([
		["no delimiter", "just a note\r\nwith lines ☕\r\n", "d"],
		["no delimiter, front matter", "---\ntags: [x]\n---\nplain body\n", "d"],
		["only a leading delimiter", "---\n\nbody only\n", "d"],
		["one heading, nothing else", "# Only\nbody\n", "h1"],
		["one heading after blank lines and properties", "---\na: 1\n---\n\n\n## Only\nbody\n\n", "h2"],
	])("%s: the plan is empty", (_n, raw, how) => {
		const doc = parseDoc(raw);
		const parts = how === "d" ? partsByDelimiter(doc, "---") : partsByHeading(doc, Number(how.slice(1)));
		expect(planFromParts(doc, parts).parts).toEqual([]);
	});
	it("intro text plus one section is still a split (the intro stays)", () => {
		const doc = parseDoc("intro\n## One\nbody\n");
		expect(planFromParts(doc, partsByHeading(doc, 2)).parts).toHaveLength(1);
	});
	it("selecting the whole body is refused as nothing to split", () => {
		const raw = "---\na: 1\n---\n\nall of it\n";
		const doc = parseDoc(raw);
		expect(() => planFromSelection(doc, doc.bodyFrom, raw.length, "T")).toThrow(PlanError);
		expect(() => planFromSelection(doc, doc.bodyFrom, raw.length, "T")).toThrow(/whole note/);
	});
	it("applySplit refuses a hand-made whole-note plan and changes nothing", async () => {
		const raw = "a\nb\n";
		const { app, vault } = makeApp({ "Big.md": raw }, "Big.md");
		const before = new Map(vault.files);
		const plan = { raw, bodyFrom: 0, eol: "\n", parts: [{ title: "T", from: 0, to: raw.length }] };
		expect(movesWholeNote(plan)).toBe(true);
		await expect(applySplit(app as never, new TFile("Big.md"), plan, OPTS)).rejects.toThrow(/Nothing to split/);
		expect(vault.files).toEqual(before);
	});
	it("skippedSummary lists names and caps the list", () => {
		expect(skippedSummary([])).toBe("");
		expect(skippedSummary(["Inbox/A.md"])).toBe("Nothing to split in 1 note, left untouched: A.");
		expect(skippedSummary(Array.from({ length: 12 }, (_, i) => `I/N${i}.md`))).toBe("Nothing to split in 12 notes, left untouched: N0, N1, N2, N3, N4, N5, N6, N7, N8, N9, and 2 more.");
	});

	it("Inbox batch with a delimiter preset across notes lacking the delimiter changes 0 bytes and lists them", async () => {
		const files = {
			"Inbox/Plain.md": "no delimiter here\r\n",
			"Inbox/Props.md": "---\ntags: [a]\n---\nbody, no rule\n",
			"Inbox/Heading.md": "# Title\ntext\n",
			"Inbox/Lead.md": "---\n\nonly a leading rule\n",
			"Inbox/Split.md": "one\n\n---\ntwo\n",
		};
		const { app, vault } = makeApp(files, "Inbox/Plain.md");
		vault.folders.add("Inbox");
		const p = new SplitsmithPlugin(app as never, {} as never);
		await p.onload();
		const base = DEFAULT_PRESETS[0]!;
		const preset: Preset = { ...base, id: "delim", method: "delimiter", delimiter: "---", folder: "Out" };
		const lacking = Object.keys(files).filter((f) => f !== "Inbox/Split.md");
		const before = new Map(vault.files);

		// Only notes lacking the delimiter: every one is "nothing", the batch writes no note.
		const plans = await p.planInbox(lacking.map((x) => new TFile(x)), preset);
		expect(plans.map((x) => x.skip?.kind)).toEqual(["nothing", "nothing", "nothing", "nothing"]);
		await p.applyInbox(chosenBatch(plans, plans.map(() => true), plans.map(() => [])), plans.map((x) => x.file), preset);
		expect(vault.files).toEqual(before);
		expect(notices.at(-1)).toMatch(/^Nothing to split in 4 notes, left untouched: Plain, Props, Heading, Lead\./);

		// Mixed batch: the one note with a delimiter is split, the others are byte-identical and listed.
		const all = await p.planInbox(Object.keys(files).map((x) => new TFile(x)), preset);
		const chosen = chosenBatch(all, all.map(() => true), all.map((x) => (x.plan ? x.plan.parts.map(() => true) : [])));
		expect(chosen.map((c) => c.file.path)).toEqual(["Inbox/Split.md"]);
		await p.applyInbox(chosen, all.filter((x) => x.skip?.kind === "nothing").map((x) => x.file), preset);
		for (const f of lacking) expect(vault.files.get(f)).toBe(before.get(f));
		expect(vault.files.get("Inbox/Split.md")).not.toBe(before.get("Inbox/Split.md"));
		expect(notices.at(-1)).toMatch(/^Inbox: split 1 note into 2 new notes\. Nothing to split in 4 notes, left untouched: Plain, Props, Heading, Lead\./);
	});
});
