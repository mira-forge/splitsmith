import { App, Modal, Setting } from "obsidian";
import type { TFile } from "obsidian";
import { dropPart, partBody, render, verifyLossless, type SplitPlan } from "../core/plan";
import { safeTitle } from "../core/sections";
import type { PendingNote } from "../core/inbox";
import type { Preset } from "../core/presets";

/** One note's planned split, or why it has none. */
export interface InboxPlan {
	file: TFile;
	plan: SplitPlan | null;
	/** "nothing" = the preset finds nothing to split (marked as done on apply); "error" = planning failed (left as is). */
	skip?: { kind: "nothing" | "error"; reason: string };
}

export interface InboxModalOptions {
	folder: string;
	pending: PendingNote[];
	presets: Preset[];
	presetId: string;
	plan: (files: TFile[], preset: Preset, progress: (done: number, total: number) => void) => Promise<InboxPlan[]>;
	onApply: (chosen: { file: TFile; plan: SplitPlan }[], nothing: TFile[], preset: Preset) => Promise<void>;
}

/** Result of the review step: only ticked notes and ticked parts, titles cleaned. */
export function chosenBatch(plans: InboxPlan[], keepNote: boolean[], keepPart: boolean[][]): { file: TFile; plan: SplitPlan }[] {
	const out: { file: TFile; plan: SplitPlan }[] = [];
	plans.forEach((p, i) => {
		if (!p.plan || !keepNote[i]) return;
		let plan = p.plan;
		const keep = keepPart[i] ?? [];
		for (let k = keep.length - 1; k >= 0; k--) if (!keep[k]) plan = dropPart(plan, k);
		if (!plan.parts.length) return;
		out.push({ file: p.file, plan: { ...plan, parts: plan.parts.map((x) => ({ ...x, title: safeTitle(x.title) })) } });
	});
	return out;
}

/**
 * Inbox mode in two steps, nothing written before the second:
 *   1. choose notes and a preset, then plan them (AI presets ask your model here, one request per note or section);
 *   2. review every planned note (untick notes or parts, rename parts), then create the whole batch.
 */
export class InboxModal extends Modal {
	private keepFile: boolean[];
	private presetId: string;
	private plans: InboxPlan[] = [];
	private keepNote: boolean[] = [];
	private keepPart: boolean[][] = [];
	private statusEl: HTMLElement | null = null;
	private button: HTMLButtonElement | null = null;

	constructor(
		app: App,
		private o: InboxModalOptions,
	) {
		super(app);
		this.keepFile = o.pending.map(() => true);
		this.presetId = o.presets.some((p) => p.id === o.presetId) ? o.presetId : (o.presets[0]?.id ?? "");
	}

	private preset(): Preset | undefined {
		return this.o.presets.find((p) => p.id === this.presetId);
	}

	onOpen(): void {
		this.modalEl.addClass("splitsmith-preview");
		this.drawChoose();
	}

	private drawChoose(): void {
		const { contentEl } = this;
		contentEl.empty();
		const n = this.o.pending.length;
		this.setTitle(n === 1 ? "Inbox: 1 note to split" : `Inbox: ${n} notes to split`);
		contentEl.createEl("p", { cls: "splitsmith-muted", text: `New or changed in ${this.o.folder} since Splitsmith last split them. Nothing is written until you review the batch and select create.` });
		new Setting(contentEl).setName("Preset").addDropdown((d) => {
			for (const p of this.o.presets) d.addOption(p.id, p.name);
			d.setValue(this.presetId).onChange((v) => (this.presetId = v));
		});
		const list = contentEl.createDiv({ cls: "splitsmith-part-list" });
		let planBtn: HTMLButtonElement | null = null;
		const count = () => this.keepFile.filter(Boolean).length;
		const label = () => (count() === 1 ? "Plan 1 note" : `Plan ${count()} notes`);
		this.o.pending.forEach((p, i) => {
			const row = list.createDiv({ cls: "splitsmith-part" });
			const head = row.createDiv({ cls: "splitsmith-part-head" });
			const cb = head.createEl("input", { type: "checkbox" });
			cb.checked = this.keepFile[i]!;
			cb.addEventListener("change", () => {
				this.keepFile[i] = cb.checked;
				if (planBtn) {
					planBtn.setText(label());
					planBtn.disabled = count() === 0;
				}
			});
			head.createSpan({ cls: "splitsmith-title", text: p.file.path });
			head.createSpan({ cls: "splitsmith-muted", text: p.status === "new" ? "New" : "Changed" });
		});
		const status = contentEl.createEl("p", { cls: "splitsmith-status" });
		new Setting(contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) => {
				planBtn = b.buttonEl;
				b.setButtonText(label())
					.setCta()
					.onClick(async () => {
						const preset = this.preset();
						if (!preset) return;
						b.setDisabled(true);
						const files = this.o.pending.filter((_, i) => this.keepFile[i]).map((p) => p.file);
						status.setText("Planning…");
						try {
							this.plans = await this.o.plan(files, preset, (done, total) => status.setText(`Planning ${done} of ${total}…`));
						} catch (e) {
							status.setText(e instanceof Error ? e.message : "Planning failed. Nothing was changed.");
							status.addClass("is-error");
							b.setDisabled(false);
							return;
						}
						this.keepNote = this.plans.map((p) => !!p.plan);
						this.keepPart = this.plans.map((p) => (p.plan ? p.plan.parts.map(() => true) : []));
						this.drawReview();
					});
			});
	}

	private drawReview(): void {
		const { contentEl } = this;
		contentEl.empty();
		this.setTitle("Review the batch");
		contentEl.createEl("p", {
			cls: "splitsmith-muted",
			text: "Each part moves into its own note exactly as written. Untick a note to leave it for later, or a part to leave it in its note. Nothing is written until you select create. If any note fails, the whole batch is undone.",
		});
		const list = contentEl.createDiv({ cls: "splitsmith-part-list" });
		this.plans.forEach((p, i) => {
			const box = list.createDiv({ cls: "splitsmith-part" });
			const head = box.createDiv({ cls: "splitsmith-part-head" });
			if (!p.plan) {
				head.createSpan({ cls: "splitsmith-title", text: p.file.path });
				head.createSpan({ cls: "splitsmith-muted", text: p.skip?.reason ?? "Skipped" });
				return;
			}
			const plan = p.plan;
			const cb = head.createEl("input", { type: "checkbox" });
			cb.checked = this.keepNote[i]!;
			cb.addEventListener("change", () => {
				this.keepNote[i] = cb.checked;
				box.toggleClass("is-dropped", !cb.checked);
				this.refresh();
			});
			head.createSpan({ cls: "splitsmith-title", text: p.file.path });
			head.createSpan({ cls: "splitsmith-muted", text: plan.parts.length === 1 ? "1 part" : `${plan.parts.length} parts` });
			plan.parts.forEach((part, k) => {
				const row = box.createDiv({ cls: "splitsmith-part-head" });
				const pc = row.createEl("input", { type: "checkbox" });
				pc.checked = this.keepPart[i]![k]!;
				pc.addEventListener("change", () => {
					this.keepPart[i]![k] = pc.checked;
					this.refresh();
				});
				const title = row.createEl("input", { type: "text", cls: "splitsmith-title" });
				title.value = part.title;
				title.addEventListener("input", () => {
					part.title = title.value;
					this.refresh();
				});
				const body = partBody(plan, k);
				const lines = body.split("\n").length - (body.endsWith("\n") ? 1 : 0);
				row.createSpan({ cls: "splitsmith-muted", text: lines === 1 ? "1 line" : `${lines} lines` });
			});
		});
		const nothing = this.plans.filter((p) => p.skip?.kind === "nothing").length;
		if (nothing) {
			contentEl.createEl("p", {
				cls: "splitsmith-muted",
				text: `${nothing === 1 ? "1 note has" : `${nothing} notes have`} nothing to split with this preset. ${nothing === 1 ? "It is" : "They are"} marked as done when you create the batch, and listed again if ${nothing === 1 ? "it changes" : "they change"}.`,
			});
		}
		this.statusEl = contentEl.createEl("p", { cls: "splitsmith-status" });
		new Setting(contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) => {
				this.button = b.buttonEl;
				b.setCta().onClick(async () => {
					const preset = this.preset();
					if (!preset) return;
					const chosen = chosenBatch(this.plans, this.keepNote, this.keepPart);
					const none = this.plans.filter((p) => p.skip?.kind === "nothing").map((p) => p.file);
					b.setDisabled(true);
					this.close();
					await this.o.onApply(chosen, none, preset);
				});
			});
		this.refresh();
	}

	private refresh(): void {
		const chosen = chosenBatch(this.plans, this.keepNote, this.keepPart);
		const parts = chosen.reduce((n, c) => n + c.plan.parts.length, 0);
		const failed = chosen.find((c) => !verifyLossless(c.plan.raw, render(c.plan, (i) => `[[${i}]]`, () => "")).ok);
		const nothing = this.plans.some((p) => p.skip?.kind === "nothing");
		const ok = !failed && (chosen.length > 0 || nothing);
		if (this.statusEl) {
			this.statusEl.setText(
				failed
					? `Lossless check failed for ${failed.file.path}. Untick it to continue.`
					: chosen.length
						? `Lossless check passed for ${chosen.length === 1 ? "1 note" : `${chosen.length} notes`}: putting the new notes back in place of their links gives each original note exactly.`
						: nothing
							? "Nothing to split. Select done to mark these notes as done."
							: "Tick at least one note.",
			);
			this.statusEl.toggleClass("is-error", !ok);
		}
		if (this.button) {
			const n = chosen.length;
			this.button.setText(n ? `Create ${parts === 1 ? "1 note" : `${parts} notes`} from ${n === 1 ? "1 note" : `${n} notes`}` : "Done");
			this.button.disabled = !ok;
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
