/** Counterexamples found by tests/property.test.ts, pinned so they stay fixed. */
import { describe, expect, it } from "vitest";
import { parseDoc } from "../src/core/sections";
import { validatePlan } from "../src/core/segment";
import { planFromParts } from "../src/core/plan";

describe("property-suite regressions", () => {
	// fast-check seed 20261030, AI-style mode, path 91:0:0:4:0:2:4:3:4:4:4. Unclosed front matter, then a line
	// that is only "\r": the part was whitespace to checkPlan (trim) but not to the blank-edge trim ([ \t]),
	// so a valid AI plan was refused with "A part is empty." Now whitespace-only parts stay in the source.
	it.each(["---\n\r\r\n", "a\n\u00a0\n", "a\n\u2028\n", "a\n\uFEFF\n", "x\n\r\r\n\r\r\n"])("whitespace-only AI part %j is left in the source, not an error", (raw) => {
		const doc = parseDoc(raw);
		const parts = validatePlan(doc, [{ title: "A", start: 0, end: 0 }, { title: "B", start: 1, end: doc.lines.length - 1 }], 4);
		const plan = planFromParts(doc, parts);
		// The one non-blank part is the whole note, so since Gate 3 the plan is empty ("Nothing to split"), still no error.
		expect(plan.parts).toEqual([]);
	});
});
