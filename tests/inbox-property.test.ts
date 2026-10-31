/**
 * No-text-loss properties for Inbox batches (Gate 2 item 4), same fast-check harness and seed as
 * tests/property.test.ts (seed 20261030; FC_SEED / FC_RUNS override).
 *
 * For a batch of 1-4 random adversarial notes, each split at a random heading level, with an optional
 * fault injected at a random point (failed create, failed source write, corrupted read-back, or the user
 * editing a note mid-run):
 *   - success: every new note is exactly a verbatim slice of its original note, putting each note's body
 *     back in place of its link gives every original note exactly, and undoBatch restores the whole vault;
 *   - failure: the vault is exactly as before (all or nothing), or, if rollback was refused because the
 *     user edited a note, the user's edit is kept and every journal still in place can be undone later.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { TFile } from "./obsidian-mock";
import { applyBatch, BatchError, undoBatch } from "../src/core/inbox";
import { parseDoc, partsByHeading } from "../src/core/sections";
import { planFromParts } from "../src/core/plan";
import { OPTS, makeApp } from "./mock-app";
import { NOTE, PARAMS, RUNS, SEED } from "./arbitraries";

type Fault = { kind: "none" } | { kind: "create"; at: number } | { kind: "process"; note: number } | { kind: "readback"; note: number } | { kind: "edit"; note: number };
const FAULT: fc.Arbitrary<Fault> = fc.oneof(
	fc.constant<Fault>({ kind: "none" }),
	fc.nat(12).map<Fault>((at) => ({ kind: "create", at })),
	fc.nat(3).map<Fault>((note) => ({ kind: "process", note })),
	fc.nat(3).map<Fault>((note) => ({ kind: "readback", note })),
	fc.nat(3).map<Fault>((note) => ({ kind: "edit", note })),
);

let nonce = 0;
const seen = { ok: 0, rolledBack: 0, refused: 0 };

describe(`inbox batch no-text-loss properties (fast-check seed ${SEED}, ${RUNS} runs)`, () => {
	it("uses the shared fixed seed and run count", () => expect(PARAMS).toMatchObject({ seed: SEED, numRuns: RUNS }));

	it("a batch is all or nothing, every applied note is lossless, and undo restores the vault exactly", async () => {
		await fc.assert(
			fc.asyncProperty(fc.array(fc.tuple(NOTE, fc.integer({ min: 1, max: 6 })), { minLength: 1, maxLength: 4 }), FAULT, async (notes, fault) => {
				const files: Record<string, string> = { "Keep.md": "keep me" };
				notes.forEach(([raw], i) => (files[`Inbox/N${i}.md`] = raw));
				const { app, vault } = makeApp(files, "none");
				const tag = `\uE000${++nonce}\uE001`;
				app.fileManager.generateMarkdownLink = ((f: TFile) => `[[${tag}${f.path}${tag}]]`) as never;
				const items = notes
					.map(([raw, level], i) => {
						const doc = parseDoc(raw);
						return { file: new TFile(`Inbox/N${i}.md`), plan: planFromParts(doc, partsByHeading(doc, level)), options: { ...OPTS, inherit: "none" as const, sourceProperty: "", folder: "Out", repairLinks: false } };
					})
					.filter((it) => it.plan.parts.length > 0);
				if (!items.length) return;
				const target = fault.kind === "none" || fault.kind === "create" ? null : items[fault.note % items.length]!.file.path;
				if (fault.kind === "create") vault.failCreateAt = fault.at;
				if (fault.kind === "process") vault.failProcess = { path: target!, when: "before" };
				if (fault.kind === "readback") {
					const ti = items.findIndex((x) => x.file.path === target);
					let k = 0;
					const before = items.slice(0, ti).reduce((n, x) => n + x.plan.parts.length, 0);
					vault.createTransform = (_p, d) => (k++ === before ? `${d}\u0000corrupt` : d);
				}
				let edited: string | null = null;
				if (fault.kind === "edit") {
					// The user edits the first note's first new note while a later note is being written.
					vault.beforeProcess = (p) => {
						if (p === target && p !== items[0]!.file.path && !edited) {
							edited = [...vault.files.keys()].find((k) => k.startsWith("Out/"))!;
							vault.files.set(edited, "user edit");
						}
					};
					vault.failProcess = { path: target!, when: "before" };
				}
				const before = new Map(vault.files);
				let r: Awaited<ReturnType<typeof applyBatch>> | null = null;
				let err: unknown = null;
				try {
					r = await applyBatch(app as never, items);
				} catch (e) {
					err = e;
				}
				vault.failCreateAt = -1;
				vault.failProcess = null;
				vault.createTransform = null;
				vault.beforeProcess = null;

				if (err) {
					expect(err).toBeInstanceOf(BatchError);
					const rem = (err as BatchError).remaining;
					if (!edited) {
						expect(rem).toEqual([]);
						expect(vault.files).toEqual(before);
						if (r === null && items.length > 1) seen.rolledBack++;
						return;
					}
					// Rollback stopped at the edited note: the edit is kept, nothing else is lost.
					expect(vault.files.get(edited)).toBe("user edit");
					expect(rem.length).toBeGreaterThan(0);
					seen.refused++;
					// Every split still in place is intact, so "Undo last split" can finish once the edit is dealt with.
					for (const j of rem) expect(vault.files.get(j.sourcePath)).toBe(j.after);
					expect(rem[0]!.created.some((c) => c.path === edited)).toBe(true);
					return;
				}

				expect(r!.journals).toHaveLength(items.length);
				items.forEach((it, n) => {
					const raw = files[it.file.path]!;
					const after = vault.files.get(it.file.path)!;
					expect(r!.journals[n]!.before).toBe(raw);
					let out = "";
					let cur = 0;
					r!.results[n]!.result.created.forEach((path, i) => {
						const body = raw.slice(it.plan.parts[i]!.from, it.plan.parts[i]!.to);
						expect(vault.files.get(path)).toBe(body);
						const link = `[[${tag}${path}${tag}]]`;
						const at = after.indexOf(link, cur);
						expect(at).toBeGreaterThanOrEqual(cur);
						out += after.slice(cur, at) + body;
						cur = at + link.length + (/\r?\n$/.exec(body)?.[0].length ?? 0);
					});
					expect(out + after.slice(cur)).toBe(raw);
				});
				seen.ok++;
				const u = await undoBatch(app as never, r!.journals);
				expect(u.remaining).toEqual([]);
				const restored = new Map([...vault.files].filter(([k]) => k !== "Out"));
				expect(restored).toEqual(new Map(Object.entries(files)));
			}),
			PARAMS,
		);
		// The generators must actually reach every outcome (guards against a fault model that never fires).
		if (RUNS >= 500) {
			expect(seen.ok).toBeGreaterThan(0);
			expect(seen.rolledBack).toBeGreaterThan(0);
			expect(seen.refused).toBeGreaterThan(0);
		}
	}, 900_000);
});
