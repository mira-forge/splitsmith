import { describe, expect, it, vi } from "vitest";
import { mockElement, settingLog } from "./obsidian-mock";
import SplitsmithPlugin from "../src/main";
import { SplitsmithSettingTab } from "../src/settings";
import { makeApp } from "./mock-app";

vi.stubGlobal("window", { setInterval: () => 1, open: () => null });

async function tab() {
	const { app } = makeApp();
	const p = new SplitsmithPlugin(app as never, {} as never);
	await p.onload();
	return { p, t: new SplitsmithSettingTab(app as never, p) };
}

describe("settings: declarative API (1.13+) with a 1.11.4 fallback (Gate 2 item 2)", () => {
	it("getSettingDefinitions returns groups whose rows all have a name and search aliases", async () => {
		const { t } = await tab();
		const defs = t.getSettingDefinitions() as { type: string; heading?: string; items: { name: string; aliases?: string[]; render: (s: unknown) => void }[] }[];
		expect(defs.map((d) => d.type)).toEqual(defs.map(() => "group"));
		expect(defs.map((d) => d.heading)).toEqual([undefined, "AI split", "Inbox and presets"]);
		const names = defs.flatMap((d) => d.items.map((i) => i.name));
		for (const n of ["Replace each part with", "Folder for new notes", "File name template", "Copy properties to new notes", "Link back property", "Update links to moved headings and blocks", "Delimiter", "Model provider", "Base URL", "Model", "Title language", "Custom instructions"]) {
			expect(names).toContain(n);
		}
		for (const d of defs) for (const i of d.items) expect(i.aliases?.length ?? 0).toBeGreaterThan(0);
		// Every row renders without throwing.
		settingLog.names.length = 0;
		for (const d of defs) for (const i of d.items) i.render(mockElement());
		expect(settingLog.names).toEqual(names);
	});

	it("the legacy display() draws the same rows (headings first in each group)", async () => {
		const { t } = await tab();
		const expected = t.sections().flatMap((s) => [...(s.heading ? [s.heading] : []), ...s.rows.map((r) => r.name)]);
		settingLog.names.length = 0;
		t.display();
		expect(settingLog.names).toEqual(expected);
	});

	it("API key row appears only for providers that need a key (Ollama default has none)", async () => {
		const { p, t } = await tab();
		const names = () => t.sections().flatMap((s) => s.rows.map((r) => r.name));
		expect(names()).not.toContain("API key");
		p.settings.kind = "openai";
		expect(names()).toContain("API key");
		p.settings.kind = "anthropic";
		expect(names()).not.toContain("Base URL");
	});
});
