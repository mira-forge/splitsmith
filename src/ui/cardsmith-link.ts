import type { App, TFile } from "obsidian";

/** Cardsmith's plugin id and its listing in Obsidian's community plugin directory. */
export const CARDSMITH_ID = "cardsmith";
export const CARDSMITH_URL = "https://community.obsidian.md/plugins/cardsmith";
/** Cardsmith's "Generate flashcards from this note or selection" command. */
export const CARDSMITH_COMMAND = `${CARDSMITH_ID}:generate-note`;

/** Parts of App that Obsidian ships but does not type. Read defensively: they may be missing. */
interface AppInternals {
	plugins?: { enabledPlugins?: Set<string> };
	commands?: { executeCommandById?: (id: string) => boolean; commands?: Record<string, unknown> };
}

/** True when Cardsmith is installed and enabled in this vault. */
export function cardsmithEnabled(app: App): boolean {
	const enabled = (app as unknown as AppInternals).plugins?.enabledPlugins;
	return !!enabled && typeof enabled.has === "function" && enabled.has(CARDSMITH_ID);
}

/** The one-line link text, or null when the user turned the link off. */
export function cardsmithLinkText(app: App, show: boolean): string | null {
	if (!show) return null;
	return cardsmithEnabled(app) ? "Make flashcards with Cardsmith" : "Turn these notes into flashcards with Cardsmith";
}

/**
 * Runs only when the user selects the link. If Cardsmith is enabled, opens the first new note and
 * runs Cardsmith's generate command on it; otherwise (or if that fails) opens Cardsmith's listing.
 */
export async function openCardsmith(app: App, firstNote: TFile | null): Promise<"command" | "listing"> {
	if (cardsmithEnabled(app)) {
		const cmds = (app as unknown as AppInternals).commands;
		if (cmds?.executeCommandById && (!cmds.commands || CARDSMITH_COMMAND in cmds.commands)) {
			try {
				if (firstNote) await app.workspace.getLeaf(false).openFile(firstNote);
				if (cmds.executeCommandById(CARDSMITH_COMMAND)) return "command";
			} catch {
				// Fall through to the listing.
			}
		}
	}
	window.open(CARDSMITH_URL);
	return "listing";
}

/**
 * Builds the result notice body: the existing message, then one optional line with the link and
 * a "Don't show again" link. No new modal or pop-up; it lives inside the split's own notice.
 */
export function noticeWithCardsmithLink(
	message: string,
	link: string | null,
	onOpen: () => void,
	onDismiss: () => void,
): string | DocumentFragment {
	if (!link) return message;
	return createFragment((frag) => {
		frag.createSpan({ text: message });
		frag.createDiv({ cls: "splitsmith-cardsmith-link" }, (line) => {
			const a = line.createEl("a", { text: link, href: "#" });
			a.addEventListener("click", (e) => {
				e.preventDefault();
				onOpen();
			});
			line.createSpan({ text: " · " });
			const hide = line.createEl("a", { text: "Don't show again", href: "#" });
			hide.addEventListener("click", (e) => {
				e.preventDefault();
				onDismiss();
			});
		});
	});
}
