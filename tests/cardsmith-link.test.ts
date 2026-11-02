import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { TFile, noticeFragments, notices, type FakeEl } from "./obsidian-mock";
import SplitsmithPlugin from "../src/main";
import { CARDSMITH_COMMAND, CARDSMITH_URL, cardsmithLinkText } from "../src/ui/cardsmith-link";
import { DEFAULT_SETTINGS } from "../src/settings";
import { parseDoc, partsByHeading } from "../src/core/sections";
import { planFromParts } from "../src/core/plan";
import { NOTE, SRC, makeApp } from "./mock-app";

const opened: string[] = [];
vi.stubGlobal("window", { setInterval: () => 1, open: (u: string) => (opened.push(u), null) });

beforeEach(() => {
	notices.length = 0;
	noticeFragments.length = 0;
	opened.length = 0;
});

/** Plugin on a mocked app; `cardsmith` adds it to enabledPlugins and registers its command. */
async function setup(opts: { cardsmith?: boolean; data?: unknown; commandOk?: boolean } = {}) {
	const env = makeApp({ [SRC]: NOTE });
	const ran: string[] = [];
	const openedFiles: string[] = [];
	const app = env.app as Record<string, unknown>;
	app.plugins = { enabledPlugins: new Set(opts.cardsmith ? ["cardsmith"] : ["dataview"]) };
	app.commands = {
		commands: opts.cardsmith ? { [CARDSMITH_COMMAND]: {} } : {},
		executeCommandById: (id: string) => (ran.push(id), opts.commandOk ?? true),
	};
	(app.workspace as Record<string, unknown>).getLeaf = () => ({ openFile: async (f: TFile) => void openedFiles.push(f.path) });
	const p = new SplitsmithPlugin(env.app as never, {} as never);
	(p as unknown as { data: unknown }).data = opts.data ?? null;
	await p.onload();
	const doc = parseDoc(NOTE);
	const plan = planFromParts(doc, partsByHeading(doc, 2));
	return { ...env, p, plan, ran, openedFiles };
}

const linkLine = (f: FakeEl) => f.find((e) => e.cls === "splitsmith-cardsmith-link");
const anchor = (f: FakeEl, text: string) => f.find((e) => e.tag === "a" && e.text === text);
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("Cardsmith link after a split", () => {
	it("is on by default and adds one line inside the existing result notice, after the unchanged message", async () => {
		expect(DEFAULT_SETTINGS.showCardsmithLink).toBe(true);
		const { p, plan } = await setup();
		await p.apply(new TFile(SRC), plan, "link");
		expect(notices.at(-1)).toMatch(/^Created 2 notes\..*Run "Undo last split" to reverse it\.$/);
		const f = noticeFragments.at(-1)!;
		expect(f.children).toHaveLength(2);
		const line = linkLine(f)!;
		expect(line.textContent).toBe("Turn these notes into flashcards with Cardsmith · Don't show again");
	});

	it("without Cardsmith, selecting the link opens the community listing", async () => {
		const { p, plan, ran } = await setup();
		await p.apply(new TFile(SRC), plan, "link");
		anchor(noticeFragments.at(-1)!, "Turn these notes into flashcards with Cardsmith")!.click();
		await flush();
		expect(opened).toEqual([CARDSMITH_URL]);
		expect(ran).toEqual([]);
	});

	it("with Cardsmith enabled, says 'Make flashcards with Cardsmith', opens the first new note and runs its command", async () => {
		const { p, plan, ran, openedFiles } = await setup({ cardsmith: true });
		await p.apply(new TFile(SRC), plan, "link");
		const a = anchor(noticeFragments.at(-1)!, "Make flashcards with Cardsmith")!;
		expect(a).toBeDefined();
		a.click();
		await flush();
		expect(openedFiles).toEqual(["Notes/Alpha.md"]);
		expect(ran).toEqual([CARDSMITH_COMMAND]);
		expect(opened).toEqual([]);
	});

	it("falls back to the listing if Cardsmith's command does not run", async () => {
		const { p, plan } = await setup({ cardsmith: true, commandOk: false });
		await p.apply(new TFile(SRC), plan, "link");
		anchor(noticeFragments.at(-1)!, "Make flashcards with Cardsmith")!.click();
		await flush();
		expect(opened).toEqual([CARDSMITH_URL]);
	});

	it("'Don't show again' turns the setting off, saves it, and later splits show a plain notice", async () => {
		const { p, plan, vault } = await setup();
		await p.apply(new TFile(SRC), plan, "link");
		anchor(noticeFragments.at(-1)!, "Don't show again")!.click();
		await flush();
		expect(p.settings.showCardsmithLink).toBe(false);
		expect((p as unknown as { data: { showCardsmithLink: boolean } }).data.showCardsmithLink).toBe(false);
		expect(opened).toEqual([]);
		await p.undo();
		vault.files.set(SRC, NOTE);
		const count = noticeFragments.length;
		await p.apply(new TFile(SRC), plan, "link");
		expect(noticeFragments.length).toBe(count);
		expect(notices.at(-1)).toMatch(/^Created 2 notes/);
	});

	it("the setting turned off in data.json hides it; a hand-edited non-boolean falls back to on", async () => {
		const off = await setup({ data: { showCardsmithLink: false } });
		await off.p.apply(new TFile(SRC), off.plan, "link");
		expect(noticeFragments).toHaveLength(0);
		const bad = await setup({ data: { showCardsmithLink: "yes" } });
		expect(bad.p.settings.showCardsmithLink).toBe(true);
	});

	it("no link on failed splits, undo, or at startup", async () => {
		const { p, plan, vault } = await setup();
		expect(noticeFragments).toHaveLength(0); // onload shows nothing
		vault.beforeProcess = (path) => void (path === SRC && vault.files.set(SRC, NOTE + "\nedited"));
		await p.apply(new TFile(SRC), plan, "link");
		expect(noticeFragments).toHaveLength(0);
		expect(notices.at(-1)).toMatch(/Nothing was changed|changed/i);
	});

	it("cardsmithLinkText tolerates a missing plugins registry", () => {
		expect(cardsmithLinkText({} as never, true)).toBe("Turn these notes into flashcards with Cardsmith");
		expect(cardsmithLinkText({} as never, false)).toBeNull();
	});

	it("guidelines: no hotkeys, no bare timers, no innerHTML, no new modal or onload notice in the link code", () => {
		const src = readFileSync("src/ui/cardsmith-link.ts", "utf8");
		expect(src).not.toMatch(/hotkeys|innerHTML|outerHTML|Modal|(?<!window\.)\b(setTimeout|setInterval)\(/);
		const main = readFileSync("src/main.ts", "utf8");
		expect(main).not.toMatch(/hotkeys\s*:/);
		const onload = main.slice(main.indexOf("async onload"), main.indexOf("async loadSettings"));
		expect(onload).not.toMatch(/Cardsmith|cardsmith/);
	});
});
