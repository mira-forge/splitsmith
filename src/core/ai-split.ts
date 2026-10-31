import type { Doc, Part } from "./sections";
import { buildSegmentPrompt, dedupeTitles, parsePlan, validatePlan, windows } from "./segment";
import { MAX_AI_PARTS } from "../config";

export interface AiSplitOptions {
	instructions: string;
	language: string;
	windowChars: number;
	/** Sends one request to the user's own model and returns the raw reply. */
	ask: (system: string, user: string) => Promise<string>;
}

/**
 * Ask the model for boundaries and titles only, window by window, and validate every answer.
 * The model's reply is never used as note text; it only decides where the original lines are cut.
 */
export async function planWithAi(doc: Doc, o: AiSplitOptions): Promise<Part[]> {
	if (!doc.lines.some((l) => l.text.trim())) throw new Error("This note has no text to split.");
	const ws = windows(doc, o.windowChars);
	const cap = MAX_AI_PARTS;
	let remaining = cap;
	const all: Part[] = [];
	for (let k = 0; k < ws.length; k++) {
		const w = ws[k]!;
		const max = Math.max(1, remaining - (ws.length - k - 1));
		const { system, user } = buildSegmentPrompt(doc, {
			maxParts: max,
			window: w,
			language: o.language,
			instructions: o.instructions,
		});
		const reply = await o.ask(system, user);
		const parts = validatePlan(doc, parsePlan(reply), max, w);
		all.push(...parts);
		remaining -= parts.length;
	}
	// Whole-note check across windows: every line exactly once, in order, within the cap.
	validatePlan(doc, all, cap);
	return dedupeTitles(all);
}
