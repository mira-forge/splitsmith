import { App, FuzzySuggestModal } from "obsidian";

/** Pick which heading level to split at; only levels the note uses are offered. */
export class LevelModal extends FuzzySuggestModal<number> {
	constructor(
		app: App,
		private counts: number[],
		private onPick: (level: number) => void,
	) {
		super(app);
		this.setPlaceholder("Split at which heading level?");
	}
	getItems(): number[] {
		return [1, 2, 3, 4, 5, 6].filter((l) => (this.counts[l] ?? 0) > 0);
	}
	getItemText(l: number): string {
		const c = this.counts[l] ?? 0;
		return `Heading ${l} (${"#".repeat(l)}): ${c === 1 ? "1 section" : `${c} sections`}`;
	}
	onChooseItem(l: number): void {
		this.onPick(l);
	}
}
