/**
 * No-text-loss property suite (SPLITSMITH_STATE.md section 4 item 2), with fast-check.
 *
 * For every split mode (heading levels 1-6, delimiter, cursor, selection, AI-style plan with preview
 * merges/drops) over adversarial Markdown:
 *   - pure: the plan's ranges reassemble the note, and verifyLossless accepts the rendered output for
 *     every link style, with and without a properties prefix;
 *   - applied (mocked vault): every new note is exactly its properties prefix + a verbatim slice of the
 *     original; putting each note's body back in place of its link in the rewritten source gives the
 *     original note, byte for byte; Undo restores every file in the vault exactly and trashes the new notes.
 *
 * Seed and runs are fixed (FC_SEED / FC_RUNS env vars override them, e.g. for a nightly random seed).
 * When a run fails, fast-check prints the shrunk counterexample plus seed and path; pin it in
 * tests/property-regressions.test.ts.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { stringifyYaml, TFile } from "./obsidian-mock";
import { applySplit, undoSplit, type LinkStyle } from "../src/core/apply";
import { lineAtOffset, parseDoc, partAtLine, partsByDelimiter, partsByHeading, type Doc, type Part } from "../src/core/sections";
import { validatePlan } from "../src/core/segment";
import { buildPrefix, dropPart, inheritedProps, mergeWithNext, movesWholeNote, planFromParts, planFromSelection, PlanError, render, verifyLossless, type SplitPlan } from "../src/core/plan";
import { OPTS, makeApp } from "./mock-app";

import { NOTE, PARAMS, RUNS, SEED } from "./arbitraries";

// ---------- checks ----------

function reassembleRanges(plan: SplitPlan): string {
	let out = "";
	let cur = 0;
	for (const p of plan.parts) {
		out += plan.raw.slice(cur, p.from) + plan.raw.slice(p.from, p.to);
		cur = p.to;
	}
	return out + plan.raw.slice(cur);
}

/** Pure invariants for one plan, all link styles, with and without a properties prefix. */
function checkPure(raw: string, plan: SplitPlan): void {
	expect(plan.raw).toBe(raw);
	expect(reassembleRanges(plan)).toBe(raw);
	for (const p of plan.parts) expect(p.from).toBeGreaterThanOrEqual(plan.bodyFrom);
	if (!plan.parts.length) return;
	const pre = buildPrefix({ source: "[[S]]", tags: ["a"] }, stringifyYaml, plan.eol);
	for (const style of [0, 1, 2]) {
		for (const prefix of ["", pre]) {
			const r = render(plan, (i) => (style === 0 ? "" : style === 1 ? `![[P${i}]]` : `[[P${i}]]`), () => prefix);
			expect(verifyLossless(raw, r)).toEqual({ ok: true });
		}
	}
}

let nonce = 0;
/**
 * Apply through the real applySplit on a mocked vault, then: new notes = prefix + exact slices,
 * source with links replaced by bodies = original, Undo restores every file and trashes the new notes.
 */
async function checkApplied(raw: string, plan: SplitPlan, linkStyle: LinkStyle): Promise<void> {
	if (!plan.parts.length) return;
	const src = "Notes/Big.md";
	const { app, vault } = makeApp({ [src]: raw, "Notes/Existing.md": "keep me" }, src);
	// Links that cannot collide with note text, so they can be located exactly in the rewritten source.
	const tag = `\uE000${++nonce}\uE001`;
	app.fileManager.generateMarkdownLink = ((f: TFile) => `[[${tag}${f.path}${tag}]]`) as never;
	const before = new Map(vault.files);
	const opts = { ...OPTS, linkStyle, repairLinks: false };
	if (movesWholeNote(plan)) {
		// Gate 3: moving the whole note into a new one is never a split. Refused, 0 bytes changed.
		await expect(applySplit(app as never, new TFile(src), plan, opts)).rejects.toThrow(/Nothing to split/);
		expect(vault.files).toEqual(before);
		return;
	}
	const res = await applySplit(app as never, new TFile(src), plan, opts);
	expect(res.warning).toBeUndefined();
	expect(res.created).toHaveLength(plan.parts.length);
	const after = vault.files.get(src)!;
	expect(after).toBe(res.journal.after);

	const fm = app.metadataCache.getFileCache(new TFile(src))?.frontmatter;
	let out = "";
	let cur = 0;
	res.created.forEach((path, i) => {
		const content = vault.files.get(path)!;
		const prefix = buildPrefix(inheritedProps(fm, opts.inherit, opts.sourceProperty, `[[${tag}${src}${tag}]]`), stringifyYaml, plan.eol);
		const body = raw.slice(plan.parts[i]!.from, plan.parts[i]!.to);
		expect(content).toBe(prefix + body);
		if (linkStyle === "none") return;
		const link = (linkStyle === "embed" ? "!" : "") + `[[${tag}${path}${tag}]]`;
		const at = after.indexOf(link, cur);
		expect(at).toBeGreaterThanOrEqual(cur);
		out += after.slice(cur, at) + body;
		cur = at + link.length + (/\r?\n$/.exec(body)?.[0].length ?? 0);
	});
	if (linkStyle !== "none") expect(out + after.slice(cur)).toBe(raw);
	else {
		// No links: the source is the original minus the moved ranges, nothing else.
		let rest = "";
		let c = 0;
		for (const p of plan.parts) {
			rest += raw.slice(c, p.from);
			c = p.to;
		}
		expect(after).toBe(rest + raw.slice(c));
	}

	await undoSplit(app as never, res.journal);
	expect(vault.files).toEqual(before);
	expect([...vault.trashed].sort()).toEqual([...res.created].sort());
}

const STYLE = fc.constantFrom<LinkStyle>("link", "embed", "none");

/** An AI-style partition of the body lines into contiguous ranges with model-like titles. */
function aiParts(doc: Doc, cuts: number[], titles: string[]): Part[] {
	const n = doc.lines.length;
	const points = [...new Set(cuts.map((c) => (n > 1 ? 1 + (c % (n - 1)) : 0)).filter((c) => c > 0))].sort((a, b) => a - b);
	const starts = [0, ...points];
	return starts.map((s, i) => ({ title: titles[i % titles.length] || "Part", start: s, end: (starts[i + 1] ?? n) - 1 }));
}
const TITLE = fc.oneof(fc.string({ minLength: 1, maxLength: 30 }), fc.constantFrom("CON", "nul", "$&", "x$'y", "Title.", "🧪".repeat(80), "a/b:c?", ".hidden", "#tag ^blk"));

// ---------- the suite ----------

describe(`no-text-loss properties (fast-check seed ${SEED}, ${RUNS} runs per mode)`, () => {
	it("heading split, all levels 1-6 (pure) and one random level applied + undone", async () => {
		await fc.assert(
			fc.asyncProperty(NOTE, fc.integer({ min: 1, max: 6 }), STYLE, async (raw, level, style) => {
				const doc = parseDoc(raw);
				for (let l = 1; l <= 6; l++) checkPure(raw, planFromParts(doc, partsByHeading(doc, l)));
				await checkApplied(raw, planFromParts(doc, partsByHeading(doc, level)), style);
			}),
			PARAMS,
		);
	}, 600_000);

	it("delimiter split (---, ***, custom), applied + undone", async () => {
		await fc.assert(
			fc.asyncProperty(NOTE, fc.constantFrom("---", "***", "___", "+++", "%%", "$$", "```"), STYLE, async (raw, d, style) => {
				const doc = parseDoc(raw);
				const plan = planFromParts(doc, partsByDelimiter(doc, d));
				checkPure(raw, plan);
				await checkApplied(raw, plan, style);
			}),
			PARAMS,
		);
	}, 600_000);

	it("split at cursor (any body line), applied + undone", async () => {
		await fc.assert(
			fc.asyncProperty(NOTE, fc.nat(), STYLE, async (raw, a, style) => {
				const doc = parseDoc(raw);
				if (!doc.lines.length) return;
				const plan = planFromParts(doc, partAtLine(doc, lineAtOffset(doc, doc.bodyFrom + (a % Math.max(1, raw.length - doc.bodyFrom)))));
				checkPure(raw, plan);
				await checkApplied(raw, plan, style);
			}),
			PARAMS,
		);
	}, 600_000);

	it("extract selection (any offsets, mid-line, mid-CRLF, mid-surrogate), applied + undone", async () => {
		await fc.assert(
			fc.asyncProperty(NOTE, fc.nat(), fc.nat(), TITLE, STYLE, async (raw, a, b, title, style) => {
				const doc = parseDoc(raw);
				const span = raw.length - doc.bodyFrom;
				if (span <= 0) return;
				const from = doc.bodyFrom + (a % span);
				const to = from + (b % (raw.length - from + 1));
				let plan: SplitPlan;
				try {
					plan = planFromSelection(doc, from, to, title);
				} catch (e) {
					// Only allowed refusals: an empty or whitespace-only selection, or one that is the whole note.
					expect(e).toBeInstanceOf(PlanError);
					if (/whole note/.test(String(e))) expect((raw.slice(doc.bodyFrom, from) + raw.slice(to)).trim()).toBe("");
					else expect(raw.slice(from, to).trim()).toBe("");
					return;
				}
				checkPure(raw, plan);
				await checkApplied(raw, plan, style);
			}),
			PARAMS,
		);
	}, 600_000);

	it("AI-style plan (random partition + titles), validated, then preview merges/drops, applied + undone", async () => {
		await fc.assert(
			fc.asyncProperty(NOTE, fc.array(fc.nat(), { maxLength: 12 }), fc.array(TITLE, { minLength: 1, maxLength: 12 }), fc.array(fc.tuple(fc.boolean(), fc.nat()), { maxLength: 4 }), STYLE, async (raw, cuts, titles, edits, style) => {
				const doc = parseDoc(raw);
				if (!doc.lines.length) return;
				const parts = aiParts(doc, cuts, titles);
				const cutsBlock = parts.some((p) => p.start > 0 && doc.lines[p.start]!.block >= 0 && doc.lines[p.start]!.block === doc.lines[p.start - 1]!.block);
				let valid: Part[];
				try {
					valid = validatePlan(doc, parts, 40);
				} catch (e) {
					// A well-formed partition may only be refused for a cut through a code/comment/math block,
					// or a blank title from the model.
					const noTitle = parts.some((p) => !p.title.trim());
					expect(cutsBlock || noTitle).toBe(true);
					expect(String(e)).toMatch(/cuts through a code block|had no title/);
					return;
				}
				expect(cutsBlock).toBe(false);
				let plan = planFromParts(doc, valid);
				for (const [merge, k] of edits) {
					if (!plan.parts.length) break;
					plan = merge && plan.parts.length > 1 ? mergeWithNext(plan, k % (plan.parts.length - 1)) : dropPart(plan, k % plan.parts.length);
				}
				checkPure(raw, plan);
				await checkApplied(raw, plan, style);
			}),
			PARAMS,
		);
	}, 600_000);

	it("fault injection at every step: the vault ends fully old, or fully new with a journal that undoes it", async () => {
		const FAULT = fc.oneof(
			fc.record({ kind: fc.constant("create" as const), k: fc.nat(8) }),
			fc.record({ kind: fc.constant("corrupt" as const), k: fc.nat(8) }),
			fc.record({ kind: fc.constant("source-before" as const) }),
			fc.record({ kind: fc.constant("source-after" as const) }),
			fc.record({ kind: fc.constant("source-edited" as const) }),
			fc.record({ kind: fc.constant("links" as const) }),
			fc.record({ kind: fc.constant("links-after" as const) }),
			fc.record({ kind: fc.constant("linkgen" as const), k: fc.nat(10) }),
		);
		let warned = 0;
		await fc.assert(
			fc.asyncProperty(NOTE, fc.integer({ min: 1, max: 6 }), FAULT, async (raw, level, fault) => {
				const doc = parseDoc(raw);
				const plan = planFromParts(doc, partsByHeading(doc, level));
				if (!plan.parts.length) return;
				const src = "Notes/Big.md";
				const first = plan.parts[0]!.title;
				const other = `see [[Big#${first}]] and [[Big]]`;
				const env = makeApp({ [src]: raw, "Other.md": other, "Other2.md": other }, src);
				const { app, vault } = env;
				env.linkAt("Other.md", `[[Big#${first}]]`, `Big#${first}`);
				env.linkAt("Other2.md", `[[Big#${first}]]`, `Big#${first}`);
				const tag = `\uE000${++nonce}\uE001`;
				let gen = 0;
				app.fileManager.generateMarkdownLink = ((f: TFile) => {
					if (fault.kind === "linkgen" && gen++ === fault.k) throw new Error("injected");
					return `[[${tag}${f.path}${tag}]]`;
				}) as never;
				const before = new Map(vault.files);
				if (fault.kind === "create") vault.failCreateAt = fault.k;
				if (fault.kind === "corrupt") {
					let n = 0;
					vault.createTransform = (_p, d) => (n++ === fault.k ? d + " " : d);
				}
				if (fault.kind === "source-before" || fault.kind === "source-after") vault.failProcess = { path: src, when: fault.kind === "source-before" ? "before" : "after", times: 1 };
				if (fault.kind === "source-edited") vault.beforeProcess = (p) => p === src && vault.files.set(src, raw + "typed");
				if (fault.kind === "links" || fault.kind === "links-after") vault.failProcess = { path: "Other2.md", when: fault.kind === "links" ? "before" : "after", times: 1 };
				let res: Awaited<ReturnType<typeof applySplit>> | null = null;
				try {
					res = await applySplit(app as never, new TFile(src), plan, { ...OPTS, repairLinks: true });
				} catch (e) {
					// Fully old: every file as before (except a concurrent edit we injected), no new notes left.
					expect(e).toBeInstanceOf(PlanError);
					expect(String(e)).toMatch(/nothing was changed/i);
					const expected = new Map(before);
					if (fault.kind === "source-edited") expected.set(src, raw + "typed");
					expect(vault.files).toEqual(expected);
					return;
				}
				// Fully new + journal: source rewritten, every new note present, and undo restores everything.
				expect(vault.files.get(src)).toBe(res.journal.after);
				for (const c of res.created) expect(vault.files.has(c)).toBe(true);
				// A warning only ever says the split is done; without one, the faulty link file was never written.
				if (res.warning) expect(res.warning).toMatch(/^Split done, but .*Undo is available\.$/);
				else if (fault.kind === "links" || fault.kind === "links-after") expect(vault.files.get("Other2.md")).toBe(other);
				if (fault.kind === "links" || fault.kind === "links-after") warned += res.warning ? 1 : 0;
				vault.failProcess = null;
				vault.beforeProcess = null;
				await undoSplit(app as never, res.journal);
				expect(vault.files).toEqual(before);
			}),
			{ ...PARAMS, numRuns: Math.max(1, Math.floor(RUNS / 2)) },
		);
		if (RUNS >= 1000) expect(warned).toBeGreaterThan(10); // the link-repair failure path is really exercised
	}, 600_000);

	it("very long note (20k CRLF lines, 400 parts) round-trips, applies and undoes", async () => {
		const raw = "\uFEFF---\r\ntags: [a]\r\n---\r\n" + Array.from({ length: 20000 }, (_, i) => (i % 50 === 0 ? `## S${i}` : `line ${i} 🧪 [^${i}] ^b${i}`)).join("\r\n");
		const doc = parseDoc(raw);
		const plan = planFromParts(doc, partsByHeading(doc, 2));
		expect(plan.parts).toHaveLength(400);
		checkPure(raw, plan);
		await checkApplied(raw, plan, "link");
	}, 120_000);
});
