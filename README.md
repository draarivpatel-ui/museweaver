# MuseWeaver - Live Multi-Agent Code & Math Verification Studio

> **Powered by `meta-models/muse-spark-open-1026` via Baseten**

MuseWeaver is an award-crafted interactive web application that demonstrates a **Proposer → Skeptic → Judge** multi-agent verification loop, all running live in the browser with real deterministic execution and zero fake telemetry.

Built for the **Meta Global AI Developer Hackathon on Cerebral Valley** - Indie Developer Track + Best Build on Meta Open Weight Models + Best Agentic Use-Case.

---

## What It Does

MuseWeaver takes hard computer science problems and runs them through a three-agent pipeline:

| Stage | Agent | Role |
|-------|-------|------|
| **1. Proposer** | `muse-spark-open-1026` | Generates the algorithm, reasoning trace, and formal invariants |
| **2. Skeptic** | `muse-spark-open-1026` | Adversarially critiques the proposal and generates boundary/fuzz tests |
| **3. Judge** | Deterministic engine | Executes 1,000 fuzz trials in-browser and synthesizes a formal verdict |

The entire verification suite - including property-based fuzzing, counterexample search, and invariant checking - runs **for real** in the browser via `performance.now()` timing and real JavaScript assertions. No mocks, no simulated results.

---

## The Three Benchmark Scenarios

### 1. Lock-Free Token Bucket Rate Limiter
**Badge:** `CONCURRENCY`

A naive float-based token bucket accumulates IEEE 754 rounding errors and mishandles burst-boundary timing. MuseWeaver's verified fix uses **integer microsecond CAS** - zero drift, zero races.

- **Invariants:** Capacity Bound (`microTokens ≤ C·10⁶`), Conservation, Rate Fidelity
- **Bug caught:** Float drift of ~1 micro-token per burst window

### 2. Byzantine Quorum Consensus Threshold
**Badge:** `CONSENSUS`

Proves why `N = 3f` is unsafe under equivocation and `N = 3f + 1` is necessary and tight. The skeptic constructs an explicit **equivocation attack matrix** showing split-brain with `N = 6, f = 2`.

- **Invariants:** Honest Intersection (`|Q₁ ∩ Q₂ ∩ H| ≥ 1`), No Split-Brain, Threshold Minimality
- **Bug caught:** Two quorums `{0,1,4,5}` and `{2,3,4,5}` sharing zero honest nodes

### 3. Battery Arbitrage with Degradation Penalty
**Badge:** `OPTIMIZATION`

A greedy strategy looks locally optimal but is globally suboptimal. The verified **Bellman DP** finds the true optimum, cross-checked against brute-force enumeration.

- **Invariants:** Bellman Optimality, SOC Bounds, Brute-Force Agreement
- **Bug caught:** Greedy profit `2.0` vs DP optimum `7.0` on price curve `[3, 1, 10, 2]`

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  index.html  - Dark studio UI (#0B0F17, Space Grotesk)  │
│  styles.css  - Responsive, high-contrast, micro-anims   │
├─────────────────────────────────────────────────────────┤
│  js/captured-traces.js                                  │
│    • Real reasoning_content traces from muse-spark-open  │
│    • Live API client (Baseten + localhost:20128 proxy)  │
├─────────────────────────────────────────────────────────┤
│  js/verifier.js  - Deterministic execution engine        │
│    • Naive (buggy) vs Verified implementations           │
│    • Property-based fuzzing with seeded PRNG             │
│    • Real counterexample search                          │
├─────────────────────────────────────────────────────────┤
│  js/app.js  - UI controller                             │
│    • Scenario switching, pipeline animation               │
│    • Interactive SVG Proof DAG                           │
│    • Report export, permalink, live API modal            │
└─────────────────────────────────────────────────────────┘
```

### How `muse-spark-open-1026` Powers the Loop

1. **Proposer** - The model's `reasoning_content` chain-of-thought is captured verbatim and displayed as an inspectable trace. It derives the algorithm, identifies the bug class, and extracts formal invariants `I₁, I₂, I₃`.

2. **Skeptic** - A second call (or the same trace's adversarial section) generates boundary test cases and fuzz strategies targeting the exact vulnerability.

3. **Judge** - Deterministic synthesis: the in-browser engine runs both implementations, checks every invariant, searches for counterexamples, and renders the verdict + Proof DAG.

When a **Baseten API key** is configured (via the Live API Settings modal), the app can call `https://inference.baseten.co/v1/chat/completions` live. A local proxy at `http://localhost:20128/v1/chat/completions` is also supported. Without a key, the app runs fully offline using captured traces + the live execution sandbox - every button still works.

---

## Quickstart

### GitHub Pages

The app is a fully static site. Push to `gh-pages` or configure Pages to serve from the `museweaver/` directory:

```
https://aariv.me/museweaver/
```

### Local

```bash
cd museweaver
python3 -m http.server 8000
# Open http://localhost:8000
```

No build step, no dependencies, no bundler. Just open `index.html`.

### Live API (Optional)

1. Click **Live API Settings** in the header
2. Enter your Baseten API key (from [baseten.co](https://baseten.co))
3. Optionally set a custom inference URL (e.g., `http://localhost:20128/v1/chat/completions` for local OmniRoute)
4. Click **Test Connection** to verify, then **Save Settings**
5. Use the **Custom Task Composer** to send live prompts to `muse-spark-open-1026`

Without an API key, all three benchmark scenarios work perfectly via captured traces.

---

## Verification Benchmarks

All benchmarks run deterministically with `seed=42`:

| Scenario | Checks | Pass Rate | Time | Bug Caught |
|----------|--------|-----------|------|------------|
| Rate Limiter | ~1,005 | 100% verified | ~15ms | Float drift confirmed |
| Quorum | ~12 | 100% verified | ~5ms | Split-brain with N=3f |
| Battery DP | ~1,008 | 100% verified | ~30ms | Greedy suboptimal by 5.0 |

Run any benchmark from the browser console:

```javascript
runVerification("rate-limiter", { trials: 1000, seed: 42 })
runVerification("quorum", { trials: 1000, seed: 42 })
runVerification("battery", { trials: 1000, seed: 42 })
```

---

## Project Requirements Checklist

- [x] Uses `meta-models/muse-spark-open-1026` via Baseten inference
- [x] Proxied locally at `http://localhost:20128/v1/chat/completions` as `baseten/meta-models/muse-spark-open-1026`
- [x] Runs 100% on GitHub Pages (`https://aariv.me/museweaver/`) and locally (`python3 -m http.server`)
- [x] Zero console errors, zero fake telemetry, real deterministic verification
- [x] High-craft dark studio UI with specified color palette and fonts
- [x] All buttons functional, zero placeholders or TODOs

---

## License

MIT - Built with care for the Meta Global AI Developer Hackathon.
