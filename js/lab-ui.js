// ============================================================
// MuseWeaver - Ablation & Phase-Plane Workbench UI
// Wires window.MuseAblationLab into the workbench section:
// policy comparator matrix, SVG phase plane, certificate bar,
// self-test runner and #mw= bookmark round-trips.
// Hides the section gracefully when the lab script is absent.
// ============================================================
(function () {
  "use strict";
  var L = window.MuseAblationLab;
  var section = document.getElementById("ablation-lab");
  if (!section) return;
  if (!L) { section.hidden = true; return; }
  section.hidden = false;

  // ---------- helpers ----------
  function esc(s) {
    var d = document.createElement("div");
    d.textContent = String(s);
    return d.innerHTML.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function escAttr(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function el(id) { return document.getElementById(id); }
  function download(name, text, type) {
    var blob = new Blob([text], { type: type || "text/plain" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  }
  function copyText(text, done) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(fallback()); });
    } else {
      done(fallback());
    }
    function fallback() {
      var t = document.createElement("textarea");
      t.value = text;
      t.setAttribute("readonly", "");
      t.style.position = "fixed";
      t.style.opacity = "0";
      document.body.appendChild(t);
      t.select();
      var ok = false;
      try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
      t.remove();
      return ok;
    }
  }

  // ---------- state ----------
  var DEFAULT_STATE = { v: 1, tab: "all", n: 6, f: -1, q: -1, m: "" };
  var state = DEFAULT_STATE;
  var restored = L.decodeMwHash(window.location.hash);
  if (restored) state = restored;

  var matrix = null;
  function getMatrix() {
    if (!matrix) matrix = L.runAblationMatrix(42);
    return matrix;
  }
  function payload() {
    return L.buildLabPayload(state, getMatrix());
  }

  function syncHash() {
    var h = L.encodeMwHash(state);
    if (!h) return;
    try {
      var url = new URL(window.location.href);
      url.hash = h;
      history.replaceState(null, "", url.toString());
    } catch (e) { /* hash sync is best effort */ }
    renderDigest();
  }

  // ---------- policy comparator matrix ----------
  var CLASS_LABEL = {
    "split-brain": "split-brain", deadlock: "deadlock", doomed: "doomed", safe: "safe"
  };

  function renderMatrix() {
    var host = el("lab-matrix");
    if (!host) return;
    var m = getMatrix();
    var byMutant = {};
    for (var i = 0; i < m.cells.length; i++) {
      var c = m.cells[i];
      (byMutant[c.mutant] = byMutant[c.mutant] || {})[c.policy] = c;
    }
    var html = '<table class="lab-table"><thead><tr><th scope="col">Mutant</th>';
    for (var p = 0; p < m.policies.length; p++) {
      html += '<th scope="col">' + esc(m.policies[p].name) + "</th>";
    }
    html += "</tr></thead><tbody>";
    var shown = 0;
    for (var mi = 0; mi < m.mutants.length; mi++) {
      var mut = m.mutants[mi];
      if (state.tab !== "all" && mut.domain !== state.tab) continue;
      shown++;
      var sel = state.m === mut.id ? " lab-row-selected" : "";
      html += '<tr class="lab-mrow' + sel + '" data-mutant="' + escAttr(mut.id) + '" tabindex="0" role="button" aria-pressed="' + (state.m === mut.id) + '">';
      html += '<th scope="row"><span class="lab-mname">' + esc(mut.name) + '</span><span class="lab-mdom lab-dom-' + escAttr(mut.domain) + '">' + esc(mut.domain) + "</span></th>";
      for (var pj = 0; pj < m.policies.length; pj++) {
        var cell = byMutant[mut.id][m.policies[pj].id];
        if (cell && cell.caught) {
          html += '<td class="lab-caught">caught<span class="lab-cell-sub">' + esc(cell.check) + "</span></td>";
        } else {
          html += '<td class="lab-escaped">escaped</td>';
        }
      }
      html += "</tr>";
    }
    html += "</tbody></table>";
    if (!shown) html += '<div class="empty-state">No mutants in this domain.</div>';
    host.innerHTML = html;

    host.querySelectorAll(".lab-mrow").forEach(function (row) {
      var pick = function () {
        var id = row.getAttribute("data-mutant");
        state.m = state.m === id ? "" : id;
        syncHash();
        renderMatrix();
        renderWitness();
      };
      row.addEventListener("click", pick);
      row.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); }
      });
    });
  }

  function renderWitness() {
    var host = el("lab-witness");
    if (!host) return;
    if (!state.m) {
      host.innerHTML = '<div class="empty-state">Select a mutant row to inspect the exact counterexample each gate produced.</div>';
      return;
    }
    var m = getMatrix();
    var meta = null;
    for (var i = 0; i < m.mutants.length; i++) if (m.mutants[i].id === state.m) meta = m.mutants[i];
    if (!meta) { host.innerHTML = ""; return; }
    var html = '<div class="lab-witness-head"><strong>' + esc(meta.name) + '</strong> <span class="lab-mdom lab-dom-' + escAttr(meta.domain) + '">' + esc(meta.domain) + '</span><div class="lab-witness-blurb">' + esc(meta.blurb) + "</div></div>";
    for (var p = 0; p < m.policies.length; p++) {
      var pol = m.policies[p];
      var cell = null;
      for (var ci = 0; ci < m.cells.length; ci++) {
        if (m.cells[ci].mutant === state.m && m.cells[ci].policy === pol.id) cell = m.cells[ci];
      }
      if (!cell) continue;
      if (cell.caught) {
        html += '<div class="lab-wpol lab-wpol-caught"><div class="lab-wpol-head"><span class="lab-dot lab-dot-caught"></span>' + esc(pol.name) + ': caught by <code>' + esc(cell.check) + '</code> check' + (cell.checksRun > 1 ? " (check " + cell.checksRun + ")" : "") + "</div>";
        html += '<pre class="lab-pre">' + esc(JSON.stringify(cell.witness, null, 2)) + "</pre></div>";
      } else {
        html += '<div class="lab-wpol"><div class="lab-wpol-head"><span class="lab-dot lab-dot-escaped"></span>' + esc(pol.name) + ': mutant escaped' + (cell.checksRun ? " all " + cell.checksRun + " checks" : "") + "</div></div>";
      }
    }
    host.innerHTML = html;
  }

  // ---------- domain tabs ----------
  function initTabs() {
    var tabs = document.querySelectorAll("#lab-domain-tabs .lab-tab");
    tabs.forEach(function (tab) {
      var active = tab.getAttribute("data-tab") === state.tab;
      tab.classList.toggle("active", active);
      tab.setAttribute("aria-selected", String(active));
      tab.addEventListener("click", function () {
        state.tab = tab.getAttribute("data-tab");
        tabs.forEach(function (t2) {
          var on = t2 === tab;
          t2.classList.toggle("active", on);
          t2.setAttribute("aria-selected", String(on));
        });
        syncHash();
        renderMatrix();
      });
    });
  }

  // ---------- SVG phase plane ----------
  var PLANE = { cell: 30, padL: 46, padT: 26 };
  var FILL = {
    safe: "rgba(16,185,129,0.28)",
    "split-brain": "rgba(239,68,68,0.30)",
    deadlock: "rgba(245,158,11,0.30)",
    doomed: "#7F1D1D",
    invalid: "#111827"
  };
  var STROKE = {
    safe: "#10B981", "split-brain": "#EF4444", deadlock: "#F59E0B", doomed: "#991B1B", invalid: "#1E293B"
  };

  function fMaxFor(n) { return Math.floor(n / 2); }

  function renderPlane() {
    var host = el("lab-phase-wrap");
    if (!host) return;
    var n = state.n;
    var fMax = fMaxFor(n);
    var w = PLANE.padL + (fMax + 1) * PLANE.cell + 8;
    var h = PLANE.padT + n * PLANE.cell + 26;
    var svg = '<svg viewBox="0 0 ' + w + " " + h + '" class="lab-plane-svg" role="grid" aria-label="Quorum phase plane for N=' + n + '">';
    svg += '<text x="' + (PLANE.padL + (fMax + 1) * PLANE.cell / 2) + '" y="14" text-anchor="middle" fill="#94A3B8" font-size="10">Byzantine faults f</text>';
    svg += '<text x="12" y="' + (PLANE.padT + n * PLANE.cell / 2) + '" text-anchor="middle" fill="#94A3B8" font-size="10" transform="rotate(-90 12 ' + (PLANE.padT + n * PLANE.cell / 2) + ')">quorum size q</text>';
    for (var f = 0; f <= fMax; f++) {
      svg += '<text x="' + (PLANE.padL + f * PLANE.cell + PLANE.cell / 2) + '" y="' + (PLANE.padT - 6) + '" text-anchor="middle" fill="#64748B" font-size="9">' + f + "</text>";
    }
    for (var q = n; q >= 1; q--) {
      var y = PLANE.padT + (n - q) * PLANE.cell;
      svg += '<text x="' + (PLANE.padL - 8) + '" y="' + (y + PLANE.cell / 2 + 3) + '" text-anchor="end" fill="#64748B" font-size="9">' + q + "</text>";
      for (var f2 = 0; f2 <= fMax; f2++) {
        var cell = L.phaseCell(n, f2, q);
        var cls = cell.classification;
        var sel = state.f === f2 && state.q === q;
        var x = PLANE.padL + f2 * PLANE.cell;
        svg += '<rect x="' + x + '" y="' + y + '" width="' + (PLANE.cell - 2) + '" height="' + (PLANE.cell - 2) + '" rx="3" role="gridcell" tabindex="' + (sel ? "0" : "-1") + '" class="pp-cell" data-f="' + f2 + '" data-q="' + q + '" fill="' + FILL[cls] + '" stroke="' + (sel ? "#3B82F6" : STROKE[cls]) + '" stroke-width="' + (sel ? 2 : 0.8) + '" aria-label="f=' + f2 + " q=" + q + " " + escAttr(CLASS_LABEL[cls] || cls) + '" />';
      }
    }
    svg += "</svg>";
    host.innerHTML = svg;

    host.querySelectorAll(".pp-cell").forEach(function (rect) {
      var pick = function () {
        state.f = parseInt(rect.getAttribute("data-f"), 10);
        state.q = parseInt(rect.getAttribute("data-q"), 10);
        syncHash();
        renderPlane();
        renderCellDetail();
        var sel2 = host.querySelector('.pp-cell[data-f="' + state.f + '"][data-q="' + state.q + '"]');
        if (sel2) sel2.focus();
      };
      rect.addEventListener("click", pick);
      rect.addEventListener("keydown", function (e) {
        var f3 = parseInt(rect.getAttribute("data-f"), 10);
        var q3 = parseInt(rect.getAttribute("data-q"), 10);
        var nf = f3, nq = q3;
        if (e.key === "ArrowLeft") nf = Math.max(0, f3 - 1);
        else if (e.key === "ArrowRight") nf = Math.min(fMaxFor(state.n), f3 + 1);
        else if (e.key === "ArrowUp") nq = Math.min(state.n, q3 + 1);
        else if (e.key === "ArrowDown") nq = Math.max(1, q3 - 1);
        else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); return; }
        else return;
        e.preventDefault();
        state.f = nf; state.q = nq;
        syncHash();
        renderPlane();
        renderCellDetail();
        var next = host.querySelector('.pp-cell[data-f="' + nf + '"][data-q="' + nq + '"]');
        if (next) next.focus();
      });
    });
  }

  function renderCellDetail() {
    var host = el("lab-cell-detail");
    if (!host) return;
    if (state.f < 0 || state.q < 0 || state.f > fMaxFor(state.n) || state.q > state.n) {
      host.innerHTML = '<div class="empty-state">Click or arrow through a grid cell for the concrete split-brain or stall witness.</div>';
      return;
    }
    var cell = L.phaseCell(state.n, state.f, state.q);
    var html = '<div class="lab-witness-head"><strong>N=' + state.n + ", f=" + state.f + ", q=" + state.q + '</strong> <span class="lab-mdom lab-cls-' + escAttr(cell.classification) + '">' + esc(cell.classification) + "</span></div>";
    html += '<div class="lab-cell-facts">';
    html += "<div>safety 2q - N &gt; f: <strong>" + (cell.safety ? "holds" : "fails") + "</strong> (2x" + state.q + " - " + state.n + " = " + cell.intersectionBound + ", f=" + state.f + ")</div>";
    html += "<div>liveness q &lt;= N - f: <strong>" + (cell.liveness ? "holds" : "fails") + "</strong> (N - f = " + cell.honestAvailable + ", q=" + state.q + ")</div>";
    html += "<div>BFT feasibility N &gt;= 3f + 1: <strong>" + (cell.bftFeasible ? "yes" : "no") + "</strong> (3f + 1 = " + (3 * state.f + 1) + ")</div>";
    html += "</div>";
    if (cell.splitBrain) {
      var sb = cell.splitBrain;
      html += '<div class="lab-sb">Split-brain construction: honest nodes 0..' + (state.n - state.f - 1) + ", Byzantine " + (state.n - state.f) + ".." + (state.n - 1) + "</div>";
      html += '<pre class="lab-pre">Q1 = [' + esc(sb.q1.join(", ")) + "]\nQ2 = [" + esc(sb.q2.join(", ")) + "]\nshared nodes = [" + esc(sb.shared.join(", ")) + "]  (all Byzantine: " + sb.sharedAllByzantine + ")\nhonest intersection = [" + esc(sb.honestIntersection.join(", ")) + "]  -> both partitions commit conflicting values</pre>";
    } else if (!cell.liveness) {
      html += '<div class="lab-sb">Liveness stall: at most ' + cell.honestAvailable + " honest nodes can ever answer, below the required quorum q=" + state.q + ". Every vote waits forever.</div>";
    } else {
      html += '<div class="lab-sb">Every pair of ' + state.q + "-node quorums shares at least " + cell.intersectionBound + " nodes &gt; f=" + state.f + ", so one honest witness sits in every intersection.</div>";
    }
    host.innerHTML = html;
  }

  function initPlaneControls() {
    var input = el("lab-n-input");
    var label = el("lab-n-label");
    if (!input || !label) return;
    input.value = String(state.n);
    label.textContent = "N=" + state.n;
    input.addEventListener("input", function () {
      state.n = parseInt(input.value, 10);
      if (state.f > fMaxFor(state.n)) state.f = -1;
      if (state.q > state.n) state.q = -1;
      label.textContent = "N=" + state.n;
      syncHash();
      renderPlane();
      renderCellDetail();
    });
  }

  // ---------- certificate bar ----------
  function renderDigest() {
    var d = el("lab-digest");
    if (!d) return;
    var cert = L.certificate(payload());
    d.textContent = cert.digest;
    d.setAttribute("title", "SHA-256 over canonical JSON of the lab state and matrix");
  }

  function initCertBar() {
    var jsonBtn = el("lab-cert-json"), csvBtn = el("lab-cert-csv"), mdBtn = el("lab-cert-md");
    var hashBtn = el("lab-hash-copy"), tamperBtn = el("lab-tamper-btn");
    var note = el("lab-cert-note");
    var say = function (msg, ok) {
      if (!note) return;
      note.textContent = msg;
      note.className = "lab-cert-note " + (ok === false ? "err" : "ok");
    };
    if (jsonBtn) jsonBtn.addEventListener("click", function () {
      download("museweaver-ablation-certificate.json", L.exportCertificateJson(payload()), "application/json");
      say("JSON certificate downloaded; digest matches the on-page value.");
    });
    if (csvBtn) csvBtn.addEventListener("click", function () {
      download("museweaver-ablation-certificate.csv", L.exportCertificateCsv(payload()), "text/csv");
      say("CSV certificate downloaded; provenance header carries the same digest.");
    });
    if (mdBtn) mdBtn.addEventListener("click", function () {
      download("museweaver-ablation-certificate.md", L.exportCertificateMarkdown(payload()), "text/markdown");
      say("Markdown certificate downloaded; footer carries the same digest.");
    });
    if (hashBtn) hashBtn.addEventListener("click", function () {
      var h = L.encodeMwHash(state);
      var url = new URL(window.location.href);
      url.hash = h;
      copyText(url.toString(), function (ok) {
        say(ok ? "Shareable #mw= link copied." : "Copy blocked by the browser; the hash is in the address bar.", ok);
      });
    });
    if (tamperBtn) tamperBtn.addEventListener("click", function () {
      var p = payload();
      var json = L.exportCertificateJson(p);
      var intact = L.verifyCertificateJson(json);
      var doc = JSON.parse(json);
      doc.payload.cells[0].caught = !doc.payload.cells[0].caught;
      var forged = L.verifyCertificateJson(JSON.stringify(doc));
      say("Verify intact certificate: " + (intact.ok ? "OK" : "FAILED") +
        ". Verify same document with one flipped cell: " + (forged.ok ? "OK" : "TAMPERED (digest " + String(forged.actual).slice(0, 12) + " != " + String(forged.expected).slice(0, 12) + "...)"), intact.ok && !forged.ok);
    });
  }

  // ---------- self-test runner ----------
  function initSelfTests() {
    var btn = el("lab-selftest-btn");
    var host = el("lab-selftest");
    if (!btn || !host) return;
    var suite = L.runSelfTests();
    btn.textContent = "Run " + suite.length + " deterministic checks";
    btn.addEventListener("click", function () {
      var results = L.runSelfTests();
      var passed = results.filter(function (r) { return r.pass; }).length;
      var html = '<div class="lab-selftest-summary ' + (passed === results.length ? "ok" : "err") + '">' + passed + "/" + results.length + " checks passed</div>";
      html += '<div class="lab-selftest-list">';
      for (var i = 0; i < results.length; i++) {
        var r = results[i];
        html += '<div class="lab-st ' + (r.pass ? "lab-st-pass" : "lab-st-fail") + '"><span class="lab-st-icon">' + (r.pass ? "&#10003;" : "&#10007;") + "</span><span>" + esc(r.name) + "</span>" + (r.detail ? '<span class="lab-st-detail">' + esc(r.detail) + "</span>" : "") + "</div>";
      }
      html += "</div>";
      host.innerHTML = html;
      btn.textContent = passed + "/" + results.length + " checks passed - run again";
    });
  }

  // ---------- boot ----------
  document.addEventListener("DOMContentLoaded", function () {
    initTabs();
    initPlaneControls();
    initCertBar();
    initSelfTests();
    renderMatrix();
    renderWitness();
    renderPlane();
    renderCellDetail();
    renderDigest();
  });
})();
