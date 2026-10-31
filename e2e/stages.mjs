// Splitsmith Gate 3 real-Obsidian stages. Run by e2e/run_e2e.sh (needs CDP_PORT, W, SHOTS, XDISPLAY).
// Drives the real app through CDP: UI flows by clicking the plugin's own modals, the corpus through
// the plugin's own plan/apply/undo methods. All byte checks read the vault from disk on the Node side.
import fs from "node:fs"; import path from "node:path"; import crypto from "node:crypto"; import { spawn } from "node:child_process";
const PORT = process.env.CDP_PORT, W = process.env.W, SHOTS = process.env.SHOTS, VAULT = path.join(W, "vault");
const NOCORPUS = !!process.env.NOCORPUS;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (...a) => { const s = `[${((Date.now() - t0) / 1000).toFixed(1)}s] ${a.join(" ")}`; console.log(s); fs.appendFileSync(path.join(W, "stages.log"), s + "\n"); };
const checks = []; const extra = {};
const check = (name, ok, detail = "") => { checks.push({ name, ok: !!ok, detail }); log(ok ? "PASS" : "FAIL", name, detail ? `(${String(detail).slice(0, 300)})` : ""); };

let ws, cid = 0; const pend = new Map(); const net = [];
async function connect() {
  for (let i = 0; i < 120; i++) {
    try {
      const list = (await (await fetch(`http://localhost:${PORT}/json`)).json()).filter((t) => t.type === "page");
      const main = list.find((t) => / - Obsidian /.test(t.title) && !t.title.startsWith("Settings"));
      if (main) {
        for (const t of list) if (t.id !== main.id) await fetch(`http://localhost:${PORT}/json/close/${t.id}`).catch(() => {});
        ws = new WebSocket(main.webSocketDebuggerUrl);
        ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id) { pend.get(d.id)?.(d); pend.delete(d.id); } else if (d.method === "Network.requestWillBeSent") net.push(d.params.request.url); };
        await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
        await call("Network.enable", {});
        await call("Page.enable", {});
        // Size the real window so screenshots and the GIF are 1280x800 (no window manager in Xvfb, so xdotool).
        if (process.env.XDISPLAY) await new Promise((r) => spawn("bash", ["-c", `for w in $(xdotool search --name ' - Obsidian 1'); do xdotool windowmove $w 0 0 windowsize $w 1280 800; done`], { env: { ...process.env, DISPLAY: process.env.XDISPLAY }, stdio: "ignore" }).on("exit", r));
        await sleep(300);
        return;
      }
    } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error("no Obsidian page");
}
const call = (method, params) => new Promise((r) => { const i = ++cid; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
async function ev(body, timeout = 120000) {
  const res = await Promise.race([
    call("Runtime.evaluate", { expression: `(async()=>{${body}})()`, awaitPromise: true, returnByValue: true }),
    sleep(timeout).then(() => ({ timeout: true })),
  ]);
  if (res.timeout) throw new Error("eval timeout: " + body.slice(0, 80));
  if (res.result?.exceptionDetails) throw new Error(res.result.exceptionDetails.exception?.description ?? "eval error");
  return res.result?.result?.value;
}
async function until(f, ms = 30000, step = 250) { const end = Date.now() + ms; while (Date.now() < end) { let v = null; try { v = await f(); } catch { v = null; } if (v) return v; await sleep(step); } return null; }
async function shot(name) { const s = await call("Page.captureScreenshot", { format: "png" }); const p = path.join(SHOTS, name); fs.writeFileSync(p, Buffer.from(s.result.data, "base64")); log("shot", p); return p; }

// Restricted Mode: Obsidian keeps "trusted" in localStorage. Clicking "Trust author" in this Xvfb box opens a
// popout that never finishes and freezes the renderer's event loop, so the trust flag is set and the window reloaded.
async function ready() {
  await connect();
  await until(() => ev("return !!(window.app && app.workspace && app.workspace.layoutReady)", 3000), 60000);
  const trusted = await ev(`return localStorage.getItem("enable-plugin-"+app.appId)==="true"`);
  if (!trusted || !(await ev(`return !!app.plugins.plugins.splitsmith`))) {
    await ev(`localStorage.setItem("enable-plugin-"+app.appId,"true"); setTimeout(()=>location.reload(),100); return 1`);
    await sleep(2500); ws.close(); await connect();
  }
  const ok = await until(() => ev("return !!(window.app && app.workspace.layoutReady && app.plugins.plugins.splitsmith && app.plugins.plugins.splitsmith.settings)", 3000), 60000);
  if (!ok) throw new Error("plugin did not load");
  await ev(`window.__t=0; setTimeout(()=>window.__t=1,10); await new Promise(r=>setTimeout(r,50)); return window.__t`).then((v) => { if (v !== 1) throw new Error("event loop stuck"); });
  await closeModals();
}
async function closeModals() {
  for (let i = 0; i < 4; i++) {
    if (!(await ev(`return !!document.querySelector(".modal-container")`))) return;
    for (const type of ["keyDown", "keyUp"]) await call("Input.dispatchKeyEvent", { type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await sleep(300);
  }
}
// Electron child windows (Settings, the Restricted Mode popout) start paused waiting for a debugger while
// remote debugging is on, and window.open blocks the main renderer until they run. Release them.
async function releaseChildren() {
  const list = (await (await fetch(`http://localhost:${PORT}/json`)).json()).filter((t) => t.type === "page" && !/ - Obsidian /.test(t.title) || (t.type === "page" && t.url === "about:blank"));
  for (const t of list) {
    if (!t.webSocketDebuggerUrl) continue;
    const c = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r, j) => { c.onopen = r; c.onerror = j; }).catch(() => null);
    if (c.readyState === 1) { c.send(JSON.stringify({ id: 1, method: "Runtime.runIfWaitingForDebugger" })); await sleep(200); c.close(); }
  }
}
async function restart() {
  ws.close(); fs.writeFileSync(path.join(W, "RESTART"), "");
  const ok = await until(() => fs.existsSync(path.join(W, "RESTARTED")), 60000, 250);
  if (!ok) throw new Error("restart did not happen"); fs.rmSync(path.join(W, "RESTARTED"));
  await sleep(1500); await ready();
}
function hashVault() {
  const out = {};
  const walk = (d, rel) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const r = rel ? `${rel}/${e.name}` : e.name; if (!rel && (e.name === ".obsidian" || e.name === ".trash")) continue; const p = path.join(d, e.name); if (e.isDirectory()) walk(p, r); else out[r] = crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex"); } };
  walk(VAULT, ""); return out;
}
function diffHash(a, b) { const d = []; for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if (a[k] !== b[k]) d.push(`${k}:${a[k] ? (b[k] ? "changed" : "missing") : "extra"}`); return d; }
const P = `const p=app.plugins.plugins.splitsmith; const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));`;
const notices = () => ev(`return [...document.querySelectorAll(".notice")].map(n=>n.innerText)`);
const clearNotices = () => ev(`document.querySelectorAll(".notice").forEach(n=>n.remove()); return 1`);
const clickText = (sel, re) => ev(`const el=[...document.querySelectorAll(${JSON.stringify(sel)})].find(e=>new RegExp(${JSON.stringify(re)}).test(e.innerText)); if(!el) return false; el.click(); return true`);
// Every link in a note resolves to an existing file, and its #heading or #^block exists there.
const linksResolve = (file) => ev(`
  await sleep(300); const f=app.vault.getFileByPath(${JSON.stringify(file)}); const c=app.metadataCache.getFileCache(f);
  const bad=[]; const all=[...(c.links||[]),...(c.embeds||[])];
  for(const l of all){ const [lp,sub]=l.link.split("#"); const d= lp==="" ? f : app.metadataCache.getFirstLinkpathDest(lp,f.path); if(!d){bad.push(l.original);continue;}
    if(sub){ const dc=app.metadataCache.getFileCache(d)||{}; const ok= sub.startsWith("^") ? !!(dc.blocks&&dc.blocks[sub.slice(1).toLowerCase()]) : (dc.headings||[]).some(h=>h.heading===sub); if(!ok) bad.push(l.original); } }
  return {n:all.length, bad, text: await app.vault.read(f)}`);

let rec = null;
function startGif() { if (!process.env.XDISPLAY) return; rec = spawn("ffmpeg", ["-y", "-loglevel", "error", "-f", "x11grab", "-framerate", "12", "-video_size", "1280x800", "-i", `${process.env.XDISPLAY}+0,0`, path.join(W, "demo.mp4")], { stdio: ["pipe", "ignore", "inherit"] }); }
async function stopGif() {
  if (!rec) return; rec.stdin.write("q"); await new Promise((r) => rec.on("exit", r)); rec = null;
  const mp4 = path.join(W, "demo.mp4"), gif = path.join(SHOTS, "splitsmith-demo.gif");
  await new Promise((r) => spawn("ffmpeg", ["-y", "-loglevel", "error", "-i", mp4, "-vf", "fps=10,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer", gif], { stdio: "inherit" }).on("exit", r));
  if (fs.existsSync(gif)) log("gif", gif, (fs.statSync(gif).size / 1024).toFixed(0) + "KB");
}

async function main() {
  await ready();
  const meta = await ev(`${P} return {ua: (navigator.userAgent.match(/obsidian\\/[\\d.]+/i)||[null])[0], version: p.manifest.version, commands: Object.keys(app.commands.commands).filter(c=>c.startsWith("splitsmith:")).sort(), licenseCode: "license" in p}`);
  extra.meta = meta; log("meta", JSON.stringify(meta));
  check("plugin loaded in real Obsidian, 8 commands registered (free-only, no license command)", meta.commands.length === 8 && !meta.commands.includes("splitsmith:activate-license"), meta.commands.join(","));
  check("free-only build: no license code loaded", meta.licenseCode === false);
  const H0 = hashVault();

  // --- Heading split through the UI (recorded for the GIF).
  await ev(`${P} app.workspace.getLeaf().openFile(app.vault.getFileByPath("Demo/Trip planning.md")); await sleep(800); return 1`);
  await clearNotices(); startGif(); await sleep(1200);
  await ev(`app.commands.executeCommandById("splitsmith:split-by-heading"); return 1`); await sleep(1200);
  const lv = await ev(`return [...document.querySelectorAll(".suggestion-item")].map(e=>e.innerText)`);
  check("level picker lists only levels that split (H1 holds the whole note, so it is left out)", JSON.stringify(lv) === JSON.stringify(["Heading 2 (##): 4 sections"]), JSON.stringify(lv));
  await clickText(".suggestion-item", "^Heading 2"); await sleep(2200);
  await shot("listing-1-preview.png");
  const btns = await ev(`return [...document.querySelectorAll(".splitsmith-preview button")].map(b=>b.innerText)`);
  check("preview offers Create 4 notes", btns.includes("Create 4 notes"), btns.join("|"));
  await clickText(".splitsmith-preview button", "^Create 4 notes$");
  const made = await until(() => ev(`${P} return p.settings.lastSplit?.created?.length ?? 0`), 15000);
  await sleep(1800); const n1 = await notices();
  check("heading split created 4 notes with an undo journal", made === 4, n1.join(" / "));
  await shot("listing-2-after-split.png");
  await ev(`${P} app.workspace.getLeaf().openFile(app.vault.getFileByPath("Demo/Packing list.md")); await sleep(1000); return 1`);
  await sleep(1500); await stopGif();
  const pl = await linksResolve("Demo/Packing list.md");
  check("link repair: every link in Packing list resolves (heading, block and alias links)", pl.n >= 3 && pl.bad.length === 0, `${pl.n} links, bad=${JSON.stringify(pl.bad)}`);
  extra.packingList = pl.text;
  const src = await linksResolve("Demo/Trip planning.md");
  check("source note links to every new note", src.n >= 4 && src.bad.length === 0, `${src.n} links`);
  // Gate 3 decisions 2-3: same-note links in the source and in the moved text, rewritten from our own parse.
  check("source: links to its own moved headings now point at the new notes (alias kept)", /\[\[Budget#Budget\|the budget\]\]/.test(src.text) && /\[Sintra tip\]\(Lisbon\.md#\^sintra\)/.test(src.text), src.text.split("\n").filter((l) => /budget|Sintra/.test(l)).join("⏎"));
  const lis = await linksResolve("Demo/Lisbon.md"), por = await linksResolve("Demo/Porto.md");
  check("new notes: [[#Heading]] links resolve (own note kept, other parts retargeted, image embed kept)", lis.bad.length === 0 && por.bad.length === 0 && /\[\[#Lisbon\]\]/.test(lis.text) && /\[\[Porto#Porto\]\]/.test(lis.text) && /!\[route\]\(assets\/route\.png\)/.test(por.text) && /\[\[Budget#Budget\]\]/.test(por.text), JSON.stringify({ lis: lis.bad, por: por.bad, l: lis.text.slice(0, 160), p: por.text.slice(-160) }));
  check("after-split notice has no unconfirmed links", !n1.some((t) => /Could not confirm/.test(t)), n1.join(" / "));
  await shot("e2e-packing-list-after-split.png");
  const journalOnDisk = JSON.parse(fs.readFileSync(path.join(VAULT, ".obsidian/plugins/splitsmith/data.json"), "utf8")).lastSplit;
  check("undo journal is in data.json on disk", journalOnDisk?.created?.length === 4);

  // --- Restart Obsidian, then undo.
  await restart();
  const canUndo = await ev(`return app.commands.commands["splitsmith:undo-last-split"].checkCallback(true)`);
  check("after restart: Undo last split is available", canUndo === true);
  await clearNotices();
  await ev(`app.commands.executeCommandById("splitsmith:undo-last-split"); return 1`);
  await until(() => ev(`${P} return p.settings.lastSplit===null`), 15000); await sleep(800);
  const n2 = await notices();
  check("after restart: undo restored the vault byte for byte", diffHash(H0, hashVault()).length === 0, diffHash(H0, hashVault()).join(",") || n2.join(" / "));

  // --- Delimiter split, undo without restart.
  await ev(`${P} await app.workspace.getLeaf().openFile(app.vault.getFileByPath("Demo/Research log.md")); await sleep(800); return 1`);
  await ev(`app.commands.executeCommandById("splitsmith:split-by-delimiter"); return 1`); await sleep(1000);
  const dbtn = await ev(`return [...document.querySelectorAll(".splitsmith-preview button")].map(b=>b.innerText).find(t=>/^Create/.test(t))`);
  await clickText(".splitsmith-preview button", "^Create");
  const dmade = await until(() => ev(`${P} return p.settings.lastSplit?.created?.length ?? 0`), 15000);
  check("delimiter split created notes", dmade >= 2, dbtn);
  await ev(`app.commands.executeCommandById("splitsmith:undo-last-split"); return 1`);
  await until(() => ev(`${P} return p.settings.lastSplit===null`), 15000); await sleep(500);
  check("delimiter undo restored the vault byte for byte", diffHash(H0, hashVault()).length === 0, diffHash(H0, hashVault()).join(","));

  // --- Inbox mode (free in this build).
  await clearNotices();
  await ev(`app.commands.executeCommandById("splitsmith:process-inbox"); return 1`); await sleep(1000);
  const folders = await ev(`return [...document.querySelectorAll(".suggestion-item")].map(e=>e.innerText)`);
  check("first run asks for the inbox folder", folders.includes("Inbox"), folders.join("|"));
  await clickText(".suggestion-item", "^Inbox$"); await sleep(1500);
  const step1 = await ev(`return document.querySelector(".modal")?.innerText ?? ""`);
  check("inbox lists the 5 new notes", (step1.match(/Inbox\//g) || []).length === 5, step1.slice(0, 200));
  await shot("listing-3-inbox-pick.png");
  await ev(`const b=[...document.querySelectorAll(".modal button.mod-cta")][0]; b.click(); return b.innerText`);
  await until(() => ev(`return /parts?\\b/.test(document.querySelector(".modal")?.innerText ?? "")`), 15000); await sleep(800);
  const step2 = await ev(`return document.querySelector(".modal")?.innerText ?? ""`);
  extra.inboxReview = step2.slice(0, 1500);
  await shot("listing-4-inbox-review.png");
  const cta = await ev(`const b=[...document.querySelectorAll(".modal button.mod-cta")][0]; const t=b.innerText; b.click(); return t`);
  const bjs = await until(() => ev(`${P} return p.settings.lastBatch?.journals?.length ?? 0`), 20000); await sleep(1500);
  const n3 = await notices();
  check("inbox batch applied", bjs >= 3, `${cta} -> ${n3.join(" / ")}`);
  check("inbox summary lists the notes with nothing to split", n3.some((t) => /Nothing to split in 2 notes, left untouched: (Garden links, Quick thought|Quick thought, Garden links)\./.test(t)), n3.join(" / "));
  const done = await ev(`${P} return Object.keys(p.settings.inboxDone).sort()`);
  check("inbox: notes with nothing to split are marked done", done.includes("Inbox/Quick thought.md") && done.includes("Inbox/Garden links.md"), done.join(","));
  const gl = await linksResolve("Inbox/Garden links.md");
  check("inbox: links into a split note were repaired", gl.n >= 2 && gl.bad.length === 0 && !/Garden log#May/.test(gl.text), gl.text.replace(/\n/g, "⏎").slice(0, 200));
  await clearNotices();
  await ev(`app.commands.executeCommandById("splitsmith:process-inbox"); return 1`); await sleep(1200);
  const n4 = await notices();
  check("inbox: second run says the inbox is clear (created notes are marked done)", n4.some((t) => /inbox is clear/.test(t)), n4.join(" / "));
  const Hb = hashVault();
  await restart();
  check("after restart: still no license code", (await ev(`${P} return "license" in p`)) === false);
  await clearNotices();
  await ev(`app.commands.executeCommandById("splitsmith:undo-last-split"); return 1`);
  await until(() => ev(`${P} return p.settings.lastBatch===null`), 20000); await sleep(800);
  const n5 = await notices();
  check("after restart: batch undo restored the vault byte for byte", diffHash(H0, hashVault()).length === 0, diffHash(H0, hashVault()).join(",") || n5.join(" / "));
  check("after restart: batch undo restored inbox state", (await ev(`${P} return Object.keys(p.settings.inboxDone).length`)) === 0 && diffHash(Hb, hashVault()).length > 0);

  // --- Settings screenshot. Obsidian 1.14 opens Settings in its own window (a child page).
  await ev(`setTimeout(()=>{ app.setting.open(); app.setting.openTabById("splitsmith"); }, 0); return 1`);
  const sp = await until(async () => { await releaseChildren(); const l = (await (await fetch(`http://localhost:${PORT}/json`)).json()).filter((t) => t.type === "page" && /^Settings/.test(t.title)); return l[0]; }, 20000, 500);
  const stxt = await ev(`return app.setting.activeTab?.id + " " + (app.setting.activeTab?.containerEl?.innerText ?? "").slice(0, 200)`);
  check("settings window opens on the Splitsmith tab", !!sp && /^splitsmith /.test(stxt), stxt.slice(0, 120));
  if (sp) {
    await sleep(1500);
    const s2 = new WebSocket(sp.webSocketDebuggerUrl); await new Promise((r) => (s2.onopen = r));
    const r = await new Promise((res) => { s2.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id === 7) res(d); }; s2.send(JSON.stringify({ id: 7, method: "Page.captureScreenshot", params: { format: "png" } })); });
    s2.close(); const f = path.join(SHOTS, "listing-5-settings.png"); fs.writeFileSync(f, Buffer.from(r.result.data, "base64")); log("shot", f);
  }
  await ev(`setTimeout(()=>app.setting.close(),0); return 1`); await sleep(800);

  if (!NOCORPUS) await corpus();
  const net2 = net.filter((u) => !/^(app|file|data|blob|devtools|chrome-extension|capacitor):/.test(u));
  extra.networkRequests = net2;
  check("no network requests from the page during the whole run", net2.length === 0, net2.slice(0, 5).join(" "));
}

async function corpus() {
  const files = (await ev(`return app.vault.getMarkdownFiles().map(f=>f.path).filter(p=>!/^(Demo|Inbox)\\//.test(p)).sort()`));
  const Hc = hashVault();
  log("corpus notes", files.length);
  await ev(`${P}
  // Independent link check from Obsidian's own index: links in these notes whose target file, heading or block is missing.
  // Heading match exactly as Obsidian 1.14's resolveSubpath/stripHeading (read from the app): these characters blanked, whitespace collapsed, case-insensitive.
  // (Was letters-and-digits only, which also "resolved" GitHub-style slugs such as #handling-potential-failure that Obsidian never resolves.)
  const norm = (h) => h.replace(/[!"#$%&()*+,.\\/:;<=>?@[\\\\\\]^\`{|}~]/g, " ").replace(/\\s+/g, " ").trim().toLowerCase();
  window.__broken = (paths) => { const bad = []; for (const q of paths) { const f = app.vault.getFileByPath(q); const c = f && app.metadataCache.getFileCache(f); if (!c) { bad.push(q + " (not indexed)"); continue; }
    for (const l of [...(c.links ?? []), ...(c.embeds ?? [])]) { const k = l.link.indexOf("#"); const lp = k < 0 ? l.link : l.link.slice(0, k), sub = k < 0 ? "" : l.link.slice(k + 1);
      const d = lp === "" ? f : app.metadataCache.getFirstLinkpathDest(lp, q); if (!d) { bad.push(q + " -> " + l.original); continue; } if (!sub || d.extension !== "md") continue;
      const dc = app.metadataCache.getFileCache(d) ?? {}; const ok = sub.startsWith("^") ? !!(dc.blocks ?? {})[sub.slice(1).toLowerCase()] : (dc.headings ?? []).some((h) => norm(h.heading) === norm(sub.split("#").pop()));
      if (!ok) bad.push(q + " -> " + l.original); } } return bad; };
  // Table rows (lines starting with "|") and their cell counts, counting only unescaped pipes ("\\|" stays in its cell).
  window.__rows = (text) => text.split(/\\r?\\n/).filter((l) => l.trimStart().startsWith("|")).map((l) => (l.match(/(?<!\\\\)\\|/g) || []).length);
  // Rows whose cell count changed: per inbound note line by line (rows stay put), source plus new notes as a multiset (rows move).
  window.__cellDiff = (a, b) => { const h = new Map(); for (const n of a) h.set(n, (h.get(n) ?? 0) + 1); for (const n of b) h.set(n, (h.get(n) ?? 0) - 1); let d = 0; for (const v of h.values()) d += Math.abs(v); return Math.ceil(d / 2); };
  window.__settled = async (paths) => { const t0 = performance.now(); while (performance.now() - t0 < 4000) { if (paths.every((q) => { const f = app.vault.getFileByPath(q); const fc = app.metadataCache.fileCache; const c = f && (fc ? fc[q] : { mtime: f.stat.mtime }); return f && c && c.mtime === f.stat.mtime && app.metadataCache.getFileCache(f); })) return true; await sleep(40); } return false; };
  window.__one = async (path, preset, strict, folder) => {
    const f = app.vault.getFileByPath(path); const before = await app.vault.adapter.read(path);
    let pl; const t = performance.now();
    try { pl = (await p.planInbox([f], preset))[0]; } catch (e) { return {r:"plan-throw", reason:String(e)}; }
    if (!pl.plan) return {r: pl.skip.kind, reason: pl.skip.reason};
    const opts = strict ? {folder:"", fileNameTemplate:p.settings.fileNameTemplate, inherit:"none", sourceProperty:"", repairLinks:false, linkStyle:"link"}
      : folder ? {folder, fileNameTemplate:p.settings.fileNameTemplate, inherit:p.settings.inherit, sourceProperty:p.settings.sourceProperty, repairLinks:true, linkStyle:"link"} : undefined;
    // Baseline for the independent check: links in the source that were already broken before the split.
    const base = strict ? null : window.__broken([path]).length;
    const inBase = {}; if (!strict) for (const [q, t] of Object.entries(app.metadataCache.resolvedLinks)) if (t[path] && q !== path) inBase[q] = window.__broken([q]);
    const rowsBefore = {}; if (!strict) { rowsBefore[path] = window.__rows(before); for (const q of Object.keys(inBase)) rowsBefore[q] = window.__rows(await app.vault.adapter.read(q)); }
    p.settings.lastSplit = null; document.querySelectorAll(".notice").forEach(n=>n.remove());
    await p.apply(f, pl.plan, "link", opts);
    const j = p.settings.lastSplit;
    if (!j) return {r:"refused", reason:[...document.querySelectorAll(".notice")].map(n=>n.innerText).join(" / ").slice(0,200)};
    const out = {r:"split", parts: j.created.length, linkEdits: j.linkEdits.reduce((n,e)=>n+e.applied.length,0), ownEdits: (j.ownEdits ?? []).reduce((n,e)=>n+e.applied.length,0), ms: 0};
    const after = await app.vault.adapter.read(path);
    const notes = [...document.querySelectorAll(".notice")].map(n=>n.innerText).join(" / ");
    const um = /Could not confirm that (\\d+) link/.exec(notes); out.unverified = um ? +um[1] : 0; if (um) out.unverifiedMsg = notes.slice(0, 300);
    // Gate 3 decision 1: never move a whole note. After the split the source must keep something besides the links.
    { let rest = after.replace(/^---\\r?\\n[\\s\\S]*?\\r?\\n---\\r?\\n?/, ""); for (const c of j.created) { const cf = app.vault.getFileByPath(c.path); rest = rest.split(app.fileManager.generateMarkdownLink(cf, path)).join(""); } out.allMoved = rest.trim() === ""; out.wholeMove = out.allMoved && j.created.length === 1; }
    if (!strict) {
      const all = [path, ...j.created.map(c=>c.path)];
      out.settled = await window.__settled([...all, ...j.linkEdits.map(e=>e.path)]);
      const bad = window.__broken(all); out.newlyBroken = bad.length - base; if (out.newlyBroken > 0) out.brokenSample = bad.slice(0, 4).join(" | ");
      // Inbound notes: links broken now that were not broken before the split (same note, same link text or a rewrite of it).
      let ibn = 0; const ibs = [];
      for (const q of Object.keys(inBase)) { const now = window.__broken([q]); const extra = now.length - inBase[q].length; if (extra > 0) { ibn += extra; ibs.push(...now.filter(x => !inBase[q].includes(x)).slice(0, 2)); } }
      // Table structure (Gate 3 round 3): every note with edited links keeps the cell count of every table row.
      const edited = new Set([...j.linkEdits.map(e=>e.path), ...(j.ownEdits ?? []).map(e=>e.path)]);
      let cells = 0, rowsChecked = 0, esc = 0; const cs = [];
      if (edited.size) {
        const own = [path, ...j.created.map(c=>c.path)]; let aft = [];
        for (const q of own) { const t = await app.vault.adapter.read(q); aft = aft.concat(window.__rows(t)); esc += t.split("\\\\|").length - 1; }
        const d0 = window.__cellDiff(rowsBefore[path], aft); cells += d0; rowsChecked += rowsBefore[path].length; if (d0) cs.push(path);
        for (const q of edited) { if (q === path || own.includes(q)) continue; const t = await app.vault.adapter.read(q); const now = window.__rows(t); const was = rowsBefore[q] ?? window.__rows(t);
          esc += t.split("\\\\|").length - 1; rowsChecked += was.length; let d = 0; for (let k = 0; k < Math.max(was.length, now.length); k++) if (was[k] !== now[k]) d++; cells += d; if (d) cs.push(q); }
      }
      out.cellChanges = cells; out.rowsChecked = rowsChecked; out.escInEdited = esc; out.cellNotesChecked = edited.size ? edited.size + j.created.length + (edited.has(path) ? 0 : 1) : 0; if (cs.length) out.cellSample = cs.slice(0, 4).join(" | ");
      out.inboundBroken = ibn; if (ibs.length) out.brokenSample = [out.brokenSample, ibs.slice(0, 4).join(" | ")].filter(Boolean).join(" || ");
    }
    if (strict) {
      // Independent rebuild: replace each new note's link in the source with that note's content.
      let s = after, cur = 0, ok = true;
      for (const c of j.created) {
        const cf = app.vault.getFileByPath(c.path); const l = app.fileManager.generateMarkdownLink(cf, path);
        const i = s.indexOf(l, cur); if (i < 0) { ok = false; break; }
        const body = await app.vault.adapter.read(c.path);
        // The link takes the part's place plus the part's own last line break (see render() in plan.ts).
        const eol = (/\\r?\\n$/.exec(body) || [""])[0]; const len = l.length + (eol && s.startsWith(eol, i + l.length) ? eol.length : 0);
        s = s.slice(0, i) + body + s.slice(i + len); cur = i + body.length;
      }
      out.lossless = ok && s === before;
      if (!out.lossless) { out.why = ok ? "rebuild differs" : "link not found"; if (ok) { let k = 0; while (k < s.length && s[k] === before[k]) k++; out.at = k; out.got = JSON.stringify(s.slice(k, k + 60)); out.want = JSON.stringify(before.slice(k, k + 60)); } }
    }
    const touched = [path, ...j.linkEdits.map(e=>e.path)]; const pre = {};
    for (const q of touched) pre[q] = null;
    const created = j.created.map(c=>c.path);
    await p.undo();
    await sleep(30);
    if (p.settings.lastSplit) { out.undo = "refused"; out.undoMsg=[...document.querySelectorAll(".notice")].map(n=>n.innerText).join(" / ").slice(0,200); return out; }
    out.undo = (await app.vault.adapter.read(path)) === before ? "ok" : "source-differs";
    for (const c of created) if (await app.vault.adapter.exists(c)) out.undo = "created-left";
    out.ms = Math.round(performance.now() - t);
    // Let the metadata cache settle before the next note (it drives link repair).
    await new Promise(r => { const ref = app.metadataCache.on("resolved", () => { app.metadataCache.offref(ref); r(); }); setTimeout(() => { app.metadataCache.offref(ref); r(); }, 400); });
    return out;
  }; return 1`);
  const modes = [
    { tag: "h1", preset: { id: "c1", name: "c h1", method: "heading", level: 1 } },
    { tag: "h2", preset: { id: "c2", name: "c h2", method: "heading", level: 2 } },
    { tag: "h3", preset: { id: "c3", name: "c h3", method: "heading", level: 3 } },
    { tag: "delim", preset: { id: "cd", name: "c ---", method: "delimiter", delimiter: "---" } },
  ];
  const FOLDER = "Split out/deep";
  const base = { instructions: "", linkStyle: "link", folder: "", fileNameTemplate: "{{title}}", inherit: "none", delimiter: "---", level: 2 };
  // Strict passes: nothing added to new notes and no link repair, so the source rebuilds byte for byte.
  // Default passes: the shipped settings (tags copied, source property, link repair on) to exercise repair and its undo.
  const passes = [...modes.map((m) => ({ ...m, strict: true })), { tag: "h2-default", preset: modes[1].preset, strict: false }, { tag: "h3-default", preset: modes[2].preset, strict: false }, { tag: "h2-folder", preset: modes[1].preset, strict: false, folder: FOLDER }];
  const res = {}; const failures = [];
  for (const ps of passes) {
    const preset = { ...base, ...ps.preset };
    const tally = { cellChanges: 0, rowsChecked: 0, escInEdited: 0, cellNotesChecked: 0, notes: 0, split: 0, parts: 0, linkEdits: 0, ownEdits: 0, unverified: 0, wholeMove: 0, newlyBroken: 0, unsettled: 0, nothing: 0, error: 0, refused: 0, lossless: 0, undoOk: 0, reasons: {}, maxMs: 0, totalMs: 0 };
    for (let i = 0; i < files.length; i += 20) {
      const chunk = files.slice(i, i + 20);
      const rs = await ev(`const out=[]; for (const f of ${JSON.stringify(chunk)}) { try { out.push([f, await window.__one(f, ${JSON.stringify(preset)}, ${ps.strict}, ${JSON.stringify(ps.folder ?? "")})]); } catch(e) { out.push([f,{r:"throw", reason:String(e).slice(0,200)}]); } } return out`, 600000);
      for (const [f, r] of rs) {
        tally.notes++;
        if (r.r === "split") {
          tally.split++; tally.parts += r.parts; tally.linkEdits += r.linkEdits; tally.ownEdits += r.ownEdits; tally.unverified += r.unverified;
          if (r.unverified) failures.push({ pass: ps.tag, f, what: "unverified (reported)", msg: r.unverifiedMsg });
          if (r.wholeMove) { tally.wholeMove++; failures.push({ pass: ps.tag, f, what: "whole note moved" }); }
          if (r.settled === false) tally.unsettled++;
          if (r.allMoved && !r.wholeMove) tally.indexOnly = (tally.indexOnly ?? 0) + 1; // several notes, original keeps only their links: a normal split
          if (r.newlyBroken > 0 || r.inboundBroken > 0) { tally.newlyBroken += Math.max(0, r.newlyBroken) + (r.inboundBroken ?? 0); failures.push({ pass: ps.tag, f, what: "links broken by split", msg: `${r.newlyBroken} in source/new, ${r.inboundBroken} inbound: ${r.brokenSample ?? ""}` }); }
          if (!ps.strict) { tally.cellChanges += r.cellChanges ?? 0; tally.rowsChecked += r.rowsChecked ?? 0; tally.escInEdited += r.escInEdited ?? 0; tally.cellNotesChecked += r.cellNotesChecked ?? 0;
            if (r.cellChanges) failures.push({ pass: ps.tag, f, what: "table cells changed", msg: `${r.cellChanges} rows: ${r.cellSample ?? ""}` }); }
          tally.totalMs += r.ms; tally.maxMs = Math.max(tally.maxMs, r.ms);
          if (r.undo === "ok") tally.undoOk++; else failures.push({ pass: ps.tag, f, what: "undo " + r.undo, msg: r.undoMsg });
          if (ps.strict) { if (r.lossless) tally.lossless++; else failures.push({ pass: ps.tag, f, what: r.why, msg: `at ${r.at}: got ${r.got} want ${r.want}` }); }
        } else {
          tally[r.r] = (tally[r.r] ?? 0) + 1; if (r.reason) tally.reasons[r.reason] = (tally.reasons[r.reason] ?? 0) + 1;
          if (r.r === "refused" || r.r === "throw" || r.r === "plan-throw") failures.push({ pass: ps.tag, f, what: r.r, msg: r.reason });
        }
      }
      const d = diffHash(Hc, hashVault());
      if (d.length) { failures.push({ pass: ps.tag, f: `chunk@${i}`, what: "vault differs after undo", msg: d.slice(0, 5).join(",") }); log("VAULT DIFF", d.slice(0, 5).join(",")); }
    }
    res[ps.tag] = tally; log("corpus", ps.tag, JSON.stringify(tally));
  }
  const final = diffHash(Hc, hashVault());
  extra.corpus = { notes: files.length, passes: res, failures: failures.slice(0, 200), failureCount: failures.length };
  check(`corpus: ${files.length} real notes x ${passes.length} passes, every split undone, vault byte-identical at the end`, final.length === 0, final.slice(0, 5).join(","));
  const strictSplits = modes.reduce((n, m) => n + res[m.tag].split, 0), strictLossless = modes.reduce((n, m) => n + res[m.tag].lossless, 0);
  check(`corpus: every strict split rebuilds to the original text (${strictLossless}/${strictSplits})`, strictSplits > 0 && strictLossless === strictSplits);
  const undoOk = passes.reduce((n, p) => n + res[p.tag].undoOk, 0), splits = passes.reduce((n, p) => n + res[p.tag].split, 0);
  check(`corpus: every split undone cleanly (${undoOk}/${splits})`, undoOk === splits);
  const sum = (k) => passes.reduce((n, p) => n + (res[p.tag][k] ?? 0), 0);
  check(`corpus: no split moved a whole note into a new one (${sum("wholeMove")})`, sum("wholeMove") === 0);
  check(`corpus: delimiter pass leaves notes without "---" untouched (${res.delim.nothing} reported nothing to split)`, res.delim.nothing > 0);
  check(`corpus: independent index check finds no link broken by a split (${sum("newlyBroken")} across ${["h2-default", "h3-default", "h2-folder"].reduce((n, t) => n + res[t].split, 0)} splits)`, sum("newlyBroken") === 0, failures.filter((f) => f.what === "links broken by split").slice(0, 3).map((f) => `${f.f}: ${f.msg}`).join(" ; "));
  check(`corpus: new notes in another folder ("${FOLDER}") keep relative links working (${res["h2-folder"].split} splits, ${res["h2-folder"].ownEdits} own-parse rewrites)`, res["h2-folder"].split > 0 && !failures.some((f) => f.pass === "h2-folder" && f.what === "links broken by split"));
  const lr = ["h2-default", "h3-default", "h2-folder"]; const lsum = (k) => lr.reduce((n, t) => n + (res[t][k] ?? 0), 0);
  check(`corpus: table rows keep their cell count in every note with edited links (${lsum("cellChanges")} rows changed; ${lsum("rowsChecked")} rows in ${lsum("cellNotesChecked")} note checks, ${lsum("escInEdited")} escaped \\| after)`, lsum("cellChanges") === 0 && lsum("rowsChecked") > 0, failures.filter((f) => f.what === "table cells changed").slice(0, 3).map((f) => `${f.f}: ${f.msg}`).join(" ; "));
  extra.corpus.unverifiedReported = sum("unverified");
  check("corpus: no refusals or crashes", !failures.some((f) => /refused|throw/.test(f.what)), failures.filter((f) => /refused|throw/.test(f.what)).slice(0, 3).map((f) => `${f.f}: ${f.msg}`).join(" ; "));
}

try { await main(); } catch (e) { check("stage script ran to the end", false, String(e?.stack ?? e)); }
fs.writeFileSync(path.join(W, "results.json"), JSON.stringify({ at: new Date().toISOString(), commit: fs.readFileSync(path.join(W, "commit.txt"), "utf8").trim(), build: fs.readFileSync(path.join(W, "build.sha256"), "utf8").split(" ")[0], checks, ...extra }, null, 1));
const failed = checks.filter((c) => !c.ok).length;
fs.writeFileSync(path.join(W, "RESULT.txt"), `${checks.length - failed}/${checks.length} checks passed\n`);
log(`${checks.length - failed}/${checks.length} checks passed`);
try { ws?.close(); } catch {}
process.exit(failed ? 1 : 0);
