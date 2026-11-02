import { MarkdownView, Notice, Platform, Plugin, TFile, requestUrl, type Editor } from "obsidian";
import { complete, type HttpFn, type ModelConfig } from "./ai/providers";
import { AI_WINDOW_CHARS } from "./config";
import { DEFAULT_SETTINGS, SplitsmithSettingTab, type SplitsmithSettings } from "./settings";
import { cleanPreset, DEFAULT_PRESETS, mechanicalParts, presetOptions, type Preset } from "./core/presets";
import { applyBatch, BatchError, pendingNotes, pruneDone, skippedSummary, undoBatch } from "./core/inbox";
import { fingerprint } from "./core/plan";
import { InboxModal, type InboxPlan } from "./ui/inbox-modal";
import { FolderPickModal, PresetPickModal } from "./ui/pick-modals";
import { headingCounts, lineAtOffset, parseDoc, partAtLine, partsByDelimiter, partsByHeading, safeTitle, tokenize, type Doc, type Part } from "./core/sections";
import { PlanError, planFromParts, planFromSelection, type SplitPlan } from "./core/plan";
import { applySplit, undoSplit, unverifiedLine, type LinkStyle, type SplitOptions } from "./core/apply";
import { planWithAi } from "./core/ai-split";
import { PreviewModal } from "./ui/preview-modal";
import { LevelModal } from "./ui/level-modal";
import { cardsmithLinkText, noticeWithCardsmithLink, openCardsmith } from "./ui/cardsmith-link";

/** Obsidian's requestUrl does not apply browser CORS rules, which local Ollama and most APIs need. */
const obsidianHttp: HttpFn = async (req) => {
	const res = await requestUrl({ url: req.url, method: req.method, headers: req.headers, body: req.body, throw: false });
	let json: unknown = null;
	try {
		json = res.json;
	} catch {
		json = null;
	}
	return { status: res.status, json, text: typeof res.text === "string" ? res.text : "" };
};

export default class SplitsmithPlugin extends Plugin {
	settings: SplitsmithSettings = { ...DEFAULT_SETTINGS };
	/** Injectable for tests; defaults to Obsidian's requestUrl. Used only for the user's own AI provider. */
	http: HttpFn = obsidianHttp;
	private busy = false;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.addSettingTab(new SplitsmithSettingTab(this.app, this));

		this.addCommand({
			id: "split-by-heading",
			name: "Split note by heading level",
			checkCallback: (checking) => this.withNote(checking, (doc, file) => this.splitByHeading(doc, file)),
		});
		this.addCommand({
			id: "split-by-delimiter",
			name: "Split note by delimiter",
			checkCallback: (checking) =>
				this.withNote(checking, (doc, file) =>
					this.preview(file, doc, partsByDelimiter(doc, this.settings.delimiter), `Split at "${this.settings.delimiter}"`, undefined, undefined, 2),
				),
		});
		this.addCommand({
			id: "split-at-cursor",
			name: "Move this line and everything below it to a new note",
			editorCheckCallback: (checking, editor, ctx) => {
				if (!ctx.file || ctx.file.extension !== "md") return false;
				if (!checking) void this.fromEditor(editor, ctx.file, "cursor");
				return true;
			},
		});
		this.addCommand({
			id: "extract-selection",
			name: "Extract selection to a new note",
			editorCheckCallback: (checking, editor, ctx) => {
				if (!ctx.file || ctx.file.extension !== "md" || !editor.somethingSelected()) return false;
				if (!checking) void this.fromEditor(editor, ctx.file, "selection");
				return true;
			},
		});
		this.addCommand({
			id: "ai-split",
			name: "Split note with AI (preview first)",
			checkCallback: (checking) => this.withNote(checking, (doc, file) => this.aiSplit(doc, file)),
		});
		this.addCommand({
			id: "split-with-preset",
			name: "Split note with a preset",
			checkCallback: (checking) => this.withNote(checking, (doc, file) => this.splitWithPreset(doc, file)),
		});
		this.addCommand({
			id: "process-inbox",
			name: "Process inbox: split new and changed notes",
			callback: () => void this.processInbox(),
		});
		this.addRibbonIcon("inbox", "Process inbox", () => void this.processInbox());
		this.addCommand({
			id: "undo-last-split",
			name: "Undo last split",
			checkCallback: (checking) => {
				if (!this.settings.lastSplit && !this.settings.lastBatch) return false;
				if (!checking) void this.undo();
				return true;
			},
		});
	}

	async loadSettings(): Promise<void> {
		const loaded = ((await this.loadData()) as Partial<SplitsmithSettings> | null) ?? {};
		this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded);
		// Copy nested defaults so edits never touch DEFAULT_SETTINGS, and repair hand-edited presets.
		const raw = Array.isArray(loaded.presets) && loaded.presets.length ? loaded.presets : DEFAULT_PRESETS;
		this.settings.presets = raw.map((p, i) => cleanPreset(p, `preset-${i + 1}`));
		this.settings.inboxDone = { ...(loaded.inboxDone ?? {}) };
		if (typeof this.settings.showCardsmithLink !== "boolean") this.settings.showCardsmithLink = true;
		if (!this.settings.presets.some((p) => p.id === this.settings.inboxPresetId)) this.settings.inboxPresetId = this.settings.presets[0]!.id;
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	/** Run `fn` on the active Markdown note, after flushing unsaved editor changes so the file on disk is current. */
	private withNote(checking: boolean, fn: (doc: Doc, file: TFile) => void | Promise<void>): boolean {
		const file = this.app.workspace.getActiveFile();
		if (!file || file.extension !== "md") return false;
		if (checking) return true;
		void (async () => {
			try {
				await this.flush(file);
				const doc = parseDoc(await this.app.vault.read(file));
				await fn(doc, file);
			} catch (e) {
				new Notice(e instanceof Error ? e.message : "Splitsmith could not read this note.", 8000);
			}
		})();
		return true;
	}

	/**
	 * Save unsaved editor changes so the file on disk is current. Only saves when the editor differs:
	 * saving an unchanged CRLF note would make Obsidian rewrite it with LF line endings.
	 */
	async flush(file: TFile): Promise<void> {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (view?.file?.path !== file.path) return;
		const raw = await this.app.vault.read(file);
		if (raw.replace(/\r\n/g, "\n") !== view.editor.getValue().replace(/\r\n/g, "\n")) await view.save();
	}

	private splitByHeading(doc: Doc, file: TFile): void {
		const raw = headingCounts(doc);
		if (!raw.some((c) => c > 0)) {
			new Notice("This note has no headings outside code blocks. Try split by delimiter or AI split.");
			return;
		}
		// Offer only levels that split something: one section holding the whole note is nothing to split (Gate 3).
		const counts = raw.map((c, l) => {
			if (!c) return 0;
			try {
				return planFromParts(doc, partsByHeading(doc, l)).parts.length;
			} catch {
				return c;
			}
		});
		if (!counts.some((c) => c > 0)) {
			new Notice("Nothing to split: at every heading level this note is one section holding the whole note.");
			return;
		}
		new LevelModal(this.app, counts, (level) => this.preview(file, doc, partsByHeading(doc, level), `Split at heading ${level}`)).open();
	}

	/** Cursor and selection commands map editor positions (line, ch) onto the file's own lines, so CRLF files stay exact. */
	private async fromEditor(editor: Editor, file: TFile, mode: "cursor" | "selection"): Promise<void> {
		try {
			await this.flush(file);
			const raw = await this.app.vault.read(file);
			if (raw.replace(/\r\n/g, "\n") !== editor.getValue().replace(/\r\n/g, "\n")) {
				new Notice("The note has unsaved changes. Wait a moment and try again.");
				return;
			}
			const doc = parseDoc(raw);
			const lines = tokenize(raw);
			const toOffset = (p: { line: number; ch: number }) => {
				const l = lines[p.line];
				return l ? l.from + Math.min(p.ch, l.text.length) : raw.length;
			};
			if (mode === "cursor") {
				const at = lineAtOffset(doc, toOffset(editor.getCursor("from")));
				const parts = at < 0 ? [] : partAtLine(doc, at);
				if (!parts.length) {
					new Notice("There is no text from this line down to move.");
					return;
				}
				this.preview(file, doc, parts, "Move the rest of the note");
				return;
			}
			const from = toOffset(editor.getCursor("from"));
			const to = toOffset(editor.getCursor("to"));
			const sel = raw.slice(from, to);
			const firstLine = sel.split(/\r?\n/).find((l) => l.trim()) ?? "";
			const plan = planFromSelection(doc, from, to, safeTitle(firstLine.replace(/^\s*#{1,6}\s+/, "").slice(0, 80)));
			this.openPreview(file, plan, "Extract selection");
		} catch (e) {
			new Notice(e instanceof Error ? e.message : "Could not extract the selection.", 8000);
		}
	}

	private preview(file: TFile, doc: Doc, parts: Part[], heading: string, note?: string, options?: SplitOptions, minParts = 1): void {
		if (!parts.length) {
			new Notice("Nothing to split here.");
			return;
		}
		let plan: SplitPlan;
		try {
			plan = planFromParts(doc, parts, minParts);
		} catch (e) {
			new Notice(e instanceof Error ? e.message : "Could not plan the split.", 8000);
			return;
		}
		if (!plan.parts.length) {
			new Notice("Nothing to split here.");
			return;
		}
		this.openPreview(file, plan, heading, note, options);
	}

	private openPreview(file: TFile, plan: SplitPlan, heading: string, note?: string, options?: SplitOptions): void {
		new PreviewModal(this.app, {
			heading,
			note,
			plan,
			linkStyle: options?.linkStyle ?? this.settings.linkStyle,
			onApply: (p, style) => this.apply(file, p, style, options),
		}).open();
	}

	/** `options` comes from a preset; without one the settings are used. The preview's link style always wins. */
	async apply(file: TFile, plan: SplitPlan, linkStyle: LinkStyle, options?: SplitOptions): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		try {
			const s = this.settings;
			let r: Awaited<ReturnType<typeof applySplit>>;
			try {
				r = await applySplit(this.app, file, plan, {
					...(options ?? {
						folder: s.folder,
						fileNameTemplate: s.fileNameTemplate,
						inherit: s.inherit,
						sourceProperty: s.sourceProperty,
						repairLinks: s.repairLinks,
					}),
					linkStyle,
				});
			} catch (e) {
				// applySplit only throws when nothing was changed (it rolls back first).
				new Notice(e instanceof PlanError ? e.message : "The split failed. Nothing was changed.", 10000);
				return;
			}
			// From here on the split is done: always keep the undo journal and never say "nothing was changed".
			this.settings.lastSplit = r.journal;
			this.settings.lastBatch = null;
			let saved = true;
			try {
				await this.saveSettings();
			} catch {
				saved = false;
			}
			const n = `${r.created.length} note${r.created.length === 1 ? "" : "s"}`;
			const undo = saved ? ' Run "Undo last split" to reverse it.' : " Undo could not be saved to disk, so it only works until Obsidian restarts.";
			if (r.warning) {
				new Notice(`${r.warning} Created ${n}.${r.linksUpdated ? ` ${r.linksUpdated} link${r.linksUpdated === 1 ? " was" : "s were"} updated before the error.` : ""}${r.unverified.length ? ` ${unverifiedLine(r.unverified)}` : ""}${undo}`, 0);
				return;
			}
			const links = r.linksUpdated ? ` Updated ${r.linksUpdated} link${r.linksUpdated === 1 ? "" : "s"} in other notes.` : "";
			const own = r.linksRewritten ? ` Updated ${r.linksRewritten} link${r.linksRewritten === 1 ? "" : "s"} in this note and the new notes.` : "";
			const skipped = r.linksSkipped ? ` ${r.linksSkipped} link${r.linksSkipped === 1 ? "" : "s"} could not be updated.` : "";
			const unverified = unverifiedLine(r.unverified);
			const message = `Created ${n}.${links}${own}${skipped}${unverified ? ` ${unverified}` : ""}${undo}`;
			const first = r.created[0] ? this.app.vault.getFileByPath(r.created[0]) : null;
			const notice: Notice = new Notice(
				noticeWithCardsmithLink(
					message,
					cardsmithLinkText(this.app, this.settings.showCardsmithLink),
					() => {
						notice.hide();
						void openCardsmith(this.app, first);
					},
					() => {
						notice.hide();
						this.settings.showCardsmithLink = false;
						void this.saveSettings();
					},
				),
				unverified ? 0 : 8000,
			);
		} finally {
			this.busy = false;
		}
	}

	async undo(): Promise<void> {
		if (this.settings.lastBatch) return this.undoInbox();
		const j = this.settings.lastSplit;
		if (!j || this.busy) return;
		this.busy = true;
		try {
			const r = await undoSplit(this.app, j);
			this.settings.lastSplit = null;
			await this.saveSettings();
			const skipped = r.linksSkipped ? ` ${r.linksSkipped} link${r.linksSkipped === 1 ? "" : "s"} had changed and were left as they are.` : "";
			new Notice(`Split undone: restored the original note and moved ${r.trashed} new note${r.trashed === 1 ? "" : "s"} to the trash.${skipped}`, 8000);
		} catch (e) {
			new Notice(e instanceof PlanError ? e.message : "Undo failed.", 10000);
		} finally {
			this.busy = false;
		}
	}

	private modelConfig(): ModelConfig {
		const s = this.settings;
		const apiKey = s.kind === "ollama" || !s.apiKeySecret ? "" : (this.app.secretStorage.getSecret(s.apiKeySecret) ?? "");
		return { kind: s.kind, baseUrl: s.baseUrl, model: s.model, apiKey, temperature: s.temperature };
	}

	async aiSplit(doc: Doc, file: TFile): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		const notice = new Notice("Splitsmith is asking your model where to cut…", 0);
		let parts: Part[];
		try {
			const cfg = this.modelConfig();
			parts = await planWithAi(doc, {
				instructions: this.settings.instructions,
				language: this.settings.language,
				windowChars: AI_WINDOW_CHARS,
				ask: (system, user) => complete(this.http, cfg, system, user, { mobile: Platform.isMobile }),
			});
		} catch (e) {
			notice.hide();
			this.busy = false;
			new Notice(e instanceof Error ? `${e.message} Nothing was changed.` : "AI split failed. Nothing was changed.", 10000);
			return;
		}
		notice.hide();
		this.busy = false;
		this.preview(file, doc, parts, "AI split plan (dry run)", "The model chose these cut points and titles only. Your text below is shown exactly as it will be moved.");
	}

	// ---------- Saved presets and Inbox mode ----------

	private presetById(id: string): Preset | undefined {
		return this.settings.presets.find((p) => p.id === id);
	}

	/** Parts for one note with a preset. AI presets ask the user's model . */
	async partsForPreset(doc: Doc, preset: Preset): Promise<Part[]> {
		if (preset.method !== "ai") return mechanicalParts(doc, preset);
		const cfg = this.modelConfig();
		return planWithAi(doc, {
			instructions: preset.instructions.trim() || this.settings.instructions,
			language: this.settings.language,
			windowChars: AI_WINDOW_CHARS,
			ask: (system, user) => complete(this.http, cfg, system, user, { mobile: Platform.isMobile }),
		});
	}

	private splitWithPreset(doc: Doc, file: TFile): void {
		new PresetPickModal(this.app, this.settings.presets, (preset) => void this.runPreset(doc, file, preset)).open();
	}

	async runPreset(doc: Doc, file: TFile, preset: Preset): Promise<void> {
		let parts: Part[];
		try {
			parts = await this.partsForPreset(doc, preset);
		} catch (e) {
			new Notice(e instanceof Error ? `${e.message} Nothing was changed.` : "Could not plan the split. Nothing was changed.", 10000);
			return;
		}
		this.preview(file, doc, parts, preset.name, preset.method === "ai" ? "The model chose these cut points and titles only. Your text below is shown exactly as it will be moved." : undefined, presetOptions(preset, this.settings), preset.method === "delimiter" ? 2 : 1);
	}

	/** Command and ribbon entry point. Asks for the inbox folder once. */
	async processInbox(): Promise<void> {
		if (this.busy) return;
		const s = this.settings;
		if (!s.inboxFolder || !this.app.vault.getFolderByPath(s.inboxFolder)) {
			new FolderPickModal(this.app, (f) => {
				s.inboxFolder = f.path;
				void this.saveSettings().then(() => this.processInbox());
			}).open();
			return;
		}
		s.inboxDone = pruneDone(this.app, s.inboxDone);
		const pending = await pendingNotes(this.app, s.inboxFolder, s.inboxDone);
		if (!pending.length) {
			new Notice(`Your inbox is clear: no new or changed notes in ${s.inboxFolder}.`);
			return;
		}
		new InboxModal(this.app, {
			folder: s.inboxFolder,
			pending,
			presets: s.presets,
			presetId: s.inboxPresetId,
			plan: (files, preset, progress) => this.planInbox(files, preset, progress),
			onApply: (chosen, nothing, preset) => this.applyInbox(chosen, nothing, preset),
		}).open();
	}

	/** Step 1 of Inbox mode: plan every chosen note. Reads only; nothing is written. */
	async planInbox(files: TFile[], preset: Preset, progress: (done: number, total: number) => void = () => {}): Promise<InboxPlan[]> {
		const out: InboxPlan[] = [];
		for (const [i, file] of files.entries()) {
			progress(i, files.length);
			try {
				const doc = parseDoc(await this.app.vault.read(file));
				const parts = await this.partsForPreset(doc, preset);
				const plan = parts.length ? planFromParts(doc, parts, preset.method === "delimiter" ? 2 : 1) : null;
				out.push(plan && plan.parts.length ? { file, plan } : { file, plan: null, skip: { kind: "nothing", reason: "Nothing to split" } });
			} catch (e) {
				const reason = e instanceof Error ? e.message : "Could not plan this note";
				out.push({ file, plan: null, skip: { kind: "error", reason } });
			}
		}
		progress(files.length, files.length);
		return out;
	}

	/** Step 2 of Inbox mode: write the reviewed batch (all or nothing), then mark the notes as done. */
	async applyInbox(chosen: { file: TFile; plan: SplitPlan }[], nothing: TFile[], preset: Preset): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		const s = this.settings;
		try {
			const prevDone: Record<string, string | null> = {};
			const mark = async (path: string) => {
				const f = this.app.vault.getFileByPath(path);
				if (!f) return;
				if (!(path in prevDone)) prevDone[path] = s.inboxDone[path] ?? null;
				s.inboxDone[path] = fingerprint(await this.app.vault.read(f));
			};
			if (!chosen.length) {
				for (const f of nothing) await mark(f.path);
				await this.saveSettings();
				new Notice(`${skippedSummary(nothing.map((f) => f.path))} ${nothing.length === 1 ? "Marked it as done." : "Marked them as done."}`, 0);
				return;
			}
			const options = presetOptions(preset, s);
			let r: Awaited<ReturnType<typeof applyBatch>>;
			try {
				r = await applyBatch(
					this.app,
					chosen.map((c) => ({ file: c.file, plan: c.plan, options })),
				);
			} catch (e) {
				if (e instanceof BatchError && e.remaining.length) {
					s.lastBatch = { at: Date.now(), journals: e.remaining, prevDone: {} };
					s.lastSplit = null;
					await this.saveSettings().catch(() => undefined);
				}
				new Notice(e instanceof Error ? e.message : "The batch failed. Nothing was changed.", 0);
				return;
			}
			for (const res of r.results) {
				await mark(res.path);
				for (const c of res.result.created) await mark(c);
			}
			for (const f of nothing) await mark(f.path);
			s.lastBatch = { at: Date.now(), journals: r.journals, prevDone };
			s.lastSplit = null;
			let saved = true;
			try {
				await this.saveSettings();
			} catch {
				saved = false;
			}
			const created = r.results.reduce((n, x) => n + x.result.created.length, 0);
			const undo = saved ? ' Run "Undo last split" to reverse the whole batch.' : " Undo could not be saved to disk, so it only works until Obsidian restarts.";
			const head = `Inbox: split ${r.results.length === 1 ? "1 note" : `${r.results.length} notes`} into ${created === 1 ? "1 new note" : `${created} new notes`}.`;
			const skipped = skippedSummary(nothing.map((f) => f.path));
			new Notice(`${head}${skipped ? ` ${skipped}` : ""}${r.warnings.length ? ` ${r.warnings.join(" ")}` : ""}${undo}`, r.warnings.length || skipped ? 0 : 8000);
		} finally {
			this.busy = false;
		}
	}

	async undoInbox(): Promise<void> {
		const b = this.settings.lastBatch;
		if (!b || this.busy) return;
		this.busy = true;
		try {
			const u = await undoBatch(this.app, b.journals);
			const s = this.settings;
			if (u.remaining.length) {
				s.lastBatch = { ...b, journals: u.remaining };
				await this.saveSettings();
				new Notice(`Undid ${u.undone} of ${b.journals.length} splits from the batch, then stopped: ${u.error}`, 0);
				return;
			}
			for (const [p, fp] of Object.entries(b.prevDone)) {
				if (fp === null) delete s.inboxDone[p];
				else s.inboxDone[p] = fp;
			}
			s.lastBatch = null;
			await this.saveSettings();
			new Notice(`Batch undone: restored ${u.undone === 1 ? "1 note" : `${u.undone} notes`} and moved their new notes to the trash.`, 8000);
		} catch (e) {
			new Notice(e instanceof Error ? e.message : "Undo failed.", 10000);
		} finally {
			this.busy = false;
		}
	}
}
