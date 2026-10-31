/* Shared mocked-Obsidian app for plugin, gate 1 and property tests. */
import { MockFileManager, MockVault, TFile } from "./obsidian-mock";
import type { SplitOptions } from "../src/core/apply";

export const SRC = "Notes/Big.md";
export const NOTE = "---\r\ntags: [project]\r\naliases: [Big]\r\n---\r\nIntro ^intro\r\n\r\n## Alpha\r\nalpha text ^blk1\r\n```\r\n## fake\r\n```\r\n\r\n## Beta ☕\r\n### Beta detail\r\nbeta text";

export function makeApp(files: Record<string, string> = {}, src = SRC) {
	const vault = new MockVault();
	for (const [k, v] of Object.entries(files)) vault.files.set(k, v);
	const links: Record<string, { link: string; original: string; displayText?: string; position: { start: { offset: number }; end: { offset: number } } }[]> = {};
	const embeds: typeof links = {};
	/** Index a link (or, with embed, an embed: Obsidian keeps those in cache.embeds) at its first occurrence. */
	const linkAt = (path: string, original: string, link: string, displayText?: string, embed = false) => {
		const t = vault.files.get(path)!;
		const start = t.indexOf(original);
		if (embed) links[path] ??= [];
		((embed ? embeds : links)[path] ??= []).push({ link, original, displayText, position: { start: { offset: start }, end: { offset: start + original.length } } });
	};
	/** Notes the metadata cache has not indexed yet (getFileCache returns null, not in resolvedLinks): a late index. */
	const unindexed = new Set<string>();
	/**
	 * Link resolution like Obsidian's getFirstLinkpathDest: the source's own name always resolves to the source;
	 * "./" and "../" paths only relative to the linking note's folder; other paths relative to that folder first,
	 * then from the vault root, then any file whose path ends with it. ".md" may be left off.
	 */
	const resolve = (lp: string, from: string): TFile | null => {
		if (lp === src.split("/").pop()!.replace(/\.md$/, "")) return new TFile(src);
		const has = (p: string) => (vault.files.has(p) ? p : vault.files.has(`${p}.md`) ? `${p}.md` : null);
		const dir = from.includes("/") ? from.slice(0, from.lastIndexOf("/")).split("/") : [];
		const rel = () => {
			const out = [...dir];
			for (const seg of lp.split("/")) {
				if (seg === "..") {
					if (!out.length) return null;
					out.pop();
				} else if (seg !== "." && seg !== "") out.push(seg);
			}
			return has(out.join("/"));
		};
		if (/^\.\.?\//.test(lp)) {
			const r = rel();
			return r ? new TFile(r) : null;
		}
		const hit = rel() ?? has(lp) ?? [...vault.files.keys()].find((p) => p.endsWith(`/${lp}`) || p.endsWith(`/${lp}.md`)) ?? null;
		return hit ? new TFile(hit) : null;
	};
	const app = {
		vault,
		fileManager: new MockFileManager(vault),
		workspace: { onLayoutReady: (fn: () => void) => fn(), getActiveFile: () => null, getActiveViewOfType: () => null },
		metadataCache: {
			getFileCache: (f: TFile) => (unindexed.has(f.path) ? null : f.path === src ? { frontmatter: { tags: ["project"], aliases: ["Big"] } } : { links: links[f.path] ?? [], embeds: embeds[f.path] ?? [] }),
			getFirstLinkpathDest: (lp: string, from = "") => resolve(lp, from),
			get resolvedLinks() {
				return Object.fromEntries(Object.keys(links).filter((p) => !unindexed.has(p)).map((p) => [p, { [src]: 1 }]));
			},
		},
		secretStorage: { getSecret: () => "sk-user-secret" },
	};
	return { app, vault, linkAt, unindexed };
}

export const OPTS: SplitOptions = { linkStyle: "link", folder: "", fileNameTemplate: "{{title}}", inherit: "tags", sourceProperty: "source", repairLinks: true };

