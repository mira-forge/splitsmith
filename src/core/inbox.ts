/**
 * Inbox mode: pick a folder once; list the notes in it that were never processed or changed since;
 * split the chosen ones with one preset in ONE reviewed batch.
 *
 * Safety model, on top of applySplit's per-note transaction (lossless check, read-back, undo journal):
 *   - Nothing is written until the user approves the reviewed batch (the plugin's review modal).
 *   - The batch is all or nothing: if any note fails, every note already split in this batch is undone,
 *     newest first, and the vault is left as it was. If an undo is refused (for example a note was edited
 *     during the run), the batch stops and keeps the journals that are still undoable.
 *   - A note whose text changed after the review is refused, except for link updates made by an earlier
 *     note in the same batch (link repair); those are mapped onto the reviewed plan exactly.
 */
import { normalizePath, type App, type TFile } from "obsidian";
import { applySplit, undoSplit, unverifiedLine, type Journal, type SplitOptions, type SplitResult } from "./apply";
import { fingerprint, PlanError, type SplitPlan } from "./plan";

/** path -> fingerprint of the note's text when Splitsmith last processed it. */
export type DoneMap = Record<string, string>;

export interface PendingNote {
	file: TFile;
	status: "new" | "changed";
}

export function inFolder(path: string, folder: string): boolean {
	const f = normalizePath(folder.trim());
	if (!f || f === "/") return true;
	return path.startsWith(`${f}/`);
}

/** Markdown notes in the inbox folder (and its subfolders) that are new or changed since they were processed. */
export async function pendingNotes(app: App, folder: string, done: DoneMap): Promise<PendingNote[]> {
	const out: PendingNote[] = [];
	const files = app.vault
		.getMarkdownFiles()
		.filter((f) => inFolder(f.path, folder))
		.sort((a, b) => a.path.localeCompare(b.path));
	for (const file of files) {
		const fp = done[file.path];
		if (fp === undefined) out.push({ file, status: "new" });
		else if (fingerprint(await app.vault.cachedRead(file)) !== fp) out.push({ file, status: "changed" });
	}
	return out;
}

/** Drop entries for notes that no longer exist, so data.json does not grow forever. */
export function pruneDone(app: App, done: DoneMap): DoneMap {
	const out: DoneMap = {};
	for (const [p, fp] of Object.entries(done)) if (app.vault.getFileByPath(p)) out[p] = fp;
	return out;
}

type Edit = { start: number; oldText: string; newText: string };

/**
 * Map a reviewed plan onto the note's current text when the only difference is link edits from earlier
 * notes in the same batch. `rounds` are the applied edits per earlier note, in order; each round's starts
 * are in the coordinates of the text after that round (as journals record them). Returns null if the
 * current text is not exactly the reviewed text plus those edits, or if an edit straddles a part boundary.
 */
export function rebasePlan(plan: SplitPlan, current: string, rounds: Edit[][]): SplitPlan | null {
	let text = plan.raw;
	let bounds = [plan.bodyFrom, ...plan.parts.flatMap((p) => [p.from, p.to])];
	for (const round of rounds) {
		const sorted = [...round].sort((a, b) => a.start - b.start);
		let next = "";
		let cur = 0;
		let shift = 0;
		const spans: { from: number; to: number; delta: number }[] = [];
		for (const e of sorted) {
			const oldStart = e.start - shift;
			const oldEnd = oldStart + e.oldText.length;
			if (oldStart < cur || text.slice(oldStart, oldEnd) !== e.oldText) return null;
			next += text.slice(cur, oldStart) + e.newText;
			cur = oldEnd;
			const delta = e.newText.length - e.oldText.length;
			spans.push({ from: oldStart, to: oldEnd, delta });
			shift += delta;
		}
		next += text.slice(cur);
		const mapped: number[] = [];
		for (const x of bounds) {
			let d = 0;
			for (const s of spans) {
				if (s.from < x && x < s.to) return null;
				if (s.to <= x) d += s.delta;
			}
			mapped.push(x + d);
		}
		text = next;
		bounds = mapped;
	}
	if (text !== current) return null;
	const [bodyFrom, ...rest] = bounds;
	const parts = plan.parts.map((p, i) => ({ title: p.title, from: rest[2 * i]!, to: rest[2 * i + 1]! }));
	return { ...plan, raw: current, bodyFrom: bodyFrom!, parts };
}

export interface BatchItem {
	file: TFile;
	plan: SplitPlan;
	options: SplitOptions;
}

export interface BatchResult {
	results: { path: string; result: SplitResult }[];
	/** In the order applied. Undo them newest first. */
	journals: Journal[];
	warnings: string[];
}

export class BatchError extends PlanError {
	constructor(
		message: string,
		/** Journals that could not be undone during rollback; still undoable later (newest last). */
		public remaining: Journal[],
	) {
		super(message);
	}
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Undo journals newest first. Returns the journals that could not be undone (oldest first) and why. */
export async function undoBatch(app: App, journals: Journal[]): Promise<{ undone: number; remaining: Journal[]; error?: string }> {
	let undone = 0;
	for (let i = journals.length - 1; i >= 0; i--) {
		try {
			await undoSplit(app, journals[i]!);
			undone++;
		} catch (e) {
			return { undone, remaining: journals.slice(0, i + 1), error: `${journals[i]!.sourcePath}: ${msg(e)}` };
		}
	}
	return { undone, remaining: [] };
}

/**
 * Apply a reviewed batch, one note at a time through applySplit. All or nothing (see the file comment).
 * Throws BatchError (with nothing changed, or with the journals that are left) on any failure.
 */
export async function applyBatch(app: App, items: BatchItem[]): Promise<BatchResult> {
	const journals: Journal[] = [];
	const results: BatchResult["results"] = [];
	const warnings: string[] = [];
	const fail = async (why: string): Promise<never> => {
		const u = await undoBatch(app, journals);
		if (u.remaining.length) {
			throw new BatchError(
				`${why} Rolling back the batch stopped at ${u.error}. ${u.remaining.length} split${u.remaining.length === 1 ? " is" : "s are"} still in place; run "Undo last split" after fixing that note.`,
				u.remaining,
			);
		}
		throw new BatchError(`${why} ${journals.length ? `The ${journals.length} note${journals.length === 1 ? "" : "s"} already split in this batch ${journals.length === 1 ? "was" : "were"} undone, so nothing was changed.` : "Nothing was changed."}`, []);
	};
	for (const it of items) {
		let plan = it.plan;
		const now = await app.vault.read(it.file).catch(() => null);
		if (now === null) await fail(`${it.file.path} could not be read.`);
		if (now !== plan.raw) {
			const rounds = journals.map((j) => j.linkEdits.filter((le) => le.path === it.file.path).flatMap((le) => le.applied)).filter((r) => r.length);
			const rebased = rounds.length ? rebasePlan(plan, now!, rounds) : null;
			if (!rebased) await fail(`${it.file.path} changed after the review.`);
			plan = rebased!;
		}
		let r: SplitResult;
		try {
			r = await applySplit(app, it.file, plan, it.options);
		} catch (e) {
			// applySplit already put this note back; now undo the earlier ones.
			return fail(`${it.file.path}: ${msg(e)}`);
		}
		journals.push(r.journal);
		results.push({ path: it.file.path, result: r });
		if (r.warning) warnings.push(`${it.file.path}: ${r.warning}`);
		if (r.unverified.length) warnings.push(`${it.file.path}: ${unverifiedLine(r.unverified)}`);
	}
	return { results, journals, warnings };
}

/** Inbox summary line for notes the preset found nothing to split in (left untouched). Empty when there are none. */
export function skippedSummary(paths: string[], max = 10): string {
	if (!paths.length) return "";
	const names = paths.map((p) => p.replace(/^.*\//, "").replace(/\.md$/i, ""));
	const shown = names.slice(0, max).join(", ") + (names.length > max ? `, and ${names.length - max} more` : "");
	return `Nothing to split in ${names.length === 1 ? "1 note" : `${names.length} notes`}, left untouched: ${shown}.`;
}
