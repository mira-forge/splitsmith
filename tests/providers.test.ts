import { describe, expect, it } from "vitest";
import { buildRequest, complete, extractText, PRESETS, type HttpRequest, type ModelConfig } from "../src/ai/providers";

const cfg = (k: keyof typeof PRESETS, apiKey = "sk-test"): ModelConfig => ({ kind: PRESETS[k]!.kind, baseUrl: PRESETS[k]!.baseUrl, model: PRESETS[k]!.model, apiKey, temperature: 0.2 });

describe("buildRequest", () => {
	it("OpenAI", () => {
		const r = buildRequest(cfg("openai"), "s", "u");
		expect(r.url).toBe("https://api.openai.com/v1/chat/completions");
		expect(r.headers.authorization).toBe("Bearer sk-test");
	});
	it("OpenRouter", () => expect(buildRequest(cfg("openrouter"), "s", "u").url).toBe("https://openrouter.ai/api/v1/chat/completions"));
	it("Anthropic", () => {
		const r = buildRequest(cfg("anthropic"), "s", "u");
		expect(r.url).toBe("https://api.anthropic.com/v1/messages");
		expect(r.headers["x-api-key"]).toBe("sk-test");
		expect(JSON.parse(r.body!).system).toBe("s");
	});
	it("Ollama sends no key", () => {
		const r = buildRequest(cfg("ollama", ""), "s", "u");
		expect(r.url).toBe("http://localhost:11434/api/chat");
		expect(JSON.stringify(r.headers)).not.toMatch(/Bearer|x-api-key/);
		expect(JSON.parse(r.body!).stream).toBe(false);
	});
});

describe("extractText / complete", () => {
	it("reads each provider's reply shape", () => {
		expect(extractText("openai", { choices: [{ message: { content: "hi" } }] })).toBe("hi");
		expect(extractText("anthropic", { content: [{ type: "text", text: "hi" }] })).toBe("hi");
		expect(extractText("ollama", { message: { content: "hi" } })).toBe("hi");
		expect(() => extractText("openai", {})).toThrow();
	});
	it("only calls the configured endpoint, and maps errors", async () => {
		const seen: HttpRequest[] = [];
		const ok = await complete(async (r) => (seen.push(r), { status: 200, json: { choices: [{ message: { content: "x" } }] }, text: "" }), cfg("openai"), "s", "u");
		expect(ok).toBe("x");
		expect(seen.map((r) => new URL(r.url).host)).toEqual(["api.openai.com"]);
		await expect(complete(async () => ({ status: 401, json: {}, text: "" }), cfg("openai"), "s", "u")).rejects.toThrow(/API key/);
		await expect(complete(async () => { throw new Error("down"); }, cfg("ollama", ""), "s", "u")).rejects.toThrow(/Ollama running/);
		await expect(complete(async () => ({ status: 200, json: {}, text: "" }), cfg("openai", ""), "s", "u")).rejects.toThrow(/API key/);
	});
	it("on mobile, an unreachable Ollama (or any localhost model) explains what works instead", async () => {
		const down = async () => { throw new Error("net::ERR_CONNECTION_REFUSED"); };
		await expect(complete(down, cfg("ollama", ""), "s", "u", { mobile: true })).rejects.toThrow(/can't run on a phone or tablet.*cloud provider.*heading, delimiter/);
		const lmstudio = { ...cfg("openai", ""), baseUrl: "http://127.0.0.1:1234/v1" };
		await expect(complete(down, lmstudio, "s", "u", { mobile: true })).rejects.toThrow(/phone or tablet/);
		// A cloud provider on mobile, or Ollama on desktop, keeps the normal message.
		await expect(complete(down, cfg("openai"), "s", "u", { mobile: true })).rejects.toThrow(/^Could not reach api\.openai\.com\.$/);
		await expect(complete(down, cfg("ollama", ""), "s", "u", { mobile: false })).rejects.toThrow(/Is Ollama running\?$/);
	});
});
