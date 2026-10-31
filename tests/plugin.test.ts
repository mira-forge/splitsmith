import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { MockVault, Platform, TFile, notices, requestLog } from "./obsidian-mock";
import SplitsmithPlugin from "../src/main";
import { applySplit, undoSplit } from "../src/core/apply";
import { parseDoc, partsByHeading } from "../src/core/sections";
import { planFromParts, planFromSelection } from "../src/core/plan";
import type { HttpRequest } from "../src/ai/providers";

vi.stubGlobal("window", { setInterval: () => 1, open: () => null });

import { NOTE, OPTS, SRC, makeApp } from "./mock-app";

describe("apply + undo with mocked Obsidian", () => {
	it("splits by heading: new notes hold the exact bytes, source gets links, properties and a link back, inbound links repaired; undo restores byte for byte", async () => {
		const other = "See [[Big#Alpha]] and [[Big#Beta detail|details]] and [[Big#^blk1]] and [[Big#^intro]] and [[Big]].";
		const { app, vault, linkAt } = makeApp({ [SRC]: NOTE, "Other.md": other });
		linkAt("Other.md", "[[Big#Alpha]]", "Big#Alpha");
		linkAt("Other.md", "[[Big#Beta detail|details]]", "Big#Beta detail", "details");
		linkAt("Other.md", "[[Big#^blk1]]", "Big#^blk1");
		linkAt("Other.md", "[[Big#^intro]]", "Big#^intro");
		linkAt("Other.md", "[[Big]]", "Big");
		const doc = parseDoc(NOTE);
		const plan = planFromParts(doc, partsByHeading(doc, 2));
		const r = await applySplit(app as never, new TFile(SRC), plan, OPTS);
		expect(r.created).toEqual(["Notes/Alpha.md", "Notes/Beta ☕.md"]);
		expect(vault.files.get("Notes/Alpha.md")).toBe('---\r\ntags: \r\n  - "project"\r\nsource: "[[Big]]"\r\n---\r\n## Alpha\r\nalpha text ^blk1\r\n```\r\n## fake\r\n```\r\n');
		expect(vault.files.get("Notes/Beta ☕.md")!.endsWith("## Beta ☕\r\n### Beta detail\r\nbeta text")).toBe(true);
		expect(vault.files.get(SRC)).toBe("---\r\ntags: [project]\r\naliases: [Big]\r\n---\r\nIntro ^intro\r\n\r\n[[Alpha]]\r\n\r\n[[Beta ☕]]");
		expect(vault.files.get("Other.md")).toBe("See [[Alpha#Alpha]] and [[Beta ☕#Beta detail|details]] and [[Alpha#^blk1]] and [[Big#^intro]] and [[Big]].");
		expect(r.linksUpdated).toBe(3);
		expect(vault.files.get("Notes/Alpha.md")).not.toContain("aliases");

		const u = await undoSplit(app as never, r.journal);
		expect(u).toEqual({ trashed: 2, linksReverted: 3, linksSkipped: 0 });
		expect(vault.files.get(SRC)).toBe(NOTE);
		expect(vault.files.get("Other.md")).toBe(other);
		expect(vault.files.has("Notes/Alpha.md")).toBe(false);
		expect(vault.trashed).toEqual(["Notes/Alpha.md", "Notes/Beta ☕.md"]);
	});

	it("extract selection mid-line, with embeds, into a folder, avoiding existing names", async () => {
		const raw = "one two three\nfour five\n";
		const { app, vault } = makeApp({ "Big.md": raw, "Out/two three.md": "existing" });
		const doc = parseDoc(raw);
		const from = raw.indexOf("two");
		const plan = planFromSelection(doc, from, raw.indexOf(" five"), "two three");
		const r = await applySplit(app as never, new TFile("Big.md"), plan, { ...OPTS, linkStyle: "embed", folder: "Out", inherit: "none", sourceProperty: "" });
		expect(r.created).toEqual(["Out/two three 2.md"]);
		expect(vault.files.get("Out/two three 2.md")).toBe("two three\nfour");
		expect(vault.files.get("Big.md")).toBe("one ![[two three 2]] five\n");
		expect(vault.files.get("Out/two three.md")).toBe("existing");
	});

	it("refuses and rolls back when the note changes between preview and write", async () => {
		const { app, vault } = makeApp({ [SRC]: NOTE });
		const doc = parseDoc(NOTE);
		const plan = planFromParts(doc, partsByHeading(doc, 2));
		vault.beforeProcess = (p) => {
			if (p === SRC) vault.files.set(SRC, NOTE + "\r\nnew line typed meanwhile");
		};
		await expect(applySplit(app as never, new TFile(SRC), plan, OPTS)).rejects.toThrow(/changed while splitting/);
		expect(vault.files.get(SRC)).toBe(NOTE + "\r\nnew line typed meanwhile");
		expect([...vault.files.keys()].sort()).toEqual([SRC]);
		expect(vault.trashed).toEqual(["Notes/Alpha.md", "Notes/Beta ☕.md"]);
	});

	it("rolls back created notes if one cannot be created", async () => {
		const { app, vault } = makeApp({ [SRC]: NOTE });
		vault.failCreateAt = 1;
		const doc = parseDoc(NOTE);
		await expect(applySplit(app as never, new TFile(SRC), planFromParts(doc, partsByHeading(doc, 2)), OPTS)).rejects.toThrow(/nothing was changed/);
		expect(vault.files.get(SRC)).toBe(NOTE);
		expect([...vault.files.keys()]).toEqual([SRC]);
	});

	it("refuses to write when the lossless check fails (a link generator that eats text)", async () => {
		const { app, vault } = makeApp({ [SRC]: NOTE });
		const doc = parseDoc(NOTE);
		const plan = planFromParts(doc, partsByHeading(doc, 2));
		const broken = { ...plan, parts: [{ ...plan.parts[0]!, to: plan.parts[0]!.to + 1000 }] };
		await expect(applySplit(app as never, new TFile(SRC), broken, OPTS)).rejects.toThrow();
		expect(vault.files.get(SRC)).toBe(NOTE);
		expect([...vault.files.keys()]).toEqual([SRC]);
	});

	it("undo refuses if the source or a new note was edited afterwards", async () => {
		const { app, vault } = makeApp({ [SRC]: NOTE });
		const doc = parseDoc(NOTE);
		const r = await applySplit(app as never, new TFile(SRC), planFromParts(doc, partsByHeading(doc, 2)), OPTS);
		vault.files.set("Notes/Alpha.md", vault.files.get("Notes/Alpha.md") + "\nmy new thought");
		await expect(undoSplit(app as never, r.journal)).rejects.toThrow(/edited after the split/);
		expect(vault.files.has("Notes/Beta ☕.md")).toBe(true);
		vault.files.set(SRC, "changed");
		await expect(undoSplit(app as never, r.journal)).rejects.toThrow(/source note was edited/);
	});
});


describe("plugin with mocked Obsidian", () => {
	it("loads, registers commands without plugin-id prefixes, and makes no network calls (free-only, no license code)", async () => {
		const { app } = makeApp();
		const p = new SplitsmithPlugin(app as never, {} as never);
		await p.onload();
		const ids = (p as unknown as { commands: { id: string }[] }).commands.map((c) => c.id);
		expect(ids).toEqual(["split-by-heading", "split-by-delimiter", "split-at-cursor", "extract-selection", "ai-split", "split-with-preset", "process-inbox", "undo-last-split"]);
		expect(ids.some((i) => i.includes("splitsmith"))).toBe(false);
		expect(requestLog).toHaveLength(0);
	});

	it("flush never rewrites an unchanged note (keeps CRLF), but saves real unsaved edits", async () => {
		const { app, vault } = makeApp({ [SRC]: NOTE });
		let editorText = NOTE.replace(/\r\n/g, "\n");
		let saves = 0;
		const view = { file: new TFile(SRC), editor: { getValue: () => editorText }, save: async () => void saves++ };
		app.workspace.getActiveViewOfType = (() => view) as never;
		const p = new SplitsmithPlugin(app as never, {} as never);
		await p.onload();
		await p.flush(new TFile(SRC));
		expect(saves).toBe(0);
		expect(vault.files.get(SRC)).toBe(NOTE);
		editorText += "\ntyped but not saved yet";
		await p.flush(new TFile(SRC));
		expect(saves).toBe(1);
	});

	it("plugin.apply saves an undo journal; undo command restores the note", async () => {
		const { app, vault } = makeApp({ [SRC]: NOTE });
		const p = new SplitsmithPlugin(app as never, {} as never);
		await p.onload();
		const doc = parseDoc(NOTE);
		await p.apply(new TFile(SRC), planFromParts(doc, partsByHeading(doc, 2)), "link");
		expect(p.settings.lastSplit?.created).toHaveLength(2);
		expect(notices.at(-1)).toMatch(/Created 2 notes/);
		await p.undo();
		expect(vault.files.get(SRC)).toBe(NOTE);
		expect(p.settings.lastSplit).toBeNull();
	});

	it("AI split: request goes only to the user's provider with the user's key; no other host; cap of 40", async () => {
		const { app } = makeApp({ [SRC]: NOTE });
		const p = new SplitsmithPlugin(app as never, {} as never);
		await p.onload();
		Object.assign(p.settings, { kind: "openai", baseUrl: "https://api.openai.com/v1", model: "m", apiKeySecret: "my-key" });
		const seen: HttpRequest[] = [];
		p.http = async (r) => {
			seen.push(r);
			return { status: 200, json: { choices: [{ message: { content: '{"parts":[{"title":"Intro","start":0,"end":1},{"title":"Alpha","start":2,"end":7},{"title":"Beta","start":8,"end":10}]}' } }] }, text: "" };
		};
		await p.aiSplit(parseDoc(NOTE), new TFile(SRC));
		expect(seen.map((r) => new URL(r.url).host)).toEqual(["api.openai.com"]);
		expect(seen[0]!.headers.authorization).toBe("Bearer sk-user-secret");
		expect(JSON.parse(seen[0]!.body!).messages[0].content).toContain("at most 40 parts");
		expect(requestLog).toHaveLength(0);
	});

	it("mobile: AI split with Ollama fails gracefully with a clear notice and changes nothing", async () => {
		const { app } = makeApp({ [SRC]: NOTE });
		const p = new SplitsmithPlugin(app as never, {} as never);
		await p.onload();
		Object.assign(p.settings, { kind: "ollama", baseUrl: "http://localhost:11434", model: "llama3.1" });
		p.http = async () => { throw new Error("net::ERR_CONNECTION_REFUSED"); };
		Platform.isMobile = true;
		try {
			await p.aiSplit(parseDoc(NOTE), new TFile(SRC));
		} finally {
			Platform.isMobile = false;
		}
		expect(notices.at(-1)).toMatch(/Ollama can't run on a phone or tablet.*Nothing was changed\.$/);
		expect((app as { vault: MockVault }).vault.files.size).toBe(1);
		expect((app as { vault: MockVault }).vault.files.get(SRC)).toBe(NOTE);
		expect((p as unknown as { busy: boolean }).busy).toBe(false);
	});

	it("custom instructions are sent to the user's model (free-only: no gating)", async () => {
		const { app } = makeApp({ [SRC]: NOTE });
		const p = new SplitsmithPlugin(app as never, {} as never);
		await p.onload();
		Object.assign(p.settings, { kind: "openai", baseUrl: "https://api.openai.com/v1", model: "m", apiKeySecret: "k", instructions: "MY STYLE" });
		const bodies: string[] = [];
		p.http = async (r) => {
			bodies.push(r.body!);
			return { status: 200, json: { choices: [{ message: { content: '{"parts":[{"title":"All","start":0,"end":10}]}' } }] }, text: "" };
		};
		await p.aiSplit(parseDoc(NOTE), new TFile(SRC));
		expect(bodies[0]).toContain("MY STYLE");
		expect(bodies[0]).toContain("at most 40 parts");
	});

});

describe("README disclosures", () => {
	const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
	it("says it is free with no account, and the required disclosures", () => {
		expect(readme).toMatch(/free/i);
		expect(readme).not.toMatch(/Payment is required|\bPro\b|\$3/);
		expect(readme).toMatch(/Network use/);
		expect(readme).toMatch(/AI-run studio: code is written and tested by AI agents/);
		expect(readme).not.toMatch(/byte for byte|reviewed and tested by Mira Forge|AI assistance/);
		expect(readme).toMatch(/no telemetry/i);
		expect(readme).toMatch(/never (reaches|sent to|receives)/i);
	});

	it("discloses known limitations (gap 6: footnotes, same-note links) and the honest link-repair failure behaviour", () => {
		expect(readme).toMatch(/## Known limitations/);
		expect(readme).toMatch(/\*\*Footnotes:\*\*/);
		expect(readme).toMatch(/\*\*Same-note links:\*\*.*\[\[#Heading\]\]/);
		expect(readme).toMatch(/link repair failed/);
	});
});

describe("defaults", () => {
	it("Ollama is the default provider", async () => {
		const { DEFAULT_SETTINGS } = await import("../src/settings");
		expect(DEFAULT_SETTINGS.preset).toBe("ollama");
		expect(DEFAULT_SETTINGS.kind).toBe("ollama");
	});
});
