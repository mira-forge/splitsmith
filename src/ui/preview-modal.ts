import { App, Modal, Setting } from "obsidian";
import { dropPart, mergeWithNext, partBody, render, verifyLossless, type SplitPlan } from "../core/plan";
import { safeTitle } from "../core/sections";
import type { LinkStyle } from "../core/apply";

export interface PreviewOptions {
	heading: string;
	/** Extra line under the heading, e.g. the AI dry-run notice. */
	note?: string;
	plan: SplitPlan;
	linkStyle: LinkStyle;
	onApply: (plan: SplitPlan, linkStyle: LinkStyle) => Promise<void>;
}

/** Shows every part before anything is written. Rename, merge with the next part, or leave a part in the note. */
export class PreviewModal extends Modal {
	private plan: SplitPlan;
	private keep: boolean[];
	private linkStyle: LinkStyle;
	private listEl: HTMLElement | null = null;
	private statusEl: HTMLElement | null = null;
	private button: HTMLButtonElement | null = null;

	constructor(
		app: App,
		private o: PreviewOptions,
	) {
		super(app);
		this.plan = o.plan;
		this.keep = o.plan.parts.map(() => true);
		this.linkStyle = o.linkStyle;
	}

	onOpen(): void {
		this.modalEl.addClass("splitsmith-preview");
		this.setTitle(this.o.heading);
		const { contentEl } = this;
		if (this.o.note) contentEl.createEl("p", { cls: "splitsmith-muted", text: this.o.note });
		contentEl.createEl("p", {
			cls: "splitsmith-muted",
			text: "Each part moves into its own note exactly as written. Untick a part to leave it in this note. Nothing is written until you select create.",
		});
		this.listEl = contentEl.createDiv({ cls: "splitsmith-part-list" });
		new Setting(contentEl).setName("In this note, replace each part with").addDropdown((d) =>
			d
				.addOption("link", "A link")
				.addOption("embed", "An embed")
				.addOption("none", "Nothing")
				.setValue(this.linkStyle)
				.onChange((v) => {
					this.linkStyle = v as LinkStyle;
					this.refresh();
				}),
		);
		this.statusEl = contentEl.createEl("p", { cls: "splitsmith-status" });
		new Setting(contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) => {
				this.button = b.buttonEl;
				b.setCta().onClick(async () => {
					const plan = this.chosen();
					b.setDisabled(true);
					this.close();
					await this.o.onApply(plan, this.linkStyle);
				});
			});
		this.drawList();
	}

	/** Plan with only the ticked parts, titles cleaned. */
	chosen(): SplitPlan {
		let p = this.plan;
		for (let i = this.keep.length - 1; i >= 0; i--) if (!this.keep[i]) p = dropPart(p, i);
		return { ...p, parts: p.parts.map((x) => ({ ...x, title: safeTitle(x.title) })) };
	}

	private drawList(): void {
		const list = this.listEl;
		if (!list) return;
		list.empty();
		this.plan.parts.forEach((part, i) => {
			const body = partBody(this.plan, i);
			const row = list.createDiv({ cls: "splitsmith-part" });
			row.toggleClass("is-dropped", !this.keep[i]);
			const head = row.createDiv({ cls: "splitsmith-part-head" });
			const cb = head.createEl("input", { type: "checkbox" });
			cb.checked = this.keep[i]!;
			cb.addEventListener("change", () => {
				this.keep[i] = cb.checked;
				row.toggleClass("is-dropped", !cb.checked);
				this.refresh();
			});
			const title = head.createEl("input", { type: "text", cls: "splitsmith-title" });
			title.value = part.title;
			title.addEventListener("input", () => {
				part.title = title.value;
				this.refresh();
			});
			const lines = body.split("\n").length - (body.endsWith("\n") ? 1 : 0);
			head.createSpan({ cls: "splitsmith-muted", text: lines === 1 ? "1 line" : `${lines} lines` });
			if (i < this.plan.parts.length - 1) {
				const merge = head.createEl("button", { text: "Merge with next" });
				merge.addEventListener("click", () => {
					this.plan = mergeWithNext(this.plan, i);
					this.keep.splice(i + 1, 1);
					this.drawList();
				});
			}
			const snippet = body.split(/\r?\n/).filter((l) => l.trim()).slice(0, 3).join("\n");
			row.createEl("pre", { cls: "splitsmith-snippet", text: snippet.length > 300 ? snippet.slice(0, 300) + "…" : snippet });
		});
		this.refresh();
	}

	private refresh(): void {
		const plan = this.chosen();
		const n = plan.parts.length;
		const check = n ? verifyLossless(plan.raw, render(plan, (i) => (this.linkStyle === "none" ? "" : `[[${i}]]`), () => "")) : { ok: false as const, reason: "Tick at least one part." };
		if (this.statusEl) {
			this.statusEl.setText(check.ok ? `Lossless check passed: ${n === 1 ? "1 new note" : `${n} new notes`}. Putting them back in place of their links gives your original note text exactly.` : check.reason);
			this.statusEl.toggleClass("is-error", !check.ok);
		}
		if (this.button) {
			this.button.setText(n === 1 ? "Create 1 note" : `Create ${n} notes`);
			this.button.disabled = !check.ok;
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
