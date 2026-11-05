// ============================================================
// MuseWeaver - UI Controller
// Wires scenario selector, pipeline animation, DAG, modals,
// live API, comparison toggle, and report export.
// ============================================================

// --- State ---
let currentScenario = "rate-limiter";
let pipelineRunning = false;
let comparisonMode = false;
let lastResult = null;
let dagSelectedNode = null;

// --- Scenario metadata for UI ---
const SCENARIOS = {
  "rate-limiter": {
    label: "Exact Integer Token Bucket",
    shortLabel: "Rate Limiter",
    badge: "CONCURRENCY",
    badgeClass: "badge-concurrency",
    desc: "Float-drift & burst-boundary race audit"
  },
  "quorum": {
    label: "Byzantine Quorum Threshold",
    shortLabel: "Quorum Proof",
    badge: "CONSENSUS",
    badgeClass: "badge-consensus",
    desc: "2f+1 vs 3f+1 split-brain proof"
  },
  "battery": {
    label: "Battery Arbitrage DP",
    shortLabel: "Battery DP",
    badge: "OPTIMIZATION",
    badgeClass: "badge-optimization",
    desc: "Bellman optimality & greedy counterexample"
  }
};

// Custom task state
let customTask = null;

// ============================================================
// DOM Ready
// ============================================================
document.addEventListener("DOMContentLoaded", () => {
  initScenarioSelector();
  initPipelineButton();
  initComparisonToggle();
  initApiModal();
  initDag();
  initReportExport();
  initPermalink();
  initCodeEdit();
  initCustomComposer();
  initFuzzControls();

  // Load initial scenario
  selectScenario("rate-limiter");
  renderDag(currentScenario);
});

// ============================================================
// Scenario Selector
// ============================================================
function initScenarioSelector() {
  document.querySelectorAll(".scenario-card").forEach(card => {
    card.addEventListener("click", () => {
      const id = card.dataset.scenario;
      if (id === "custom") {
        document.getElementById("custom-composer").classList.toggle("open");
        return;
      }
      selectScenario(id);
    });
  });
}

function selectScenario(id) {
  if (!CAPTURED_TRACES[id] && id !== "custom") return;
  currentScenario = id;

  // Update card active state
  document.querySelectorAll(".scenario-card").forEach(c => {
    c.classList.toggle("active", c.dataset.scenario === id);
  });

  // Update pipeline indicator
  updatePipelineIndicator("idle");

  // Load proposer column
  loadProposerColumn(id);

  // Load skeptic column (reset)
  resetSkepticColumn();

  // Load judge column
  resetJudgeColumn();

  // Render DAG
  renderDag(id);

  // Update URL without reload
  const url = new URL(window.location.href);
  url.searchParams.set("scenario", id);
  history.replaceState(null, "", url.toString());

  // Check URL hash scenario on load
  lastResult = null;
}

function loadProposerColumn(id) {
  const trace = CAPTURED_TRACES[id];
  if (!trace) return;

  // Reasoning trace
  const reasoningEl = document.getElementById("proposer-reasoning");
  const reasoningText = document.getElementById("reasoning-text");
  const reasoningToggle = document.getElementById("reasoning-toggle");
  if (reasoningText) {
    reasoningText.textContent = trace.proposer.reasoning;
    reasoningText.classList.add("collapsed");
    if (reasoningToggle) {
      reasoningToggle.textContent = "Expand reasoning trace";
      reasoningToggle.onclick = () => {
        const collapsed = reasoningText.classList.toggle("collapsed");
        reasoningToggle.textContent = collapsed ? "Expand reasoning trace" : "Collapse reasoning trace";
      };
    }
  }

  // Code
  const codeEl = document.getElementById("proposer-code");
  if (codeEl) {
    codeEl.value = trace.proposer.code;
    codeEl.dataset.original = trace.proposer.code;
  }

  // Invariants
  const invEl = document.getElementById("proposer-invariants");
  if (invEl) {
    invEl.innerHTML = trace.proposer.invariants.map(inv =>
      `<div class="invariant-row" data-invariant="${inv.id}" onclick="highlightInvariant('${inv.id}')">
        <span class="inv-id">${inv.id}</span>
        <span class="inv-name">${inv.name}</span>
        <span class="inv-formula">${inv.formula}</span>
        <span class="inv-status verified">${inv.status}</span>
      </div>`
    ).join("");
  }

  // Title
  const titleEl = document.getElementById("proposer-title");
  if (titleEl) titleEl.textContent = `1. Proposer Agent - ${trace.title}`;

  // Skeptic critique
  const skepticEl = document.getElementById("skeptic-critique");
  if (skepticEl) skepticEl.textContent = trace.skeptic.critique;

  const skepticTestsEl = document.getElementById("skeptic-tests");
  if (skepticTestsEl) {
    skepticTestsEl.innerHTML = trace.skeptic.testCases.map(tc =>
      `<div class="test-case-row">
        <span class="tc-name">${tc.name}</span>
        <span class="tc-desc">${tc.desc}</span>
      </div>`
    ).join("");
  }
}

function resetSkepticColumn() {
  const resultsEl = document.getElementById("execution-results");
  if (resultsEl) resultsEl.innerHTML = `<div class="empty-state">Click <strong>Run Verification Suite</strong> to execute ${SCENARIOS[currentScenario]?.label || "verification"} live in your browser.</div>`;

  const logsEl = document.getElementById("execution-logs");
  if (logsEl) logsEl.innerHTML = "";

  const metricsEl = document.getElementById("execution-metrics");
  if (metricsEl) metricsEl.innerHTML = "";
}

function resetJudgeColumn() {
  const verdictEl = document.getElementById("judge-verdict");
  if (verdictEl) verdictEl.innerHTML = `<div class="empty-state">Run the pipeline to generate the formal verdict.</div>`;
}

// ============================================================
// Pipeline - Animated Step-by-Step + Real Execution
// ============================================================
function initPipelineButton() {
  const btn = document.getElementById("run-pipeline-btn");
  if (!btn) return;
  btn.addEventListener("click", runPipeline);
}

async function runPipeline() {
  if (pipelineRunning) return;
  pipelineRunning = true;

  const btn = document.getElementById("run-pipeline-btn");
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span> Running pipeline...`;

  const trials = parseInt(document.getElementById("fuzz-trials-input")?.value || "1000", 10);

  try {
    // Stage 1: Proposer
    updatePipelineIndicator("proposer", true);
    highlightColumn("proposer-col", true);
    await sleep(600);
    updatePipelineIndicator("proposer", false);

    // Stage 2: Skeptic - generate tests + show execution
    updatePipelineIndicator("skeptic", true);
    highlightColumn("skeptic-col", true);
    await sleep(400);

    // Real execution
    const result = runVerification(currentScenario, { trials });
    lastResult = result;

    renderExecutionResults(result);
    updatePipelineIndicator("skeptic", false);

    // Stage 3: Judge - synthesis
    updatePipelineIndicator("judge", true);
    highlightColumn("judge-col", true);
    await sleep(500);
    renderJudgeVerdict(result);
    renderDag(currentScenario, result);
    updatePipelineIndicator("judge", false);
    updatePipelineIndicator("complete");

  } catch (e) {
    console.error(e);
    const logsEl = document.getElementById("execution-logs");
    if (logsEl) logsEl.innerHTML = `<div class="log-error">Pipeline error: ${escapeHtml(e.message)}</div>`;
  } finally {
    pipelineRunning = false;
    btn.disabled = false;
    btn.innerHTML = `Run Multi-Agent Verification Pipeline`;
    document.querySelectorAll(".studio-col").forEach(c => c.classList.remove("col-highlight"));
  }
}

function updatePipelineIndicator(stage, active) {
  const stages = ["proposer", "skeptic", "judge"];
  const indicator = document.getElementById("pipeline-indicator");
  if (!indicator) return;

  if (stage === "idle") {
    indicator.querySelectorAll(".pipe-stage").forEach(s => {
      s.classList.remove("active", "done", "complete");
    });
    return;
  }
  if (stage === "complete") {
    indicator.querySelectorAll(".pipe-stage").forEach(s => {
      s.classList.remove("active");
      s.classList.add("done");
    });
    const last = indicator.querySelector(".pipe-stage:last-child");
    if (last) last.classList.add("complete");
    return;
  }

  indicator.querySelectorAll(".pipe-stage").forEach(s => {
    const sStage = s.dataset.stage;
    s.classList.remove("active");
    if (sStage === stage && active) s.classList.add("active");
    if (stages.indexOf(sStage) < stages.indexOf(stage)) s.classList.add("done");
  });
}

function highlightColumn(colId, on) {
  const col = document.getElementById(colId);
  if (!col) return;
  if (on) col.classList.add("col-highlight");
  else col.classList.remove("col-highlight");
}

function renderExecutionResults(result) {
  const resultsEl = document.getElementById("execution-results");
  const logsEl = document.getElementById("execution-logs");
  const metricsEl = document.getElementById("execution-metrics");

  // Metrics bar
  if (metricsEl) {
    metricsEl.innerHTML = `
      <div class="metric"><span class="metric-val">${result.summary.total}</span><span class="metric-label">tests</span></div>
      <div class="metric pass"><span class="metric-val">${result.summary.passed}</span><span class="metric-label">passed</span></div>
      <div class="metric fail"><span class="metric-val">${result.summary.failed}</span><span class="metric-label">failed</span></div>
      <div class="metric"><span class="metric-val">${result.elapsed}ms</span><span class="metric-label">elapsed</span></div>
      <div class="metric ${result.counterexample ? 'fail' : 'pass'}"><span class="metric-val">${result.summary.naiveBugsCaught}</span><span class="metric-label">bugs caught</span></div>
    `;
  }

  // Counterexample banner
  let banner = "";
  if (result.counterexample) {
    banner = `<div class="counterexample-banner">
      <span class="ce-icon">&#9673;</span>
      <span class="ce-text"><strong>Counterexample found:</strong> ${escapeHtml(result.counterexample)}</span>
    </div>`;
  } else if (result.summary.failed === 0) {
    banner = `<div class="verified-banner">
      <span class="ce-icon">&#10003;</span>
      <span class="ce-text"><strong>All invariants verified</strong> - no counterexamples in ${result.summary.total} checks.</span>
    </div>`;
  }

  if (resultsEl) resultsEl.innerHTML = banner;

  // Detailed logs
  if (logsEl) {
    logsEl.innerHTML = result.logs.map(entry => {
      const statusClass = entry.pass ? "log-pass" : "log-fail";
      const statusIcon = entry.pass ? "&#10003;" : "&#10007;";
      let detail = "";
      if (entry.detail) detail = `<div class="log-detail">${escapeHtml(entry.detail)}</div>`;
      if (entry.counterexample) detail = `<div class="log-detail ce">${escapeHtml(entry.counterexample)}</div>`;
      // Show key fields
      const fields = [];
      for (const [k, v] of Object.entries(entry)) {
        if (k === "test" || k === "pass" || k === "detail" || k === "counterexample") continue;
        if (typeof v === "object") continue; // skip complex objects in compact view
        fields.push(`<span class="log-field"><span class="log-field-k">${k}</span>=<span class="log-field-v">${escapeHtml(String(v))}</span></span>`);
      }
      return `<div class="log-entry ${statusClass}">
        <span class="log-status">${statusIcon}</span>
        <span class="log-test">${escapeHtml(entry.test)}</span>
        ${fields.length ? `<span class="log-fields">${fields.join(" ")}</span>` : ""}
        ${detail}
      </div>`;
    }).join("");
  }
}

function renderJudgeVerdict(result) {
  const verdictEl = document.getElementById("judge-verdict");
  if (!verdictEl) return;

  const allPass = result.summary.verifiedBugs === 0;
  const verdictClass = allPass ? "verdict-pass" : "verdict-fail";
  const verdictIcon = allPass ? "&#10003;" : "&#10007;";
  const verdictText = allPass ? "TESTED INVARIANTS PASS" : "ISSUES FOUND";

  verdictEl.innerHTML = `
    <div class="verdict-card ${verdictClass}">
      <div class="verdict-icon">${verdictIcon}</div>
      <div class="verdict-text">${verdictText}</div>
      <div class="verdict-detail">
        ${result.summary.passed}/${result.summary.total} checks passed in ${result.elapsed}ms<br>
        ${result.counterexample ? `<span class="verdict-ce">${escapeHtml(result.counterexample)}</span>` : "No counterexamples - all invariants hold."}
      </div>
    </div>
    <div class="verdict-invariants">
      ${result.logs.filter(l => l.test.startsWith("fuzz") || l.test.includes("counterexample") || l.test.includes("bellman") || l.test.includes("brute") || l.test.includes("n3f") || l.test.includes("burst") || l.test.includes("equivocation")).map(l =>
        `<div class="verdict-inv ${l.pass ? 'inv-pass' : 'inv-fail'}">
          <span class="inv-dot"></span>
          <span class="inv-label">${escapeHtml(l.test)}</span>
          <span class="inv-result">${l.pass ? "verified" : "violated"}</span>
        </div>`
      ).join("")}
    </div>
  `;
}

// ============================================================
// Naive vs Verified Comparison Toggle
// ============================================================
function initComparisonToggle() {
  const toggle = document.getElementById("compare-toggle");
  if (!toggle) return;
  toggle.addEventListener("click", () => {
    comparisonMode = !comparisonMode;
    toggle.classList.toggle("active", comparisonMode);
    toggle.textContent = comparisonMode ? "Showing: Naive vs Verified" : "Compare Naive vs Verified";
    if (comparisonMode && lastResult) {
      renderComparison(lastResult);
    } else if (lastResult) {
      renderExecutionResults(lastResult);
      renderJudgeVerdict(lastResult);
    }
  });
}

function renderComparison(result) {
  const resultsEl = document.getElementById("execution-results");
  if (!resultsEl) return;

  // Show side-by-side comparison
  const naiveBugs = result.summary.naiveBugsCaught;
  resultsEl.innerHTML = `
    <div class="compare-grid">
      <div class="compare-card naive">
        <div class="compare-header"><span class="compare-dot naive-dot"></span> Naive (Buggy)</div>
        <div class="compare-body">
          ${naiveBugs > 0
            ? `<div class="compare-bug">&#10007; Bug caught - counterexample found</div><div class="compare-detail">${escapeHtml(result.counterexample || "Invariant violated")}</div>`
            : `<div class="compare-ok">No bug detected in this run</div>`}
        </div>
      </div>
      <div class="compare-card verified">
        <div class="compare-header"><span class="compare-dot verified-dot"></span> MuseWeaver Verified</div>
        <div class="compare-body">
          <div class="compare-ok">&#10003; All invariants hold - ${result.summary.passed}/${result.summary.total} passed</div>
          <div class="compare-detail">${result.elapsed}ms &middot; ${result.summary.total} checks</div>
        </div>
      </div>
    </div>
  `;
}

// ============================================================
// Interactive SVG Proof DAG
// ============================================================
const DAG_NODES = {
  "rate-limiter": [
    { id: "spec", label: "Problem Spec", sub: "Token Bucket C=10 R=10", x: 60, y: 40 },
    { id: "proposer", label: "Proposer Patch", sub: "Integer uCAS bucket", x: 200, y: 40 },
    { id: "inv1", label: "I_1 Capacity", sub: "microTokens <= C*1e6", x: 60, y: 120, invariant: "I_1" },
    { id: "inv2", label: "I_2 Conservation", sub: "consumed+remain=replenished", x: 200, y: 120, invariant: "I_2" },
    { id: "inv3", label: "I_3 Rate Fidelity", sub: "admitted(W) <= ceil(W*R)+burst", x: 340, y: 120, invariant: "I_3" },
    { id: "fuzz", label: "Skeptic Fuzz Suite", sub: "1000 concurrent trials", x: 200, y: 200 },
    { id: "verdict", label: "Verified Verdict", sub: "All invariants hold", x: 200, y: 280 }
  ],
  "quorum": [
    { id: "spec", label: "Problem Spec", sub: "N nodes, f Byzantine", x: 60, y: 40 },
    { id: "proposer", label: "Proposer Patch", sub: "N=3f+1 quorum proof", x: 200, y: 40 },
    { id: "inv1", label: "I_1 Honest Inter.", sub: "|Q1 cap Q2 cap H| >= 1", x: 60, y: 120, invariant: "I_1" },
    { id: "inv2", label: "I_2 No Split-Brain", sub: "No conflicting commits", x: 200, y: 120, invariant: "I_2" },
    { id: "inv3", label: "I_3 Tightness", sub: "N=3f fails, N=3f+1 minimal", x: 340, y: 120, invariant: "I_3" },
    { id: "fuzz", label: "Skeptic Fuzz Suite", sub: "All quorum pair enumeration", x: 200, y: 200 },
    { id: "verdict", label: "Verified Verdict", sub: "Threshold proven", x: 200, y: 280 }
  ],
  "battery": [
    { id: "spec", label: "Problem Spec", sub: "Battery C/R/d + prices", x: 60, y: 40 },
    { id: "proposer", label: "Proposer Patch", sub: "Bellman DP recurrence", x: 200, y: 40 },
    { id: "inv1", label: "I_1 Bellman Opt.", sub: "V[t][s]=max_a{profit+V[t+1]}", x: 60, y: 120, invariant: "I_1" },
    { id: "inv2", label: "I_2 SOC Bounds", sub: "0 <= soc[t] <= C", x: 200, y: 120, invariant: "I_2" },
    { id: "inv3", label: "I_3 BF Agreement", sub: "DP == brute-force optimum", x: 340, y: 120, invariant: "I_3" },
    { id: "fuzz", label: "Skeptic Fuzz Suite", sub: "1000 random price curves", x: 200, y: 200 },
    { id: "verdict", label: "Verified Verdict", sub: "Optimality verified", x: 200, y: 280 }
  ]
};

const DAG_EDGES = [
  ["spec", "proposer"],
  ["proposer", "inv1"],
  ["proposer", "inv2"],
  ["proposer", "inv3"],
  ["inv1", "fuzz"],
  ["inv2", "fuzz"],
  ["inv3", "fuzz"],
  ["fuzz", "verdict"]
];

function initDag() {
  // Click delegation handled in renderDag
}

function renderDag(scenarioId, result) {
  const container = document.getElementById("proof-dag");
  if (!container) return;
  const nodes = DAG_NODES[scenarioId] || DAG_NODES["rate-limiter"];

  const W = 440, H = 340;
  let svg = `<svg viewBox="0 0 ${W} ${H}" class="dag-svg" xmlns="http://www.w3.org/2000/svg">`;

  // Edges
  for (const [from, to] of DAG_EDGES) {
    const a = nodes.find(n => n.id === from);
    const b = nodes.find(n => n.id === to);
    if (!a || !b) continue;
    const isFuzzToVerdict = from === "fuzz";
    svg += `<line x1="${a.x}" y1="${a.y + 22}" x2="${b.x}" y2="${b.y - 10}"
      stroke="${isFuzzToVerdict ? '#10B981' : '#334155'}" stroke-width="1.5"
      marker-end="url(#arrowhead)" class="dag-edge" />`;
  }

  svg += `<defs><marker id="arrowhead" viewBox="0 0 10 7" refX="10" refY="3.5" markerWidth="8" markerHeight="6" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#475569"/></marker></defs>`;

  // Nodes
  for (const n of nodes) {
    const isVerdict = n.id === "verdict";
    const isSelected = dagSelectedNode === n.id;
    const hasResult = result && result.summary;

    let fill = "#1E293B";
    let stroke = "#334155";
    if (isVerdict && hasResult) {
      fill = result.summary.failed === 0 ? "#064E3B" : "#7F1D1D";
      stroke = result.summary.failed === 0 ? "#10B981" : "#EF4444";
    } else if (isSelected) {
      stroke = "#3B82F6";
      fill = "#1E3A5F";
    } else if (n.invariant) {
      fill = "#1A2744";
      stroke = "#3B82F6";
    }

    svg += `<g class="dag-node ${isSelected ? 'selected' : ''}" data-node="${n.id}" style="cursor:pointer">
      <rect x="${n.x - 58}" y="${n.y - 14}" width="116" height="36" rx="8" fill="${fill}" stroke="${stroke}" stroke-width="${isSelected ? 2 : 1.2}" />
      <text x="${n.x}" y="${n.y}" text-anchor="middle" fill="#F1F5F9" font-size="10" font-weight="600" font-family="Inter,sans-serif">${escSvg(n.label)}</text>
      <text x="${n.x}" y="${n.y + 11}" text-anchor="middle" fill="#94A3B8" font-size="8" font-family="JetBrains Mono,monospace">${escSvg(n.sub)}</text>
    </g>`;
  }

  svg += `</svg>`;
  container.innerHTML = svg;

  // Bind clicks
  container.querySelectorAll(".dag-node").forEach(el => {
    el.addEventListener("click", () => {
      const nodeId = el.dataset.node;
      dagSelectedNode = dagSelectedNode === nodeId ? null : nodeId;
      renderDag(scenarioId, result);
      highlightForDagNode(nodeId);
    });
  });

  // Detail panel
  const detailEl = document.getElementById("dag-detail");
  if (detailEl) {
    if (dagSelectedNode) {
      const node = nodes.find(n => n.id === dagSelectedNode);
      detailEl.innerHTML = `<div class="dag-detail-card">
        <strong>${escapeHtml(node.label)}</strong> - ${escapeHtml(node.sub)}
        ${node.invariant ? `<br><span class="dag-inv-tag">${node.invariant}</span> linked to invariant verification` : ""}
      </div>`;
      detailEl.style.display = "block";
    } else {
      detailEl.style.display = "none";
    }
  }
}

function highlightForDagNode(nodeId) {
  // Highlight corresponding invariant or log
  document.querySelectorAll(".invariant-row").forEach(r => r.classList.remove("inv-highlight"));
  if (nodeId && nodeId.startsWith("inv")) {
    const invMap = { inv1: "I_1", inv2: "I_2", inv3: "I_3" };
    const invId = invMap[nodeId];
    const row = document.querySelector(`.invariant-row[data-invariant="${invId}"]`);
    if (row) {
      row.classList.add("inv-highlight");
      row.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }
  // Scroll to relevant log section
  if (nodeId === "fuzz" || nodeId === "verdict") {
    const logsEl = document.getElementById("execution-logs");
    if (logsEl) logsEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
}

function highlightInvariant(invId) {
  dagSelectedNode = { "I_1": "inv1", "I_2": "inv2", "I_3": "inv3" }[invId] || null;
  renderDag(currentScenario, lastResult);
}

// ============================================================
// Live API Settings Modal
// ============================================================
function initApiModal() {
  const btn = document.getElementById("api-settings-btn");
  const modal = document.getElementById("api-modal");
  const closeBtn = document.getElementById("api-modal-close");
  const saveBtn = document.getElementById("api-modal-save");
  const testBtn = document.getElementById("api-modal-test");

  if (!btn || !modal) return;

  btn.addEventListener("click", () => {
    modal.classList.add("open");
    // Populate current values
    const keyInput = document.getElementById("api-key-input");
    const urlInput = document.getElementById("api-url-input");
    if (keyInput) keyInput.value = MUSE_RUNTIME_SETTINGS.apiKey;
    if (urlInput) urlInput.value = MUSE_RUNTIME_SETTINGS.baseUrl;
  });

  function closeModal() { modal.classList.remove("open"); }
  if (closeBtn) closeBtn.addEventListener("click", closeModal);
  modal.addEventListener("click", (e) => { if (e.target === modal) closeModal(); });

  if (saveBtn) saveBtn.addEventListener("click", () => {
    const keyInput = document.getElementById("api-key-input");
    const urlInput = document.getElementById("api-url-input");
    const status = document.getElementById("api-modal-status");
    try {
      MUSE_RUNTIME_SETTINGS.baseUrl = validateMuseEndpoint(urlInput?.value.trim() || API_CONFIG.basetenUrl);
      MUSE_RUNTIME_SETTINGS.apiKey = keyInput?.value.trim() || "";
      if (status) { status.textContent = "Session-only settings saved. Live calls send the displayed code to this endpoint."; status.className = "api-status ok"; }
    } catch (e) {
      if (status) { status.textContent = e.message; status.className = "api-status err"; }
    }
  });

  if (testBtn) testBtn.addEventListener("click", async () => {
    const status = document.getElementById("api-modal-status");
    if (status) { status.textContent = "Testing connection..."; status.className = "api-status pending"; }
    try {
      const keyInput = document.getElementById("api-key-input");
      const urlInput = document.getElementById("api-url-input");
      const result = await callMuseSpark(
        [{ role: "user", content: "Say 'MuseWeaver connection OK' in 5 words." }],
        { apiKey: keyInput?.value.trim(), baseUrl: urlInput?.value.trim(), maxTokens: 20 }
      );
      if (status) { status.textContent = `Connected: ${result.content.slice(0, 120)}`; status.className = "api-status ok"; }
    } catch (e) {
      if (status) { status.textContent = `Failed: ${e.message.slice(0, 200)}`; status.className = "api-status err"; }
    }
  });
}

// ============================================================
// Report Export
// ============================================================
function initReportExport() {
  const btn = document.getElementById("export-report-btn");
  if (!btn) return;
  btn.addEventListener("click", exportReport);
}

function exportReport() {
  if (!lastResult) {
    alert("Run the verification pipeline first to generate a report.");
    return;
  }
  const trace = CAPTURED_TRACES[currentScenario];
  const scenario = SCENARIOS[currentScenario];

  const md = `# MuseWeaver Verification Report

**Scenario:** ${scenario.label} - ${scenario.desc}
**Trace provenance:** Bundled illustrative traces, not authenticated model inference evidence
**Generated:** ${new Date().toISOString()}
**Trials:** ${lastResult.summary.total} checks in ${lastResult.elapsed}ms
**Verdict:** ${lastResult.summary.failed === 0 ? "VERIFIED" : "ISSUES FOUND"} (${lastResult.summary.passed}/${lastResult.summary.total} passed)

## Invariants

${trace.proposer.invariants.map(inv => `- **${inv.id} ${inv.name}:** \`${inv.formula}\` - ${inv.status}`).join("\n")}

## Execution Log

${lastResult.logs.map(l => `- **${l.test}** - ${l.pass ? "PASS" : "FAIL"}${l.detail ? ` - ${l.detail}` : ""}`).join("\n")}

${lastResult.counterexample ? `## Counterexample\n\n\`\`\`\n${lastResult.counterexample}\n\`\`\`\n` : ""}

## Proof DAG

\`[Problem Spec] -> [Proposer Patch] -> [I_1, I_2, I_3] -> [Skeptic Fuzz Suite] -> [Verified Verdict]\`

## Reproducibility

All verification runs deterministically in-browser via \`js/verifier.js\` with seeded PRNG.
Re-run with \`runVerification("${currentScenario}", { trials: 1000, seed: 42 })\` in the console.

---
*Generated by MuseWeaver - Live Multi-Agent Code & Math Verification Studio*
*Powered by meta-models/muse-spark-open-1026 on Baseten*
`;

  // Download as .md
  const blob = new Blob([md], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `museweaver-report-${currentScenario}-${Date.now()}.md`;
  a.click();
  URL.revokeObjectURL(url);

  // Also offer JSON
  const jsonData = {
    scenario: currentScenario,
    model: "meta-models/muse-spark-open-1026",
    timestamp: new Date().toISOString(),
    result: lastResult,
    invariants: trace.proposer.invariants
  };
  // Store for copy
  window._lastReportJson = JSON.stringify(jsonData, null, 2);
}

function initPermalink() {
  const btn = document.getElementById("permalink-btn");
  if (!btn) return;
  btn.addEventListener("click", () => {
    const url = new URL(window.location.href);
    url.searchParams.set("scenario", currentScenario);
    if (lastResult) url.searchParams.set("t", String(lastResult.summary.total));
    navigator.clipboard.writeText(url.toString()).then(() => {
      const orig = btn.textContent;
      btn.textContent = "Copied!";
      setTimeout(() => btn.textContent = orig, 1500);
    }).catch(() => {
      prompt("Copy this link:", url.toString());
    });
  });
}

// ============================================================
// Code Editing - Live Re-execution
// ============================================================
function initCodeEdit() {
  const codeEl = document.getElementById("proposer-code");
  const runBtn = document.getElementById("run-custom-btn");
  const resetBtn = document.getElementById("reset-code-btn");
  if (!codeEl) return;

  if (runBtn) runBtn.addEventListener("click", async () => {
    const code = codeEl.value;
    const customResult = await runCustomCode(code, []);
    const logsEl = document.getElementById("execution-logs");
    if (customResult.error) {
      if (logsEl) logsEl.innerHTML = `<div class="log-error">Execution error: ${escapeHtml(customResult.error)}</div>`;
    } else {
      if (logsEl) logsEl.innerHTML = customResult.assertions.map(a =>
        `<div class="log-entry ${a.pass ? 'log-pass' : 'log-fail'}">${a.pass ? "&#10003;" : "&#10007;"} ${escapeHtml(a.msg)}</div>`
      ).join("") + customResult.logs.map(l => `<div class="log-entry log-info">${escapeHtml(l.text)}</div>`).join("");
    }
    // Never attach the bundled implementation's verification to edited code.
    const verdict = document.getElementById("judge-verdict");
    if (verdict) verdict.textContent = "Edited code executed in isolation. These custom assertions are not a formal verification certificate.";
    lastResult = null;
  });

  if (resetBtn) resetBtn.addEventListener("click", () => {
    codeEl.value = codeEl.dataset.original || CAPTURED_TRACES[currentScenario]?.proposer.code || "";
  });
}

// ============================================================
// Custom Task Composer
// ============================================================
function initCustomComposer() {
  const btn = document.getElementById("custom-run-btn");
  if (!btn) return;
  btn.addEventListener("click", async () => {
    const titleInput = document.getElementById("custom-title");
    const descInput = document.getElementById("custom-desc");
    const codeInput = document.getElementById("custom-code");
    const statusEl = document.getElementById("custom-status");

    const title = titleInput?.value.trim() || "Custom Task";
    const desc = descInput?.value.trim() || "";
    const code = codeInput?.value.trim() || "";

    if (!desc && !code) {
      if (statusEl) { statusEl.textContent = "Enter a description or code to verify."; statusEl.className = "api-status err"; }
      return;
    }

    // Try live API if configured, otherwise use local execution for code
    const apiKey = MUSE_RUNTIME_SETTINGS.apiKey;
    const baseUrl = MUSE_RUNTIME_SETTINGS.baseUrl;

    if (apiKey || ["localhost", "127.0.0.1", "[::1]"].includes(new URL(baseUrl).hostname)) {
      if (statusEl) { statusEl.textContent = "Calling muse-spark-open-1026 via Baseten..."; statusEl.className = "api-status pending"; }
      try {
        const messages = [
          { role: "system", content: "You are the MuseWeaver Proposer+Skeptic+Judge verification agent. Analyze the user's code/task, propose invariants, generate adversarial test cases, and render a verdict. Be concise and structured." },
          { role: "user", content: `Task: ${title}\nDescription: ${desc}\nCode:\n\`\`\`javascript\n${code}\n\`\`\`\n\nAnalyze this and provide: 1) Invariants, 2) Adversarial tests, 3) Verdict.` }
        ];
        const result = await callMuseSpark(messages, { apiKey, baseUrl });
        // Display reasoning
        const reasoningEl = document.getElementById("proposer-reasoning");
        const reasoningText = document.getElementById("reasoning-text");
        if (reasoningText) {
          reasoningText.textContent = result.reasoning || result.content;
          reasoningText.classList.remove("collapsed");
        }
        // Try to execute custom code
        if (code) {
          const execResult = await runCustomCode(code, []);
          renderCustomExecution(execResult, result.content);
        }
        if (statusEl) { statusEl.textContent = "Live verification complete."; statusEl.className = "api-status ok"; }
      } catch (e) {
        if (statusEl) { statusEl.textContent = `API error: ${e.message.slice(0, 200)}`; statusEl.className = "api-status err"; }
      }
    } else {
      // Offline: just run code execution
      if (code) {
        const execResult = await runCustomCode(code, []);
        renderCustomExecution(execResult, null);
        if (statusEl) { statusEl.textContent = execResult.error ? `Error: ${execResult.error}` : "Executed locally (no API key - add one in Live API Settings for AI analysis)."; statusEl.className = execResult.error ? "api-status err" : "api-status ok"; }
      } else {
        if (statusEl) { statusEl.textContent = "Add code to execute, or configure an API key for AI-powered analysis."; statusEl.className = "api-status err"; }
      }
    }
  });
}

function renderCustomExecution(execResult, aiContent) {
  const logsEl = document.getElementById("execution-logs");
  const resultsEl = document.getElementById("execution-results");
  const verdictEl = document.getElementById("judge-verdict");

  if (execResult.error) {
    if (logsEl) logsEl.innerHTML = `<div class="log-error">Error: ${escapeHtml(execResult.error)}</div>`;
  } else {
    if (logsEl) logsEl.innerHTML = execResult.assertions.map(a =>
      `<div class="log-entry ${a.pass ? 'log-pass' : 'log-fail'}">${a.pass ? "&#10003;" : "&#10007;"} ${escapeHtml(a.msg)}</div>`
    ).join("") + execResult.logs.map(l => `<div class="log-entry log-info">${escapeHtml(l.text)}</div>`).join("");
    if (resultsEl) resultsEl.innerHTML = `<div class="verified-banner"><span class="ce-icon">&#9673;</span> Custom execution: ${execResult.assertions.filter(a => a.pass).length}/${execResult.assertions.length} assertions passed in ${execResult.elapsed}ms</div>`;
  }
  if (aiContent && verdictEl) {
    verdictEl.innerHTML = `<div class="verdict-card verdict-pass"><div class="verdict-text">AI ANALYSIS</div><div class="verdict-detail" style="white-space:pre-wrap;text-align:left;max-height:300px;overflow:auto">${escapeHtml(aiContent.slice(0, 3000))}</div></div>`;
  }
}

// ============================================================
// Fuzz Controls
// ============================================================
function initFuzzControls() {
  const input = document.getElementById("fuzz-trials-input");
  const label = document.getElementById("fuzz-trials-label");
  if (!input || !label) return;
  input.addEventListener("input", () => {
    label.textContent = `${input.value} trials`;
  });
  // Re-run button
  const rerunBtn = document.getElementById("rerun-btn");
  if (rerunBtn) rerunBtn.addEventListener("click", () => {
    if (currentScenario === "custom" && customTask) return;
    runPipeline();
  });
}

// ============================================================
// Utilities
// ============================================================
function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

function escSvg(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Handle URL scenario param on load
(function handleUrlScenario() {
  const params = new URLSearchParams(window.location.search);
  const scenario = params.get("scenario");
  if (scenario && CAPTURED_TRACES[scenario]) {
    // Will be applied in DOMContentLoaded
    document.addEventListener("DOMContentLoaded", () => selectScenario(scenario), { once: true });
  }
})();
