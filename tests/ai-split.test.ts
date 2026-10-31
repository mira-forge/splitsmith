import { describe, expect, it } from "vitest";
import { parseDoc } from "../src/core/sections";
import { windows, validatePlan } from "../src/core/segment";
import { planWithAi } from "../src/core/ai-split";
import { planFromParts, render, verifyLossless } from "../src/core/plan";
import { MAX_AI_PARTS } from "../src/config";

/** A fake model that cuts its window every `every` lines and echoes back the window it was given. */
function fakeModel(every: number, opts: { rewrite?: boolean } = {}) {
	const seen: { system: string; user: string }[] = [];
	const ask = async (system: string, user: string) => {
		seen.push({ system, user });
		const nums = user.split("\n").map((l) => Number(l.slice(0, l.indexOf("|"))));
		const s = nums[0]!;
		const e = nums.at(-1)!;
		const parts = [];
		for (let a = s; a <= e; a += every) parts.push({ title: `Topic ${a}`, start: a, end: Math.min(e, a + every - 1), ...(opts.rewrite ? { text: "MODEL REWROTE THIS" } : {}) });
		return "Here is the plan:\n```json\n" + JSON.stringify({ parts }) + "\n```";
	};
	return { ask, seen };
}

const note = (n: number) => Array.from({ length: n }, (_, i) => (i % 5 === 3 ? "" : `Line ${i} with some words`)).join("\n");

describe("AI split (plan only, validated)", () => {
	it("a plan over the cap is refused, not truncated", async () => {
		const doc = parseDoc(note(60));
		await expect(planWithAi(doc, { instructions: "", language: "", windowChars: 24000, ask: fakeModel(1).ask })).rejects.toThrow(/limit is 40/);
	});
	it("cap of 40 and custom instructions are sent (free-only: everything is on)", async () => {
		const doc = parseDoc(note(20));
		const m = fakeModel(2);
		const parts = await planWithAi(doc, { instructions: "One note per decision", language: "German", windowChars: 24000, ask: m.ask });
		expect(parts).toHaveLength(10);
		expect(m.seen[0]!.system).toContain(`at most ${MAX_AI_PARTS} parts`);
		expect(m.seen[0]!.system).toContain("One note per decision");
		expect(m.seen[0]!.system).toContain("German");
	});
	it("long notes: sends windows and stitches a valid whole-note plan", async () => {
		const doc = parseDoc(note(400));
		const ws = windows(doc, 3000);
		expect(ws.length).toBeGreaterThan(1);
		expect(ws[0]!.start).toBe(0);
		expect(ws.at(-1)!.end).toBe(399);
		for (let k = 1; k < ws.length; k++) expect(ws[k]!.start).toBe(ws[k - 1]!.end + 1);
		const pro = fakeModel(40);
		const parts = await planWithAi(doc, { instructions: "", language: "", windowChars: 3000, ask: pro.ask });
		expect(pro.seen).toHaveLength(ws.length);
		expect(() => validatePlan(doc, parts, MAX_AI_PARTS)).not.toThrow();
		const plan = planFromParts(doc, parts);
		expect(verifyLossless(doc.raw, render(plan, (i) => `[[${i}]]`, () => ""))).toEqual({ ok: true });
	});
	it("windows never cut inside a code block", () => {
		const raw = ["intro", "", "```", ...Array.from({ length: 200 }, (_, i) => `code ${i}`), "```", "", "after"].join("\n");
		const doc = parseDoc(raw);
		for (const w of windows(doc, 500)) {
			const prev = doc.lines[w.start - 1];
			const here = doc.lines[w.start]!;
			expect(prev && here.block >= 0 && prev.block === here.block).toBeFalsy();
		}
	});
	it("whatever text the model sends back is ignored: new notes contain only the original lines", async () => {
		const doc = parseDoc("# A\nalpha\n\n# B\nbeta");
		const parts = await planWithAi(doc, { instructions: "", language: "", windowChars: 24000, ask: fakeModel(3, { rewrite: true }).ask });
		const out = render(planFromParts(doc, parts), (i) => `[[${i}]]`, () => "");
		expect(JSON.stringify(out)).not.toContain("MODEL REWROTE");
		expect(out.parts.map((p) => p.content).join("")).toBe("# A\nalpha\n# B\nbeta");
	});
	it("a model plan that skips or overlaps lines fails loudly", async () => {
		const doc = parseDoc(note(10));
		const skip = async () => '{"parts":[{"title":"A","start":0,"end":3},{"title":"B","start":5,"end":9}]}';
		const overlap = async () => '{"parts":[{"title":"A","start":0,"end":5},{"title":"B","start":4,"end":9}]}';
		const empty = async () => "";
		await expect(planWithAi(doc, { instructions: "", language: "", windowChars: 24000, ask: skip })).rejects.toThrow(/skips/);
		await expect(planWithAi(doc, { instructions: "", language: "", windowChars: 24000, ask: overlap })).rejects.toThrow(/overlapping/);
		await expect(planWithAi(doc, { instructions: "", language: "", windowChars: 24000, ask: empty })).rejects.toThrow(/did not return/);
		await expect(planWithAi(parseDoc("\n\n"), { instructions: "", language: "", windowChars: 24000, ask: empty })).rejects.toThrow(/no text/);
	});
	it("duplicate titles are numbered", async () => {
		const doc = parseDoc(note(10));
		const same = async () => '{"parts":[{"title":"Same","start":0,"end":4},{"title":"same","start":5,"end":9}]}';
		const parts = await planWithAi(doc, { instructions: "", language: "", windowChars: 24000, ask: same });
		expect(parts.map((p) => p.title)).toEqual(["Same", "same 2"]);
	});

});
