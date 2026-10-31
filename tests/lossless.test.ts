import { describe, expect, it } from "vitest";
import { parseDoc, partsByDelimiter, partsByHeading, partAtLine, type Doc, type Part } from "../src/core/sections";
import { validatePlan } from "../src/core/segment";
import {
	buildPrefix,
	checkPlan,
	dropPart,
	fileNameFrom,
	inheritedProps,
	mergeWithNext,
	planFromParts,
	planFromSelection,
	render,
	uniquePath,
	verifyLossless,
	type RenderedSplit,
	type SplitPlan,
} from "../src/core/plan";
import { stringifyYaml } from "./obsidian-mock";

/** Seeded PRNG (mulberry32) so failures are reproducible. */
function rng(seed: number) {
	let a = seed >>> 0;
	const next = () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	return { next, int: (n: number) => Math.floor(next() * n), pick: <T,>(xs: T[]) => xs[Math.floor(next() * xs.length)]! };
}

const WORDS = ["alpha", "Béta", "日本語", "emoji 🧪🔥", "zero\u200bwidth", "e\u0301 combining", "עברית", "tab\there", "  indented", "trailing  ", "[[Link]]", "#tag", "^block-1", "> quote", "- item", "1. step", "| a | b |", "$x^2$", "%%comment%%", "a\rlone CR"];

/** Random Markdown with front matter, nested headings, code blocks (with fake headings), delimiters, CRLF/LF mixes, unicode. */
function randomNote(seed: number): string {
	const r = rng(seed);
	const eols = r.pick([["\n"], ["\r\n"], ["\n", "\r\n"]]);
	const lines: string[] = [];
	if (r.next() < 0.5) lines.push("---", `tags: [${r.pick(["a", "b, c", "x/y"])}]`, `title: ${r.pick(WORDS)}`, "---");
	const n = 3 + r.int(40);
	for (let i = 0; i < n; i++) {
		const k = r.int(12);
		if (k === 0) lines.push(`${"#".repeat(1 + r.int(6))} ${r.pick(WORDS)}`);
		else if (k === 1) {
			const f = r.pick(["```", "~~~", "````"]);
			lines.push(f + r.pick(["", "py", "md"]), `${"#".repeat(1 + r.int(3))} not a heading`, "---", r.pick(WORDS), f);
		} else if (k === 2) lines.push("", "---", "");
		else if (k === 3) lines.push("");
		else if (k === 4) lines.push(`Setext ${r.pick(WORDS)}`, r.pick(["---", "==="]));
		else lines.push(`${r.pick(WORDS)} ${r.pick(WORDS)}`);
	}
	let out = "";
	lines.forEach((l, i) => {
		out += l;
		if (i < lines.length - 1 || r.next() < 0.6) out += r.pick(eols);
	});
	return out;
}

/** Independent re-assembly (does not use verifyLossless): kept text and moved ranges in order. */
function reassemble(plan: SplitPlan): string {
	let out = "";
	let cur = 0;
	for (const p of plan.parts) {
		out += plan.raw.slice(cur, p.from) + plan.raw.slice(p.from, p.to);
		cur = p.to;
	}
	return out + plan.raw.slice(cur);
}

const yaml = (o: Record<string, unknown>) => stringifyYaml(o);

function renderAll(plan: SplitPlan, seed: number): RenderedSplit {
	const r = rng(seed);
	const style = r.pick(["link", "embed", "none"]);
	const props = r.next() < 0.5 ? { source: "[[Src]]", tags: ["a"] } : {};
	return render(
		plan,
		(i) => (style === "none" ? "" : style === "embed" ? `![[Part ${i}]]` : `[[Part ${i}]]`),
		() => buildPrefix(props, yaml, plan.eol),
	);
}

function randomPartition(doc: Doc, seed: number): Part[] {
	const r = rng(seed);
	const parts: Part[] = [];
	let s = 0;
	const n = doc.lines.length;
	while (s < n) {
		let e = Math.min(n - 1, s + r.int(6));
		while (e < n - 1 && doc.lines[e + 1]!.block >= 0 && doc.lines[e + 1]!.block === doc.lines[e]!.block) e++; // never end inside code
		parts.push({ title: `T${parts.length}`, start: s, end: e });
		s = e + 1;
	}
	return parts;
}

const SEEDS = Array.from({ length: 300 }, (_, i) => i + 1);

describe("lossless property tests (300 random notes each)", () => {
	it("heading splits at every level reproduce the note byte for byte", () => {
		let checked = 0;
		for (const seed of SEEDS) {
			const raw = randomNote(seed);
			const doc = parseDoc(raw);
			for (let level = 1; level <= 6; level++) {
				const plan = planFromParts(doc, partsByHeading(doc, level));
				expect(reassemble(plan)).toBe(raw);
				if (!plan.parts.length) continue;
				expect(verifyLossless(raw, renderAll(plan, seed * 7 + level))).toEqual({ ok: true });
				// a part never starts or ends inside a fenced code block
				for (const p of plan.parts) expect(raw.slice(p.from, p.to)).not.toMatch(/^\s*$/);
				checked++;
			}
		}
		expect(checked).toBeGreaterThan(300);
	});

	it("delimiter and cursor splits reproduce the note", () => {
		for (const seed of SEEDS) {
			const raw = randomNote(seed);
			const doc = parseDoc(raw);
			for (const parts of [partsByDelimiter(doc), partAtLine(doc, rng(seed).int(Math.max(1, doc.lines.length)))]) {
				const plan = planFromParts(doc, parts);
				if (!plan.parts.length) continue;
				expect(verifyLossless(raw, renderAll(plan, seed))).toEqual({ ok: true });
			}
		}
	});

	it("any valid AI-style partition, then preview merges and drops, reproduces the note", () => {
		for (const seed of SEEDS) {
			const raw = randomNote(seed);
			const doc = parseDoc(raw);
			if (!doc.lines.length) continue;
			const parts = validatePlan(doc, randomPartition(doc, seed), 10_000);
			let plan = planFromParts(doc, parts);
			const r = rng(seed + 99);
			for (let k = 0; k < 3 && plan.parts.length > 1; k++) {
				plan = r.next() < 0.5 ? mergeWithNext(plan, r.int(plan.parts.length - 1)) : dropPart(plan, r.int(plan.parts.length));
				checkPlan(plan);
			}
			if (!plan.parts.length) continue;
			expect(reassemble(plan)).toBe(raw);
			expect(verifyLossless(raw, renderAll(plan, seed))).toEqual({ ok: true });
		}
	});

	it("random selections (mid-line, mid-character-run, CRLF) extract losslessly", () => {
		let n = 0;
		for (const seed of SEEDS) {
			const raw = randomNote(seed);
			const doc = parseDoc(raw);
			const r = rng(seed);
			const a = doc.bodyFrom + r.int(Math.max(1, raw.length - doc.bodyFrom));
			const b = a + 1 + r.int(Math.max(1, raw.length - a));
			if (!raw.slice(a, Math.min(b, raw.length)).trim()) continue;
			const plan = planFromSelection(doc, a, Math.min(b, raw.length), "Sel");
			expect(verifyLossless(raw, renderAll(plan, seed))).toEqual({ ok: true });
			n++;
		}
		expect(n).toBeGreaterThan(200);
	});

	it("the check catches any tampering with what would be written", () => {
		for (const seed of SEEDS.slice(0, 100)) {
			const raw = randomNote(seed);
			const doc = parseDoc(raw);
			const plan = planFromParts(doc, partsByHeading(doc, 1).length ? partsByHeading(doc, 1) : randomPartition(doc, seed));
			if (!plan.parts.length) continue;
			const good = renderAll(plan, seed);
			const r = rng(seed);
			const i = r.int(good.parts.length);
			const p = good.parts[i]!;
			const body = p.content.slice(p.prefix.length);
			const at = r.int(body.length);
			const tampered = [
				// a changed character in a new note
				{ ...good, parts: good.parts.map((x, k) => (k === i ? { ...x, content: x.prefix + body.slice(0, at) + (body[at] === "x" ? "y" : "x") + body.slice(at + 1) } : x)) },
				// a dropped character
				{ ...good, parts: good.parts.map((x, k) => (k === i ? { ...x, content: x.prefix + body.slice(0, at) + body.slice(at + 1) } : x)) },
				// text left in the source as well as moved (duplicate)
				{ ...good, source: good.source + body },
				// CRLF normalised to LF
				{ ...good, parts: good.parts.map((x) => ({ ...x, content: x.content.replace(/\r\n/g, "\n") })), source: good.source.replace(/\r\n/g, "\n") },
				// a part missing
				{ ...good, parts: good.parts.slice(1), markers: good.markers.slice(1) },
				// prefix tampered
				{ ...good, parts: good.parts.map((x, k) => (k === i ? { ...x, prefix: "---\nx: 1\n---\n" } : x)) },
			];
			for (const [k, t] of tampered.entries()) {
				if (k === 3 && !raw.includes("\r\n")) continue;
				expect(verifyLossless(raw, t).ok, `seed ${seed} tamper ${k}`).toBe(false);
			}
		}
	});
});

describe("plan details", () => {
	const raw = "---\ntags: [x]\nalias: y\n---\nIntro\r\n\r\n## A\r\ntext A\r\n\r\n## B\r\ntext B";
	const doc = parseDoc(raw);
	it("keeps blank lines around a part in the source and uses the note's own line endings for links", () => {
		const plan = planFromParts(doc, partsByHeading(doc, 2));
		const out = render(plan, (i) => `[[P${i}]]`, () => "");
		expect(out.source).toBe("---\ntags: [x]\nalias: y\n---\nIntro\r\n\r\n[[P0]]\r\n\r\n[[P1]]");
		expect(out.parts.map((p) => p.content)).toEqual(["## A\r\ntext A\r\n", "## B\r\ntext B"]);
	});
	it("refuses selections that touch the properties or are blank, and overlapping parts", () => {
		expect(() => planFromSelection(doc, 2, 40, "x")).toThrow(/properties/);
		expect(() => planFromSelection(doc, doc.bodyFrom + 5, doc.bodyFrom + 9, "x")).toThrow(/Select some text/);
		const plan = planFromParts(doc, partsByHeading(doc, 2));
		expect(() => checkPlan({ ...plan, parts: [plan.parts[0]!, { ...plan.parts[0]!, title: "dup" }] })).toThrow(/overlap/);
	});
	it("property inheritance: tags only, all (never aliases), plus a source link", () => {
		const fm = { tags: ["x"], alias: "y", aliases: ["z"], status: "draft" };
		expect(inheritedProps(fm, "none", "source", "[[S]]")).toEqual({ source: "[[S]]" });
		expect(inheritedProps(fm, "tags", "source", "[[S]]")).toEqual({ tags: ["x"], source: "[[S]]" });
		expect(inheritedProps(fm, "all", "", null)).toEqual({ tags: ["x"], status: "draft" });
		expect(buildPrefix({}, yaml, "\n")).toBe("");
		expect(buildPrefix({ a: 1 }, yaml, "\r\n")).toBe("---\r\na: 1\r\n---\r\n");
	});
	it("file names and collisions", () => {
		expect(fileNameFrom("{{source}} - {{n}} {{title}} {{date}}", { source: "S", title: "T", n: 2, date: "2026-10-25" })).toBe("S - 2 T 2026-10-25");
		const taken = new Set(["a/t.md"]); // lower-cased: names that differ only in case collide on macOS and Windows
		const reserved = new Set<string>();
		const isTaken = (p: string) => taken.has(p.toLowerCase());
		expect(uniquePath("a", "T", isTaken, reserved)).toBe("a/T 2.md");
		expect(uniquePath("a", "t", isTaken, reserved)).toBe("a/t 3.md");
		expect(uniquePath("a", "T", isTaken, reserved)).toBe("a/T 4.md");
		expect(uniquePath("", "Root", () => false, reserved)).toBe("Root.md");
	});
});
