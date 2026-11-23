#!/usr/bin/env node
// ============================================================
// MuseWeaver headless Chromium audit.
// Zero-dependency CDP check: serves the repo on an ephemeral
// localhost port, drives a throwaway headless Chrome profile,
// verifies zero console errors / exceptions / external requests
// / horizontal overflow, performs real pointer clicks on every
// lab control and round-trips the #mw= hash through a reload.
// Always cleans up server, browser and scratch profile.
// ============================================================
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, existsSync, mkdtempSync, rmSync, readdirSync } from "node:fs";
import { join, resolve, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8"
};
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser"
].filter(Boolean);
const VIEWPORTS = [
  { w: 1440, h: 900, name: "1440x900" },
  { w: 390, h: 844, name: "390x844" }
];

const results = [];
let consoleErrors = 0, exceptions = 0, logErrors = 0, externalReqs = 0;
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || "" });
  console.log((ok ? "PASS " : "FAIL ") + name + (detail ? "  " + detail : ""));
}

function findChrome() {
  for (const c of CHROME_CANDIDATES) if (existsSync(c)) return c;
  return null;
}

// ---------- tiny static server ----------
function startServer() {
  const srv = http.createServer((req, res) => {
    try {
      const url = new URL(req.url, "http://127.0.0.1");
      let p = decodeURIComponent(url.pathname);
      if (p === "/") p = "/index.html";
      const file = normalize(join(ROOT, p));
      if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
      const body = readFileSync(file);
      res.writeHead(200, { "Content-Type": MIME[extname(file)] || "application/octet-stream" });
      res.end(body);
    } catch (e) {
      res.writeHead(404); res.end();
    }
  });
  return new Promise((resolveP) => srv.listen(0, "127.0.0.1", () => resolveP(srv)));
}

// ---------- minimal CDP client ----------
class CDP {
  constructor(wsUrl) {
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    this.ws = new WebSocket(wsUrl);
    this.ready = new Promise((res, rej) => {
      this.ws.onopen = res;
      this.ws.onerror = rej;
    });
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { res, rej } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
      } else if (msg.method) {
        const hs = this.handlers.get(msg.method);
        if (hs) for (const h of hs) h(msg.params, msg.sessionId);
      }
    };
  }
  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
  }
  send(method, params, sessionId) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params: params || {}, sessionId }));
    });
  }
  close() { try { this.ws.close(); } catch (e) {} }
}

function waitEvent(cdp, method, timeoutMs) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error("timeout waiting " + method)), timeoutMs || 15000);
    cdp.on(method, (p) => { clearTimeout(t); res(p); });
  });
}

async function evaluate(cdp, sid, expr) {
  const r = await cdp.send("Runtime.evaluate", {
    expression: expr, returnByValue: true, awaitPromise: true
  }, sid);
  if (r.exceptionDetails) throw new Error("evaluate failed: " + JSON.stringify(r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text).slice(0, 300));
  return r.result.value;
}

async function realClick(cdp, sid, selector) {
  const point = await evaluate(cdp, sid, `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    el.scrollIntoView({ block: "center", inline: "center" });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
  })()`);
  if (!point) return null;
  if (point.x < 0 || point.y < 0 || point.x > 4096 || point.y > 4096) return null;
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
    await cdp.send("Input.dispatchMouseEvent", {
      type, x: point.x, y: point.y,
      button: type === "mouseMoved" ? "none" : "left",
      clickCount: type === "mouseMoved" ? 0 : 1
    }, sid);
  }
  return point;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const chrome = findChrome();
  if (!chrome) { console.error("no chrome/chromium found"); process.exit(2); }
  const profile = mkdtempSync(join(os.tmpdir(), "mw-audit-"));
  const server = await startServer();
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}/`;
  let browser = null, cdp = null;

  try {
    browser = spawn(chrome, [
      "--headless=new", "--mute-audio", "--no-first-run", "--no-default-browser-check",
      "--disable-extensions", "--disable-background-networking", "--disable-sync",
      "--disable-component-update", "--disable-features=Translate",
      `--user-data-dir=${profile}`, "--remote-debugging-port=0",
      "--remote-allow-origins=*", "about:blank"
    ], { stdio: ["ignore", "pipe", "pipe"] });
    const wsUrl = await new Promise((res, rej) => {
      let buf = "";
      const t = setTimeout(() => rej(new Error("chrome devtools ws timeout")), 20000);
      browser.stderr.on("data", (d) => {
        buf += d.toString();
        const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
        if (m) { clearTimeout(t); res(m[1]); }
      });
      browser.on("exit", () => { clearTimeout(t); rej(new Error("chrome exited early")); });
    });
    cdp = new CDP(wsUrl);
    await cdp.ready;

    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    const { sessionId: sid } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    await cdp.send("Page.enable", {}, sid);
    await cdp.send("Runtime.enable", {}, sid);
    await cdp.send("Network.enable", {}, sid);
    await cdp.send("Log.enable", {}, sid);

    cdp.on("Runtime.consoleAPICalled", (p) => { if (p.type === "error") consoleErrors++; });
    cdp.on("Runtime.exceptionThrown", () => { exceptions++; });
    cdp.on("Log.entryAdded", (p) => { if (p.entry && p.entry.level === "error") logErrors++; });
    cdp.on("Network.requestWillBeSent", (p) => {
      const u = p.request.url;
      if (!u.startsWith(base) && !/^(data:|blob:|about:|chrome:|devtools:)/.test(u)) externalReqs++;
    });

    for (const vp of VIEWPORTS) {
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width: vp.w, height: vp.h, deviceScaleFactor: 1, mobile: false
      }, sid);
      const loadWait = waitEvent(cdp, "Page.loadEventFired", 20000);
      // Query buster: after the hash-restore pass the URL carries a fragment,
      // and a fragment-only difference can shortcut to a same-document nav.
      await cdp.send("Page.navigate", { url: base + "?vp=" + vp.w }, sid);
      await loadWait;
      await sleep(400); // let lab DOM render

      const boot = await evaluate(cdp, sid, `(() => {
        const bad = [];
        const iw = window.innerWidth;
        document.querySelectorAll("body *").forEach(function (elm) {
          const r = elm.getBoundingClientRect();
          if (r.right > iw + 1 && elm.tagName !== "TBODY" && elm.tagName !== "TR" && elm.tagName !== "THEAD") {
            bad.push((elm.id ? "#" + elm.id : elm.tagName.toLowerCase()) + "." + String(elm.className).split(" ")[0] + " right=" + Math.round(r.right));
          }
        });
        return {
          overflow: Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0),
          innerW: iw,
          culprits: bad.slice(0, 6).join(" | "),
          sectionHidden: !document.getElementById("ablation-lab") || document.getElementById("ablation-lab").hidden,
          rows: document.querySelectorAll("#lab-matrix .lab-mrow").length,
          cells: document.querySelectorAll("#lab-phase-wrap .pp-cell").length,
          digest: (document.getElementById("lab-digest") || {}).textContent || ""
        };
      })()`);
      check(`${vp.name} workbench visible`, boot.sectionHidden === false);
      check(`${vp.name} matrix renders 12 mutant rows`, boot.rows === 12, `rows=${boot.rows}`);
      check(`${vp.name} phase plane renders cells`, boot.cells > 0, `cells=${boot.cells}`);
      check(`${vp.name} digest is 64-hex`, /^[0-9a-f]{64}$/.test(boot.digest), boot.digest.slice(0, 16) + "...");
      check(`${vp.name} zero horizontal overflow`, boot.overflow <= boot.innerW,
        `overflow=${boot.overflow} innerW=${boot.innerW}${boot.culprits ? " culprits: " + boot.culprits : ""}`);

      // Real pointer clicks on every interactive surface.
      const tabPoint = await realClick(cdp, sid, '#lab-domain-tabs .lab-tab[data-tab="quorum"]');
      check(`${vp.name} real click on quorum tab`, !!tabPoint);
      await sleep(150);
      const afterTab = await evaluate(cdp, sid, `(() => ({
        rows: document.querySelectorAll("#lab-matrix .lab-mrow").length,
        active: document.querySelector("#lab-domain-tabs .lab-tab.active").getAttribute("data-tab"),
        hash: location.hash
      }))()`);
      check(`${vp.name} quorum tab filters matrix to 4 rows`, afterTab.rows === 4, `rows=${afterTab.rows}`);
      check(`${vp.name} quorum tab marked active`, afterTab.active === "quorum");
      check(`${vp.name} hash encoded tab`, afterTab.hash.startsWith("#mw="), afterTab.hash.slice(0, 20));

      const rowPoint = await realClick(cdp, sid, '#lab-matrix .lab-mrow[data-mutant="q-liveness-only"]');
      check(`${vp.name} real click on mutant witness row`, !!rowPoint);
      await sleep(150);
      const afterRow = await evaluate(cdp, sid, `(() => ({
        witness: (document.getElementById("lab-witness") || {}).textContent || "",
        selected: !!document.querySelector('.lab-mrow.lab-row-selected[data-mutant="q-liveness-only"]'),
        decoded: window.MuseAblationLab.decodeMwHash(location.hash)
      }))()`);
      check(`${vp.name} witness pane shows counterexamples`, /splitBrain|stall|liveness/i.test(afterRow.witness));
      check(`${vp.name} mutant row selected`, afterRow.selected);
      check(`${vp.name} hash decodes to mutant + tab`, !!afterRow.decoded && afterRow.decoded.m === "q-liveness-only" && afterRow.decoded.tab === "quorum",
        afterRow.decoded ? `m=${afterRow.decoded.m} tab=${afterRow.decoded.tab}` : "decode failed");

      const cellPoint = await realClick(cdp, sid, '#lab-phase-wrap .pp-cell[data-f="1"][data-q="4"]');
      check(`${vp.name} real click on SVG phase-plane cell`, !!cellPoint);
      await sleep(150);
      const afterCell = await evaluate(cdp, sid, `(() => ({
        detail: (document.getElementById("lab-cell-detail") || {}).textContent || "",
        decoded: window.MuseAblationLab.decodeMwHash(location.hash)
      }))()`);
      check(`${vp.name} cell detail shows N/f/q witness`, /N=\d+, f=\d+, q=\d+/.test(afterCell.detail), afterCell.detail.slice(0, 60));
      check(`${vp.name} hash decodes to clicked cell`, !!afterCell.decoded && afterCell.decoded.f === 1 && afterCell.decoded.q === 4 && afterCell.decoded.n === 6,
        afterCell.decoded ? `n=${afterCell.decoded.n} f=${afterCell.decoded.f} q=${afterCell.decoded.q}` : "decode failed");

      const tamperPoint = await realClick(cdp, sid, "#lab-tamper-btn");
      check(`${vp.name} real click on tamper-verify button`, !!tamperPoint);
      await sleep(250);
      const note = await evaluate(cdp, sid, `(document.getElementById("lab-cert-note") || {}).textContent || ""`);
      check(`${vp.name} tamper verify reports intact OK + forged TAMPERED`, /OK/.test(note) && /TAMPERED/.test(note), note.slice(0, 80));

      const stPoint = await realClick(cdp, sid, "#lab-selftest-btn");
      check(`${vp.name} real click on self-test runner`, !!stPoint);
      await sleep(400);
      const st = await evaluate(cdp, sid, `(() => {
        const s = document.querySelector(".lab-selftest-summary");
        const items = document.querySelectorAll(".lab-selftest-list .lab-st");
        const fails = document.querySelectorAll(".lab-selftest-list .lab-st-fail");
        const m = s ? s.textContent.match(/(\\d+)\\/(\\d+)/) : null;
        return { text: s ? s.textContent : "", total: items.length, fails: fails.length,
                 passed: m ? +m[1] : 0, of: m ? +m[2] : 0 };
      })()`);
      check(`${vp.name} self-tests run with 14+ checks`, st.total >= 14, `total=${st.total}`);
      check(`${vp.name} self-test output ${st.passed}/${st.of} all green`, st.passed === st.of && st.passed >= 14 && st.fails === 0, st.text);

      // #mw= hash restore: mutate fields via clicks, reload, verify every field.
      const restoreCheck = async () => {
        await realClick(cdp, sid, '#lab-domain-tabs .lab-tab[data-tab="quorum"]');
        await realClick(cdp, sid, '#lab-matrix .lab-mrow[data-mutant="q-bft3f"]');
        await realClick(cdp, sid, '#lab-phase-wrap .pp-cell[data-f="2"][data-q="5"]');
        await sleep(200);
        const before = await evaluate(cdp, sid, `(() => ({
          hash: location.hash,
          n: document.getElementById("lab-n-input").value
        }))()`);
        check(`${vp.name} hash populated before reload`, before.hash.length > 8, before.hash.slice(0, 30));
        const loadWait2 = waitEvent(cdp, "Page.loadEventFired", 20000);
        evaluate(cdp, sid, `location.reload()`).catch(() => {});
        await loadWait2;
        await sleep(400);
        const after = await evaluate(cdp, sid, `(() => ({
          hash: location.hash,
          active: (document.querySelector("#lab-domain-tabs .lab-tab.active") || {}).getAttribute ?
            document.querySelector("#lab-domain-tabs .lab-tab.active").getAttribute("data-tab") : "",
          n: document.getElementById("lab-n-input").value,
          selected: (document.querySelector(".lab-mrow.lab-row-selected") || {}).getAttribute ?
            document.querySelector(".lab-mrow.lab-row-selected").getAttribute("data-mutant") : "",
          detail: (document.getElementById("lab-cell-detail") || {}).textContent || "",
          sectionHidden: document.getElementById("ablation-lab").hidden
        }))()`);
        check(`${vp.name} reload keeps workbench visible`, after.sectionHidden === false);
        check(`${vp.name} reload restores tab=quorum`, after.active === "quorum", after.active);
        check(`${vp.name} reload restores N slider`, after.n === before.n, `${after.n} vs ${before.n}`);
        check(`${vp.name} reload restores selected mutant`, after.selected === "q-bft3f", after.selected);
        check(`${vp.name} reload restores phase cell f=2 q=5`, /f=2, q=5/.test(after.detail), after.detail.slice(0, 60));
        check(`${vp.name} reload preserves identical hash`, after.hash === before.hash);
      };
      await restoreCheck();
    }

    // Final counts across both viewports.
    check("0 console errors across audit", consoleErrors === 0, `count=${consoleErrors}`);
    check("0 page exceptions across audit", exceptions === 0, `count=${exceptions}`);
    check("0 log errors across audit", logErrors === 0, `count=${logErrors}`);
    check("0 external network requests", externalReqs === 0, `count=${externalReqs}`);
  } finally {
    if (cdp) cdp.close();
    if (browser) { try { browser.kill("SIGKILL"); } catch (e) {} }
    await sleep(600);
    server.close();
    try { rmSync(profile, { recursive: true, force: true }); } catch (e) {}
  }

  // Hygiene: no stray audit processes, no /tmp leftovers.
  const strays = spawnSync("pgrep", ["-f", "mw-audit-"], { encoding: "utf8" });
  const strayOut = (strays.stdout || "").trim();
  check("0 stray audit processes", strayOut.length === 0, strayOut.split("\n").filter(Boolean).join(","));
  const leftovers = readdirSync(os.tmpdir()).filter((d) => d.startsWith("mw-audit-"));
  check("0 /tmp/mw-audit-* leftovers", leftovers.length === 0, leftovers.join(","));

  const pass = results.filter((r) => r.ok).length;
  const fail = results.filter((r) => !r.ok).length;
  console.log(`\nAUDIT SUMMARY: ${pass} passed, ${fail} failed, consoleErrors=${consoleErrors}, exceptions=${exceptions}, logErrors=${logErrors}, externalReqs=${externalReqs}`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error("AUDIT CRASHED:", e); process.exit(2); });
