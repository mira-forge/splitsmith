/**
 * Property suite for own-parse link rewrites (Gate 3 decisions 2-3, item A), same seed and generators as
 * tests/property.test.ts. Adversarial notes get links to their own headings and blocks, in every form, scattered
 * on their own lines; then a heading split with link repair on, into the same folder or another one.
 * Table rows with escaped aliases ([[Big#H\\|al]]) are mixed in (round 3).
 * Checks: the split never fails for a valid plan, every link the read-back flags is real, Undo restores the
 * vault byte for byte, and every "\\|" survives the rewrite.
 */
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { TFile } from "./obsidian-mock";
import { applySplit, undoSplit } from "../src/core/apply";
import { headingLevel, headingText, parseDoc, partsByHeading } from "../src/core/sections";
import { planFromParts } from "../src/core/plan";
import { anchorsIn, findLinks, hasAnchor } from "../src/core/textlinks";
import { NOTE, PARAMS, RUNS, SEED } from "./arbitraries";
import { OPTS, makeApp } from "./mock-app";

vi.stubGlobal("window", { setInterval: () => 1, open: () => null });

const SRC = "Notes/Big.md";
const SAFE = /^[\w ☕.-]+$/u;

describe(`own-parse link rewrites (fast-check seed ${SEED}, ${RUNS} runs)`, () => {
	const seen = { ok: 0, flagged: 0 };
	it("heading split with links to its own headings and blocks, any folder: never fails, flags only real breaks, undo is byte-exact", async () => {
		await fc.assert(
			fc.asyncProperty(
				NOTE,
				fc.integer({ min: 1, max: 6 }),
				fc.constantFrom("", "Out", "Out/Deep", "Notes"),
				fc.array(fc.tuple(fc.nat(), fc.nat(), fc.nat()), { maxLength: 8 }),
				async (raw0, level, folder, picks) => {
					const doc0 = parseDoc(raw0);
					const heads = doc0.lines.filter((l) => !l.inCode && headingLevel(l)).map((l) => headingText(l)).filter((t) => SAFE.test(t));
					const forms = (t: string) => [`[[#${t}]]`, `[[Big#${t}]]`, `[[Big#${t}|al]]`, `![[Big#${t}]]`, `[x](#${encodeURI(t)})`, `[y](Big.md#${encodeURI(t)})`, "![[Big#^blk]]", "[i](../img.png)", "[o](other.md)", "[[Big]]", `| c | [[#${t}\\|al]] |`, `| c | [[Big#${t}\\|al]] | ![[Big#^blk\\|b]] |`];
					const lines = raw0.slice(doc0.bodyFrom).split("\n");
					for (const [a, b, c] of picks) {
						const pool = forms(heads.length ? heads[a % heads.length]! : "Nope");
						lines.splice(c % (lines.length + 1), 0, pool[b % pool.length]!);
					}
					const raw = raw0.slice(0, doc0.bodyFrom) + lines.join("\n");
					const doc = parseDoc(raw);
					const plan = planFromParts(doc, partsByHeading(doc, level));
					if (!plan.parts.length) return;
					const { app, vault } = makeApp({ [SRC]: raw, "img.png": "P", "Notes/other.md": "o", "Out/Deep/other.md": "x" }, SRC);
					if (folder) vault.folders.add(folder);
					const before = new Map(vault.files);
					const r = await applySplit(app as never, new TFile(SRC), plan, { ...OPTS, folder, inherit: "none", sourceProperty: "" });
					expect(r.warning).toBeUndefined();
					// Every flagged link really is broken now.
					for (const u of r.unverified) {
						const [path, ...rest] = u.split(": ");
						const original = rest.join(": ");
						const l = findLinks(vault.files.get(path!)!).find((x) => x.original === original)!;
						expect(l, u).toBeDefined();
						const t = l.path === "" ? path! : app.metadataCache.getFirstLinkpathDest(l.path, path!)?.path;
						if (t) expect(hasAnchor(anchorsIn(vault.files.get(t)!), l.sub), u).toBe(false);
					}
					// And every link into the source or a new note that pointed at a real heading or block either resolves now,
					// or is flagged: nothing broken passes silently.
					const orig = anchorsIn(raw);
					const flagged = new Set(r.unverified);
					for (const p of [SRC, ...r.created]) {
						for (const l of findLinks(vault.files.get(p)!)) {
							if (!l.sub || !hasAnchor(orig, l.sub)) continue;
							const t = l.path === "" ? p : app.metadataCache.getFirstLinkpathDest(l.path, p)?.path;
							if (!t || (t !== SRC && !r.created.includes(t))) continue;
							if (!hasAnchor(anchorsIn(vault.files.get(t)!), l.sub)) expect(flagged.has(`${p}: ${l.original}`), `${p}: ${l.original}`).toBe(true);
							else seen.ok++;
						}
					}
					// Table-escaped aliases keep their "\\|" (Gate 3 round 3): same count across the source and new notes.
					const esc = (t: string) => t.split("\\|").length - 1;
					expect([SRC, ...r.created].reduce((n, p) => n + esc(vault.files.get(p)!), 0)).toBe(esc(raw));
					seen.flagged += r.unverified.length;
					await undoSplit(app as never, r.journal);
					expect(vault.files).toEqual(before);
				},
			),
			PARAMS,
		);
		// The generator does produce links that resolve after a split.
		expect(seen.ok).toBeGreaterThan(0);
		console.log(`own-links property: ${seen.ok} links resolved after the split, ${seen.flagged} flagged`);
	}, 600_000);
});
