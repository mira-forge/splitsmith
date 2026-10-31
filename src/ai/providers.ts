/**
 * Bring-your-own-key model clients. Requests go straight from the user's device to
 * the provider they configured. Nothing is sent to Mira Forge.
 * The HTTP function is injected so the logic is testable without Obsidian.
 */

export type ProviderKind = "openai" | "anthropic" | "ollama";

export interface ModelConfig {
	kind: ProviderKind;
	/** OpenAI-compatible base URL, e.g. https://api.openai.com/v1 or https://openrouter.ai/api/v1 */
	baseUrl: string;
	model: string;
	apiKey: string; // empty for Ollama
	temperature: number;
}

export interface HttpRequest {
	url: string;
	method: "POST" | "GET";
	headers: Record<string, string>;
	body?: string;
}
export interface HttpResponse {
	status: number;
	json: unknown;
	text: string;
}
export type HttpFn = (req: HttpRequest) => Promise<HttpResponse>;

export const PRESETS: Record<string, { kind: ProviderKind; baseUrl: string; model: string; label: string }> = {
	openai: { kind: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-4.1-mini", label: "OpenAI" },
	openrouter: { kind: "openai", baseUrl: "https://openrouter.ai/api/v1", model: "openai/gpt-4.1-mini", label: "OpenRouter" },
	anthropic: { kind: "anthropic", baseUrl: "https://api.anthropic.com/v1", model: "claude-haiku-4-5", label: "Anthropic" },
	ollama: { kind: "ollama", baseUrl: "http://localhost:11434", model: "llama3.1", label: "Ollama (local)" },
	custom: { kind: "openai", baseUrl: "", model: "", label: "Other OpenAI-compatible" },
};

function trimSlash(u: string): string {
	return u.replace(/\/+$/, "");
}

export function buildRequest(cfg: ModelConfig, system: string, user: string): HttpRequest {
	const base = trimSlash(cfg.baseUrl);
	if (cfg.kind === "anthropic") {
		return {
			url: `${base || "https://api.anthropic.com/v1"}/messages`,
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-api-key": cfg.apiKey,
				"anthropic-version": "2023-06-01",
			},
			body: JSON.stringify({
				model: cfg.model,
				max_tokens: 4096,
				temperature: cfg.temperature,
				system,
				messages: [{ role: "user", content: user }],
			}),
		};
	}
	if (cfg.kind === "ollama") {
		return {
			url: `${base || "http://localhost:11434"}/api/chat`,
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: cfg.model,
				stream: false,
				format: "json",
				options: { temperature: cfg.temperature },
				messages: [
					{ role: "system", content: system },
					{ role: "user", content: user },
				],
			}),
		};
	}
	const headers: Record<string, string> = { "content-type": "application/json" };
	if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
	if (base.includes("openrouter.ai")) {
		headers["HTTP-Referer"] = "https://miraforge.itch.io";
		headers["X-Title"] = "Splitsmith for Obsidian";
	}
	return {
		url: `${base}/chat/completions`,
		method: "POST",
		headers,
		body: JSON.stringify({
			model: cfg.model,
			temperature: cfg.temperature,
			messages: [
				{ role: "system", content: system },
				{ role: "user", content: user },
			],
		}),
	};
}

export function extractText(kind: ProviderKind, json: unknown): string {
	const j = json as Record<string, unknown>;
	if (kind === "anthropic") {
		const content = j?.content as Array<{ type?: string; text?: string }> | undefined;
		const t = content?.filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
		if (t) return t;
	} else if (kind === "ollama") {
		const t = (j?.message as { content?: string } | undefined)?.content;
		if (t) return t;
	} else {
		const choices = j?.choices as Array<{ message?: { content?: string } }> | undefined;
		const t = choices?.[0]?.message?.content;
		if (t) return t;
	}
	throw new Error("The model reply was empty.");
}

export function describeError(status: number, json: unknown, text: string): string {
	const j = json as { error?: { message?: string } | string } | null;
	const msg = typeof j?.error === "string" ? j.error : j?.error?.message;
	if (status === 401 || status === 403) return "The provider rejected the API key. Check it in settings.";
	if (status === 404) return msg ? `Not found: ${msg}` : "Model or URL not found. Check the model name and base URL.";
	if (status === 429) return "The provider is rate limiting you or your credit ran out. Try again shortly.";
	return msg || `Request failed with status ${status}${text ? `: ${text.slice(0, 160)}` : ""}`;
}

/** Shown when a local model can't be reached from a phone or tablet: Ollama does not run on mobile. */
export const MOBILE_LOCAL_MODEL_HELP =
	"Ollama can't run on a phone or tablet. On mobile, choose a cloud provider with your own API key in Splitsmith settings, or use split by heading, delimiter, cursor or selection, which work everywhere without AI.";

const isLocalUrl = (u: string) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(u.trim());

export async function complete(http: HttpFn, cfg: ModelConfig, system: string, user: string, opts: { mobile?: boolean } = {}): Promise<string> {
	if (!cfg.model.trim()) throw new Error("Set a model name in Splitsmith settings.");
	if (cfg.kind !== "ollama" && !cfg.apiKey && !/localhost|127\.0\.0\.1/.test(cfg.baseUrl)) {
		throw new Error("Add your API key in Splitsmith settings, or switch to a local Ollama model.");
	}
	if (cfg.kind === "openai" && !cfg.baseUrl.trim()) throw new Error("Set the base URL for your provider.");
	const req = buildRequest(cfg, system, user);
	let res: HttpResponse;
	try {
		res = await http(req);
	} catch {
		const host = new URL(req.url).host;
		if (opts.mobile && (cfg.kind === "ollama" || isLocalUrl(cfg.baseUrl))) throw new Error(`Could not reach ${host}. ${MOBILE_LOCAL_MODEL_HELP}`);
		const local = cfg.kind === "ollama" ? " Is Ollama running?" : "";
		throw new Error(`Could not reach ${host}.${local}`);
	}
	if (res.status >= 400) throw new Error(describeError(res.status, res.json, res.text));
	return extractText(cfg.kind, res.json);
}
