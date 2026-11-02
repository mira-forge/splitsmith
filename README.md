# Splitsmith

Split long notes into linked, atomic notes: by heading, by a delimiter such as `---`, at the cursor, or from a selection. You can also let an AI model (your own key, or a local Ollama model) suggest where to cut. Every split is previewed first. Splitsmith checks that the new notes rebuild your original character for character, and refuses the split if they don't. If link repair is on, it then updates links so they still resolve after the split, and Undo reverses those updates too.

> Splitsmith is free. Every feature is included: no account, no license key, no paid tier.

*Made by Mira Forge, an AI-run studio: Splitsmith's code is written and tested by AI agents ([details](#disclosures)).*

## Disclosures

- **Free.** Every feature described here is free. There is no paid tier, no license key and no account.
- **Network use.** Splitsmith only connects to **the AI provider you choose** (Ollama on your own machine by default, or OpenAI, Anthropic, OpenRouter or any OpenAI-compatible endpoint). This happens only when you run **AI split**. It sends the note's lines, numbered, plus instructions. The model sends back a plan only: where each part starts and ends, and a title. It never sends back note text, and any text it does return is ignored. Requests go straight from your device to that provider under your own account. Mira Forge never receives your notes or your API key.
  Nothing else: no analytics, no telemetry, no crash reporting, no update checks, and no ads loaded from the internet. One built-in exception: after a successful split, the notice shows an optional line suggesting Cardsmith, our flashcard plugin (see [Pair it with Cardsmith](#pair-it-with-cardsmith)). It's fixed text in the plugin, loads nothing, and you can turn it off. Selecting it either runs Cardsmith, if you have it, or opens its listing page in your browser.
- **Your API key stays on your device.** It is kept in Obsidian's secret storage (Settings → Keychain), not in your vault files or the plugin's `data.json`. It is only ever sent to the AI provider you chose, and never reaches Mira Forge.
- **Files.** Splitsmith only writes inside your vault, through Obsidian's API: the new notes, and links in the note you split. If link repair is on, it also updates links that would otherwise break: links in other notes that pointed at a heading or block that moved, links in the original note to its own moved headings and blocks, and links inside the moved text. It does not move attachments (images, PDFs and other files). Undo moves the new notes to Obsidian's trash. To make undo possible, the plugin's `data.json` keeps a copy of the text of the note(s) from your last split or last inbox batch, until the next one replaces it. Inbox mode also keeps, in `data.json`, the path of each note it has processed and a short fingerprint of its text (a hash and its length, not the text), so it can tell when a note has changed. `data.json` stays on your device, in your vault's config folder (usually `.obsidian`).
- **Made by AI agents.** Mira Forge is an AI-run studio: code is written and tested by AI agents. Splitsmith's code is not reviewed line by line by a human developer. Every change runs an automated test suite (including property tests on thousands of random notes and inbox batches) and is tested in a real copy of Obsidian. The source is readable and unminified; see `src/`.

## Features

- Split by heading level (H1–H6), by delimiter (`---` or your own), from the cursor down, or extract a selection, leaving a link.
- Preview: rename, merge or skip parts before anything is written.
- Lossless check: refuses any split that would change your note text.
- Undo the last split (or inbox batch), even after a restart.
- Repair links to moved headings and blocks.
- Copy tags (or all properties) to the new notes, with a link back.
- AI split: your model suggests the cuts and titles (up to 40 notes; long notes are sent in sections), with optional custom instructions. You review the plan.
- Inbox mode: pick a folder once, then split every new or changed note in it in one reviewed batch.
- Saved presets: a name, a split method and its options, ready to use in the inbox and on any note.

## How to use

1. Open a note and run one of these from the command palette:
   - **Split note by heading level**: pick a heading level. Each heading at that level starts a new note. Text before the first heading stays in the original.
   - **Split note by delimiter**: cuts at lines containing only the delimiter (default `---`, set in settings). The delimiter lines stay in the original. Front matter, code blocks, `%%` comment blocks, `$$` math blocks and setext headings are left alone. Headings inside code, comment and math blocks never start a new note.
   - **Move this line and everything below it to a new note**
   - **Extract selection to a new note**
   - **Split note with AI (preview first)**
2. In the preview, rename, untick or merge parts and choose links or embeds. The preview shows the lossless check. **Create notes** is only enabled when the check passes. Before anything is written, the lossless check puts each new note's text back in place of its link in the shortened note and compares the result with your original note, character for character. The properties Splitsmith adds at the top of new notes (copied tags, a link back) are not part of that comparison, and neither are the link updates described in step 3. Splitsmith runs the check again on the final text just before writing.
3. Splitsmith creates the notes, reads each one back to confirm it holds exactly the planned text, and only then replaces each moved part in the original with a link (`[[Part]]`) or an embed (`![[Part]]`). Line endings (LF or CRLF) are kept. If link repair is on, links are then updated where the split would break them:
   - In the original note, a link to one of its own headings or blocks that moved, such as `[[#Budget]]` or `[[#Budget|the budget]]`, becomes `[[Budget#Budget]]` (the alias is kept).
   - In the new notes, `[[#Heading]]` and `[[#^block]]` links to text that is now in another note are pointed at that note. Links to headings in the same new note are left as they are.
   - Relative Markdown links in moved text, such as `[map](assets/map.png)` or `[x](../other.md)`, are rewritten relative to the new note's folder when the new notes go to a different folder. Attachments stay where they are.
   - Links in other notes to moved headings and blocks are updated.

   Splitsmith works these out from its own reading of the text, so it does not depend on Obsidian having indexed the new notes yet. Afterwards it checks every link it touched and lists any it could not confirm, so you can check them by hand. **Undo last split** reverses every one of these updates. If anything fails before the original is changed, the new notes go to the trash and nothing else changes. If updating links in other notes fails afterwards, Splitsmith says the split is done but link repair failed, and **Undo last split** still reverses everything, including links it already updated.
4. Changed your mind? Run **Undo last split**. Undo still works after you restart Obsidian, and restores the note exactly. It refuses if you have edited the original or a new note since, so it never throws away your edits.

If a note has nothing to split (no delimiter, or a single section that holds the whole note), Splitsmith says so and changes nothing. It never moves a whole note into a new one. A delimiter split must produce at least two notes: if it would produce only one (for example a note with a single `---` and text on one side only), Splitsmith shows "Nothing to split here" and changes nothing. This applies in Inbox mode too, where such notes are listed as "Nothing to split" and left untouched.

### Saved presets and Inbox mode

- **Presets:** in **Settings → Splitsmith → Inbox and presets**, add a preset: a name, a split method (heading level, delimiter, or AI with its own instructions) and its options (links, embeds or no links, folder for new notes, file name template, properties to copy). Run **Split note with a preset** on any note to use one. The preview works as usual.
- **Inbox:** run **Process inbox: split new and changed notes** (or select the inbox icon in the ribbon). The first time, pick your inbox folder, for example daily notes or web clips. Splitsmith lists the notes in that folder (and its subfolders) that it has not split yet, or that changed since. Untick any you want to leave, pick a preset and select **Plan**. Nothing is written yet.
- **Review:** you see every note's parts. Untick a note or a part, or rename a part. Notes the preset finds nothing to split in are listed and left untouched; the summary after the batch names them too. Creating the batch marks them as done in `data.json` (their files are not changed), and they come back if they change. **Create** is only enabled when the lossless check passes for every ticked note.
- **One batch, all or nothing:** each note goes through the same split as above (lossless check, read-back, undo record). If any note fails, the notes already split in that batch are undone, so the vault is left as it was. If one of them cannot be undone because you edited it during the run, Splitsmith stops, keeps your edit and tells you which splits are still in place; **Undo last split** can undo them later. If a note changes after you review it, the batch is refused and undone, except for link updates Splitsmith itself made to it earlier in the same batch.
- **Undo last split** reverses the whole batch, newest note first, and lists those notes in the inbox again.
- With an AI preset, planning sends each note to your AI provider (one request per note, or per section for long notes), exactly as AI split does.

### AI split setup

In **Settings → Splitsmith**, choose a provider:
- **Ollama (local, free, default for new installs):** install [Ollama](https://ollama.com), run `ollama pull llama3.1`, and keep the base URL `http://localhost:11434`. Nothing leaves your computer.
- **OpenAI, Anthropic or OpenRouter:** pick the provider and link your API key in Obsidian's keychain.

The plan is checked before you see it. Splitsmith rejects plans that skip lines, overlap, cut through a code block, or exceed the part limit.

### On mobile

Splitsmith is not marked desktop-only, so Obsidian lets you install it on iOS and Android, but it has not been tested on a real phone or tablet yet; all testing so far is on desktop Obsidian on Linux only; Windows and macOS untested. The non-AI splits, the preview, the lossless check, undo and link repair use the same code as on desktop. AI split is meant to work on mobile with a cloud provider and your own API key (OpenAI, Anthropic, OpenRouter or another OpenAI-compatible endpoint). Ollama does not run on phones or tablets, so with the Ollama setting AI split on mobile shows a message explaining this and changes nothing.

## Pair it with Cardsmith

Split notes, then make cards. [Cardsmith](https://community.obsidian.md/plugins/cardsmith), also by Mira Forge, turns a note into flashcards you review in Obsidian or export to Anki. Atomic notes from Splitsmith make focused card sets.

- Cardsmith is a separate plugin, free for single notes (up to 10 cards each) with your own AI key or Ollama, plus one free folder run of up to 5 notes per vault; an optional paid upgrade adds whole folders and up to 50 cards per note. Splitsmith itself stays free and works the same with or without it.
- After a successful split, Splitsmith's notice adds one line: **Turn these notes into flashcards with Cardsmith** (or **Make flashcards with Cardsmith** if it's installed and enabled, which opens the first new note and runs Cardsmith on it). It never appears at startup, on failed splits or as a pop-up.
- To hide it, select **Don't show again** in the notice, or turn off **Settings → Splitsmith → Show a suggestion for Cardsmith after a split**.

## Known limitations

- **Footnotes:** a footnote definition (`[^1]: ...`) stays wherever it was. If a part uses `[^1]` and the definition is in another part or left in the original, the footnote shows as plain text in the new note. Check the preview and move definitions by hand, or keep them in the same section as their reference.
- **Same-note links:** links like `[[#Heading]]` or `[[#^block]]` are updated only when link repair is on (see **How to use**). With it off, they are moved unchanged, so they break if the heading or block ended up in a different note. Links inside front matter properties are never updated. A Markdown-style link in another note that Obsidian has not indexed yet is not updated; Splitsmith lists it as a link it could not confirm.
- **Attachments are not moved.** Images and other files stay in their folders. Embeds and relative links in moved text are rewritten so they still point at them.
- **No templates for new notes.** New notes get the moved text plus, if you choose, copied tags or properties and a link back to the original. Splitsmith does not apply note templates or front matter templates.
- **Mobile is untested on real devices.** See **On mobile**.
- **Undo covers the last split (or the last inbox batch) only.** If you rename or move one of the new notes, Undo leaves that note in place, so its text then exists twice (once restored in the original, once in the renamed note). Nothing is deleted.
- **Inbox change detection** uses a short fingerprint of each note's text. In the very unlikely case that a changed note has the same fingerprint, it is not listed again; nothing is changed or lost.
- **Inbox link updates:** if link repair is on, a split can update links in other notes in the inbox folder. Those notes then count as changed and are listed again.
- **File names:** titles are cleaned for every platform: characters Obsidian does not allow become spaces, trailing dots and spaces are removed, Windows device names such as `CON` or `NUL` get an underscore (`CON_`), and names are cut at 120 characters.

## Privacy

Splitsmith talks to no Mira Forge server. Your AI provider processes the text you send under its own terms. Full details: [privacy policy](https://miraforge-site.pages.dev/privacy/#splitsmith), [terms](https://miraforge-site.pages.dev/terms/).

## Development

```bash
npm install
npm run dev        # watch build
npm run build      # type-check + bundle main.js (not minified)
npm test           # unit + property tests with a mocked Obsidian API
npm run lint       # eslint-plugin-obsidianmd
```

## Support

Email heymira@mail.grokbot.com.

## License

MIT © 2026 Mira Forge
