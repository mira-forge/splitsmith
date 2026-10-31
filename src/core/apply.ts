/**
 * Writes a split as one transaction, and undoes it. Uses only Obsidian's Vault and FileManager APIs.
 *   1. Render every file's exact text and verify the lossless check (nothing written yet).
 *   2. Create the new notes with vault.create.
 *   3. Re-render with real links from fileManager.generateMarkdownLink and verify again.
 *   4. Rewrite the source with vault.process, only if it still matches what was read.
 *   5. Optionally repair inbound #heading / #^block links in other notes.
 *   6. Return an undo journal.
 * If any step before the source rewrite fails, the new notes are moved to the trash and the source is
 * untouched. After it, nothing throws: failures are reported in SplitResult.warning and the journal
 * still records every change made, so Undo works.
 */
import { normalizePath, stringifyYaml, TFile, type App } from "obsidian";
import { headingLevel, headingText, parseDoc, safeTitle, type Doc } from "./sections";
import {
	buildPrefix,
	checkPlan,
	fileNameFrom,
	fingerprint,
	inheritedProps,
	movesWholeNote,
	PlanError,
	render,
	uniquePath,
	verifyLossless,
	type InheritMode,
	type SplitPlan,
} from "./plan";
import { anchorsFor, applyEdits, blockKey, normHeading, planLinkEdits, revertEdits, type InboundRef } from "./links";
import { anchorsIn, BLOCK, encodeMdPath, escapeAliasPipe, findLinks, hasAnchor, hasEscapedPipe, relativePath, type TextLink } from "./textlinks";

export type LinkStyle = "link" | "embed" | "none";

export interface SplitOptions {
	linkStyle: LinkStyle;
	/** Folder for new notes; "" = same folder as the source note. */
	folder: string;
	fileNameTemplate: string;
	inherit: InheritMode;
	/** Property that links each new note back to its source; "" = none. */
	sourceProperty: string;
	repairLinks: boolean;
}

export interface Journal {
	at: number;
	sourcePath: string;
	before: string;
	after: string;
	created: { path: string; fp: string }[];
	linkEdits: { path: string; applied: { start: number; oldText: string; newText: string }[] }[];
	/**
	 * Links rewritten from our own parse, inside the source and the new notes, before the source was written
	 * (Gate 3 decisions 2-3, item A). For the record only: Undo restores `before` and trashes the new notes,
	 * which already reverts them byte for byte.
	 */
	ownEdits?: { path: string; applied: { start: number; oldText: string; newText: string }[] }[];
}

export interface SplitResult {
	created: string[];
	linksUpdated: number;
	linksSkipped: number;
	/** Links rewritten in the source note and in the new notes (same-note links, links to moved headings, relative paths). */
	linksRewritten: number;
	/** Links that the read-back after the split could not confirm still resolve, as "path: link". */
	unverified: string[];
	journal: Journal;
	/** Set when the split is done (source rewritten, journal valid) but a later step failed. */
	warning?: string;
}

function today(): string {
	const d = new Date();
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Notice text for links the read-back could not confirm. Empty when every link checked out. */
export function unverifiedLine(list: string[], max = 5): string {
	if (!list.length) return "";
	const shown = list.slice(0, max).join("; ") + (list.length > max ? `; and ${list.length - max} more` : "");
	return `Could not confirm that ${list.length === 1 ? "1 link still resolves" : `${list.length} links still resolve`}, check by hand: ${shown}.`;
}

/** Target paths for each part (pure apart from existence checks). */
export function targetPaths(app: App, source: TFile, plan: SplitPlan, o: SplitOptions): string[] {
	const folder = o.folder.trim() ? normalizePath(o.folder.trim()) : (source.parent?.path ?? "");
	const reserved = new Set<string>([source.path.toLowerCase()]);
	// Names that differ only in case collide on macOS and Windows, so compare case-insensitively.
	const existing = new Set(app.vault.getAllLoadedFiles().map((f) => f.path.toLowerCase()));
	// A new note must not share its name with a note in another folder: links by name such as [[Settings]] would then
	// resolve to the new note instead of the one they meant (found by the Gate 3 corpus re-check).
	const names = new Set(app.vault.getMarkdownFiles().filter((f) => f.path !== source.path).map((f) => f.basename.toLowerCase()));
	const nameOf = (x: string) => x.slice(x.lastIndexOf("/") + 1).replace(/\.md$/i, "").toLowerCase();
	const date = today();
	return plan.parts.map((p, i) => {
		const base = safeTitle(fileNameFrom(o.fileNameTemplate, { source: source.basename, title: safeTitle(p.title), n: i + 1, date }));
		return uniquePath(folder === "/" ? "" : folder, base, (x) => existing.has(x.toLowerCase()) || names.has(nameOf(x)), reserved);
	});
}

async function rollback(app: App, files: TFile[]): Promise<void> {
	for (const f of files) await app.fileManager.trashFile(f).catch(() => undefined);
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Contract: applySplit either throws a PlanError and nothing was changed (all new notes trashed, source
 * untouched), or it returns a result with a journal: once the source has been rewritten it never throws.
 * Problems after that point (link repair) are reported in `warning`, with every edit already made
 * recorded in the journal so Undo can revert it (gap 1).
 */
export async function applySplit(app: App, source: TFile, plan: SplitPlan, o: SplitOptions): Promise<SplitResult> {
	checkPlan(plan);
	if (!plan.parts.length) throw new PlanError("Nothing to split.");
	if (movesWholeNote(plan)) throw new PlanError("Nothing to split: that would move the whole note into a new one. Nothing was changed.");
	const created: TFile[] = [];
	const ownApplied: NonNullable<Journal["ownEdits"]> = [];
	let finalContents: string[] = [];
	let finalOut = "";
	try {
		const paths = targetPaths(app, source, plan, o);
		const fm = app.metadataCache.getFileCache(source)?.frontmatter;
		const prefixes = paths.map((p) => {
			const back = o.sourceProperty.trim() ? app.fileManager.generateMarkdownLink(source, p) : null;
			return buildPrefix(inheritedProps(fm, o.inherit, o.sourceProperty.trim(), back), (x) => stringifyYaml(x), plan.eol);
		});
		const prefix = (i: number) => prefixes[i]!;

		// 1. Dry run on the exact bytes, with placeholder links.
		const dry = render(plan, (i) => (o.linkStyle === "none" ? "" : `[[${paths[i]}]]`), prefix);
		const v1 = verifyLossless(plan.raw, dry);
		if (!v1.ok) throw new PlanError(`Lossless check failed, nothing was written: ${v1.reason}`);

		// 2. Create the new notes, then read each one back and compare with what was meant to be written (gap 7).
		const folder = paths[0]!.includes("/") ? paths[0]!.slice(0, paths[0]!.lastIndexOf("/")) : "";
		if (folder && !app.vault.getFolderByPath(folder)) await app.vault.createFolder(folder);
		try {
			for (let i = 0; i < paths.length; i++) created.push(await app.vault.create(paths[i]!, dry.parts[i]!.content));
		} catch (e) {
			throw new PlanError(`Could not create the new notes, nothing was changed: ${msg(e)}`);
		}
		for (let i = 0; i < created.length; i++) {
			if ((await app.vault.read(created[i]!)) !== dry.parts[i]!.content) {
				throw new PlanError(`A new note did not read back exactly as written (${created[i]!.path}), nothing was changed.`);
			}
		}

		// 3. Real links, verified again on the final strings.
		const linkText = (i: number) => {
			if (o.linkStyle === "none") return "";
			const l = app.fileManager.generateMarkdownLink(created[i]!, source.path);
			return o.linkStyle === "embed" ? `!${l}` : l;
		};
		const final = render(plan, linkText, prefix);
		const v2 = verifyLossless(plan.raw, final);
		if (!v2.ok || final.parts.some((p, i) => p.content !== dry.parts[i]!.content)) {
			throw new PlanError(`Lossless check failed, nothing was changed: ${v2.ok ? "new note text changed" : v2.reason}`);
		}

		// 3b. Links in the moved text and in the rest of the source, from our own parse (no metadata cache timing).
		let out = final.source;
		const contents = final.parts.map((p) => p.content);
		if (o.repairLinks) {
			const idx = anchorIndex(parseDoc(plan.raw), plan);
			const plain = (text: string, edits: OwnEdit[], what: string) => {
				const r = applyEdits(text, edits);
				if (revertEdits(r.text, r.applied).text !== text) throw new PlanError(`Link rewrite in ${what} did not reverse exactly, nothing was changed.`);
				return r;
			};
			const se = ownEdits(app, source, created, idx, final.source, source.path, -1);
			if (se.length) {
				const r = plain(final.source, se, source.path);
				out = r.text;
				ownApplied.push({ path: source.path, applied: r.applied });
			}
			for (let i = 0; i < created.length; i++) {
				const pe = ownEdits(app, source, created, idx, contents[i]!, created[i]!.path, i);
				if (!pe.length) continue;
				const r = plain(contents[i]!, pe, created[i]!.path);
				const was = contents[i]!;
				await app.vault.process(created[i]!, (data) => {
					if (data !== was) throw new PlanError(`A new note changed while splitting (${created[i]!.path}), nothing was changed.`);
					return r.text;
				});
				if ((await app.vault.read(created[i]!)) !== r.text) throw new PlanError(`A new note did not read back exactly as written (${created[i]!.path}), nothing was changed.`);
				contents[i] = r.text;
				ownApplied.push({ path: created[i]!.path, applied: r.applied });
			}
		}
		finalContents = contents;

		// 4. Rewrite the source only if nobody changed it since it was read.
		try {
			await app.vault.process(source, (data) => {
				if (data !== plan.raw) throw new PlanError("The note changed while splitting. Nothing was changed; try again.");
				return out;
			});
			finalOut = out;
		} catch (e) {
			// process() may have failed after writing. Only claim "nothing was changed" if the source still holds the original.
			const now = await app.vault.read(source).catch(() => null);
			if (now === out) {
				return finish(app, source, plan, o, created, out, contents, ownApplied, `Split done, but Obsidian reported an error while saving the source note (${msg(e)}). Undo is available.`);
			}
			throw e instanceof PlanError ? e : new PlanError(`Could not update the source note, nothing was changed: ${msg(e)}`);
		}
	} catch (e) {
		await rollback(app, created);
		throw e instanceof PlanError ? e : new PlanError(`The split failed, nothing was changed: ${msg(e)}`);
	}
	return finish(app, source, plan, o, created, finalOut, finalContents, ownApplied);
}

/** Steps 5-6, after the source holds the new text. Never throws: the split is done and must stay undoable. */
async function finish(
	app: App,
	source: TFile,
	plan: SplitPlan,
	o: SplitOptions,
	created: TFile[],
	after: string,
	contents: string[],
	ownApplied: NonNullable<Journal["ownEdits"]>,
	earlierWarning?: string,
): Promise<SplitResult> {
	const journal: Journal = {
		at: Date.now(),
		sourcePath: source.path,
		before: plan.raw,
		after,
		created: created.map((f, i) => ({ path: f.path, fp: fingerprint(contents[i]!) })),
		linkEdits: [],
	};
	if (ownApplied.length) journal.ownEdits = ownApplied;
	const linksRewritten = ownApplied.reduce((n, e) => n + e.applied.length, 0);
	let unverified: string[] = [];
	let linksUpdated = 0;
	let linksSkipped = 0;
	let warning = earlierWarning;
	const inboundFiles = new Set<string>();
	// 5. Inbound link repair (best effort; the split itself is already complete and lossless).
	if (o.repairLinks) {
		const r = { updated: 0, skipped: 0 };
		try {
			await repairInbound(app, source, plan, created, journal.linkEdits, r, inboundFiles);
		} catch (e) {
			warning = `Split done, but link repair failed (${msg(e)}). Undo is available.`;
		}
		linksUpdated = r.updated;
		linksSkipped = r.skipped;
		// A moved part can link to a heading of its own note by name ([[Note#Heading]]). Once the metadata cache has
		// indexed the new note, link repair points that link at the heading's new note, so the new note changes after it
		// was created. Fingerprint the new notes as they are now, or Undo would refuse them as "edited after the split"
		// (found by the Gate 3 corpus run on the Obsidian help vault).
		const repaired = new Set(journal.linkEdits.map((e) => e.path));
		for (const [i, c] of journal.created.entries()) {
			if (!repaired.has(c.path)) continue;
			const now = await app.vault.read(created[i]!).catch(() => null);
			if (now !== null) c.fp = fingerprint(now);
		}
	}
	// 6. Read every affected note back and check each link into the source or a new note still resolves.
	if (o.repairLinks) {
		try {
			unverified = await verifyLinks(app, source, plan.raw, created, [...inboundFiles, ...journal.linkEdits.map((e) => e.path)]);
		} catch (e) {
			unverified = [`(links could not be read back: ${msg(e)})`];
		}
	}
	// 7. The journal (returned even when link repair failed; it records every link edit already made).
	return { created: created.map((f) => f.path), linksUpdated, linksSkipped, linksRewritten, unverified, journal, warning };
}

/**
 * Links in other notes to headings or blocks that moved. Uses the metadata cache for indexed notes; a note the
 * cache has not indexed yet is read and parsed here instead, so a late index does not skip it silently.
 * `exclude` holds the new notes (their links come from our own parse in step 3b). `seen` collects every note
 * found linking to the source, for the read-back.
 * Cache timing (Oct 31 RC): Obsidian re-indexes a note shortly after it is saved, so a note edited in the last
 * few seconds can have a cache entry that misses a link the user just typed. Such notes are own-parsed too.
 */
/** A note saved this recently may not be re-indexed yet; its links are read from the file itself. */
export const RECENT_EDIT_MS = 5000;

export async function inboundRefs(app: App, source: TFile, exclude: Set<string> = new Set(), seen: Set<string> = new Set()): Promise<InboundRef[]> {
	const refs: InboundRef[] = [];
	const resolved = app.metadataCache.resolvedLinks;
	const toSource = (lp: string, from: string) => app.metadataCache.getFirstLinkpathDest(lp, from)?.path === source.path;
	const paths = new Set(Object.entries(resolved).filter(([, t]) => t[source.path]).map(([from]) => from));
	const fresh = (f: TFile) => f.stat.mtime > Date.now() - RECENT_EDIT_MS;
	for (const f of app.vault.getMarkdownFiles()) if (!app.metadataCache.getFileCache(f) || fresh(f)) paths.add(f.path);
	for (const from of paths) {
		if (from === source.path || exclude.has(from)) continue;
		const f = app.vault.getFileByPath(from);
		if (!f) continue;
		const cache = fresh(f) ? null : app.metadataCache.getFileCache(f);
		if (!cache) {
			const found = findLinks(await app.vault.cachedRead(f)).filter((l) => l.path && toSource(l.path, from));
			if (found.length) seen.add(from);
			for (const l of found) {
				// Markdown links in a not-yet-indexed note are left to the read-back, which reports them.
				if (!l.sub || l.kind !== "wiki") continue;
				refs.push({ path: from, start: l.start, end: l.end, original: l.original, link: `${l.path}#${l.sub}`, displayText: l.alias, embed: l.embed });
			}
			continue;
		}
		seen.add(from);
		const collect = (list: typeof cache.links, embed: boolean) => {
			for (const l of list ?? []) {
				const linkpath = l.link.split("#")[0] ?? "";
				if (!l.link.includes("#") || !linkpath) continue;
				if (!toSource(linkpath, from)) continue;
				refs.push({ path: from, start: l.position.start.offset, end: l.position.end.offset, original: l.original, link: l.link, displayText: l.displayText, embed });
			}
		};
		collect(cache.links, false);
		collect(cache.embeds, true);
	}
	return refs;
}

type OwnEdit = { start: number; end: number; oldText: string; newText: string };
/** Where each heading and block of the original note ends up: a part index, or -1 for "stays in the source". First one wins, as in Obsidian. */
interface AnchorIndex {
	headings: Map<string, { loc: number; text: string }>;
	blocks: Map<string, number>;
}

export function anchorIndex(doc: Doc, plan: SplitPlan): AnchorIndex {
	const idx: AnchorIndex = { headings: new Map(), blocks: new Map() };
	for (const l of doc.lines) {
		if (l.inCode) continue;
		const loc = plan.parts.findIndex((p) => l.from >= p.from && l.from < p.to);
		if (headingLevel(l)) {
			const key = normHeading(headingText(l));
			if (!idx.headings.has(key)) idx.headings.set(key, { loc, text: headingText(l) });
		}
		const b = BLOCK.exec(l.text);
		if (b && !idx.blocks.has(blockKey(b[1]!))) idx.blocks.set(blockKey(b[1]!), loc);
	}
	return idx;
}

/** Where a "#sub" of the original note now lives, and the subpath to link to it with ("#Heading" or "#^id"). */
function locate(idx: AnchorIndex, sub: string): { loc: number; subpath: string } | null {
	if (sub.startsWith("^")) {
		const loc = idx.blocks.get(blockKey(sub.slice(1)));
		return loc === undefined ? null : { loc, subpath: `#${sub}` };
	}
	const h = idx.headings.get(normHeading(sub.split("#").pop() ?? ""));
	return h ? { loc: h.loc, subpath: `#${h.text}` } : null;
}

/** Block ids keep their leading ^ raw, as people write them; the rest of an anchor is encoded like a path. */
const encodeAnchor = (a: string) => (a.startsWith("^") ? `^${encodeMdPath(a.slice(1))}` : encodeMdPath(a));

const folderOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

/** The same link, pointing at `target` (plus `subpath`) from the note at `hostPath`. Markdown links stay markdown. */
function retarget(app: App, l: TextLink, hostPath: string, target: TFile, subpath: string): string {
	if (l.kind === "md" && l.url) {
		const rel = relativePath(folderOf(hostPath), target.path);
		const url = l.url.angle ? rel + subpath : encodeMdPath(rel) + (subpath ? `#${encodeAnchor(subpath.slice(1))}` : "");
		return l.original.slice(0, l.url.from) + url + l.original.slice(l.url.to);
	}
	let g = app.fileManager.generateMarkdownLink(target, hostPath, subpath, l.alias).replace(/^!/, "");
	if (l.pipeEscaped) g = escapeAliasPipe(g); // keep "\\|" so a link in a table stays in its cell
	return l.embed ? `!${g}` : g;
}

/**
 * Link rewrites for one note from our own parse of its text (Gate 3 decisions 2-3, item A).
 * host = -1: the source after the split. Its links to its own moved headings and blocks point at their new notes.
 * host = i: new note i. Links to the source's headings and blocks point wherever they now live (another new note,
 * or back at the source for [[#X]] when X stayed). Links to other files that would no longer resolve from the new
 * note's folder (relative markdown paths) are rewritten relative to that folder.
 */
export function ownEdits(app: App, source: TFile, created: TFile[], idx: AnchorIndex, text: string, hostPath: string, host: number): OwnEdit[] {
	const out: OwnEdit[] = [];
	for (const l of findLinks(text)) {
		const was = l.path === "" ? source : app.metadataCache.getFirstLinkpathDest(l.path, source.path);
		if (!was) continue;
		let newText: string | null = null;
		if (was.path === source.path) {
			if (!l.sub) continue; // the whole source note: it stays where it is
			const at = locate(idx, l.sub);
			if (!at) continue; // was already broken before the split
			if (host === -1 && at.loc === -1) continue;
			if (at.loc === host && l.path === "") continue; // [[#X]] in the note that now holds X
			newText = retarget(app, l, hostPath, at.loc === -1 ? source : created[at.loc]!, at.subpath);
		} else if (host >= 0 && !created.some((c) => c.path === was.path)) {
			if (app.metadataCache.getFirstLinkpathDest(l.path, hostPath)?.path === was.path) continue;
			newText = retarget(app, l, hostPath, was, l.sub ? `#${l.sub}` : "");
		}
		if (newText !== null && newText !== l.original) out.push({ start: l.start, end: l.end, oldText: l.original, newText });
	}
	return out;
}

/**
 * The read-back: parse the source, the new notes and every note that links to the source, and list each link into
 * the source or a new note whose heading or block is gone, plus any link in a new note that resolved from the
 * original folder but no longer does. Links that were already broken before the split are not listed.
 */
export async function verifyLinks(app: App, source: TFile, before: string, created: TFile[], others: string[]): Promise<string[]> {
	const bad: string[] = [];
	const createdPaths = new Set(created.map((c) => c.path));
	const texts = new Map<string, string>();
	const read = async (p: string) => {
		if (!texts.has(p)) {
			const f = app.vault.getFileByPath(p);
			texts.set(p, f ? await app.vault.read(f) : "");
		}
		return texts.get(p)!;
	};
	const orig = anchorsIn(before);
	const files = [...new Set([source.path, ...created.map((c) => c.path), ...others])];
	for (const p of files) {
		if (!app.vault.getFileByPath(p)) continue;
		for (const l of findLinks(await read(p))) {
			const t = l.path === "" ? app.vault.getFileByPath(p) : app.metadataCache.getFirstLinkpathDest(l.path, p);
			if (!t) {
				if (createdPaths.has(p) && l.path && app.metadataCache.getFirstLinkpathDest(l.path, source.path)) bad.push(`${p}: ${l.original}`);
				continue;
			}
			if (!l.sub || (t.path !== source.path && !createdPaths.has(t.path))) continue;
			if (hasAnchor(anchorsIn(await read(t.path)), l.sub)) continue;
			// Report it only if it pointed at something real in the original note (not a link that was already broken).
			if (hasAnchor(orig, l.sub)) bad.push(`${p}: ${l.original}`);
		}
	}
	return bad;
}

/** Rewrites inbound links file by file, pushing each file's applied edits into `out` as soon as it is written. */
async function repairInbound(app: App, source: TFile, plan: SplitPlan, created: TFile[], out: Journal["linkEdits"], count: { updated: number; skipped: number }, seen: Set<string>) {
	const doc = parseDoc(plan.raw);
	const edits = planLinkEdits(await inboundRefs(app, source, new Set(created.map((c) => c.path)), seen), anchorsFor(doc, plan));
	const byPath = new Map<string, typeof edits>();
	for (const e of edits) byPath.set(e.path, [...(byPath.get(e.path) ?? []), e]);
	for (const [path, list] of byPath) {
		const f = app.vault.getFileByPath(path);
		if (!f) {
			count.skipped += list.length;
			continue;
		}
		const withText = list.map((e) => {
			let l = app.fileManager.generateMarkdownLink(created[e.part]!, path, e.subpath, e.alias);
			if (hasEscapedPipe(e.oldText)) l = escapeAliasPipe(l); // keep "\\|" so a link in a table stays in its cell
			return { start: e.start, end: e.end, oldText: e.oldText, newText: e.embed ? `!${l.replace(/^!/, "")}` : l };
		});
		let r: ReturnType<typeof applyEdits> | null = null;
		try {
			await app.vault.process(f, (data) => {
				r = applyEdits(data, withText);
				return r.text;
			});
		} catch (e) {
			// If the write landed anyway, record it so Undo can revert it; then report the failure.
			const done = r as ReturnType<typeof applyEdits> | null;
			if (done && done.applied.length && (await app.vault.read(f).catch(() => null)) === done.text) {
				out.push({ path, applied: done.applied });
				count.updated += done.applied.length;
			}
			throw e;
		}
		const done = r as ReturnType<typeof applyEdits> | null;
		if (!done) continue;
		count.skipped += done.skipped;
		count.updated += done.applied.length;
		if (done.applied.length) out.push({ path, applied: done.applied });
	}
}

export interface UndoResult {
	trashed: number;
	linksReverted: number;
	linksSkipped: number;
}

/** Restore the source note, move the new notes to the trash, revert repaired links. Refuses if anything was edited since. */
export async function undoSplit(app: App, j: Journal): Promise<UndoResult> {
	const src = app.vault.getFileByPath(j.sourcePath);
	if (!src) throw new PlanError(`The source note ${j.sourcePath} was moved or deleted, so the split cannot be undone automatically.`);
	if ((await app.vault.read(src)) !== j.after) {
		throw new PlanError("The source note was edited after the split. Undo would overwrite those edits, so nothing was changed.");
	}
	const existing: TFile[] = [];
	const edited: string[] = [];
	for (const c of j.created) {
		const f = app.vault.getFileByPath(c.path);
		if (!f) continue;
		if (fingerprint(await app.vault.read(f)) !== c.fp) edited.push(c.path);
		else existing.push(f);
	}
	if (edited.length) {
		throw new PlanError(`These new notes were edited after the split, so nothing was changed: ${edited.join(", ")}. Undo would lose those edits.`);
	}
	await app.vault.process(src, (data) => {
		if (data !== j.after) throw new PlanError("The source note changed during undo. Nothing was changed.");
		return j.before;
	});
	for (const f of existing) await app.fileManager.trashFile(f);
	let linksReverted = 0;
	let linksSkipped = 0;
	const trashed = new Set(existing.map((f) => f.path));
	for (const le of j.linkEdits) {
		// Links repaired inside a new note went to the trash with that note; nothing to revert.
		if (trashed.has(le.path)) continue;
		const f = app.vault.getFileByPath(le.path);
		if (!f) {
			linksSkipped += le.applied.length;
			continue;
		}
		await app.vault.process(f, (data) => {
			const r = revertEdits(data, le.applied);
			linksSkipped += r.skipped;
			linksReverted += le.applied.length - r.skipped;
			return r.text;
		});
	}
	return { trashed: existing.length, linksReverted, linksSkipped };
}
