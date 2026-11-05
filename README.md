# MuseWeaver

A local verification studio for developer-agent proposals. Mathematical checks run in Z3, deterministic property tests run in JavaScript, and custom code runs in an isolated browser worker.

## Start and verify

```bash
python3 -m http.server 8000
```

Open `http://localhost:8000`. The bundled scenarios do not need a model, API key or build step. Browser fonts may fall back when offline.

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements-dev.txt
.venv/bin/python formal_verifier.py
.venv/bin/python -m pytest -q
npm test
```

Browser regression tests use a throwaway headless Chromium profile. On Linux, install the test browser with `.venv/bin/python -m playwright install --with-deps chromium`.

## What is actually verified

The Python verifier accepts a small structured proposal language, not arbitrary generated Python or JavaScript.

For a token bucket, capacity is a positive integer, balances are integer microtokens and refill is any nonnegative integer increment. Z3 searches for a violation of capacity bounds, nonnegative balance, inclusive admission at one token and exact agreement with the reference transition. A correct candidate returns `unsat`. Missing clamping, incorrect debit and strict-boundary admission return concrete counterexamples.

Quorum verification checks both `2q - N > f` for an honest shared member and `q <= N - f` for availability. A threshold can satisfy intersection while preventing progress. The local demo exposes that distinction.

Unknown proposal schemas, malformed values, solver errors and inconclusive solver results are not approval. The proofs apply to these mathematical models. They are not compiler-checked proofs of the entire application.

## Browser studio

The three scenarios remain available.

- Exact integer token buckets compared with a floating-point baseline. BigInt intermediates prevent overflow before saturation.
- Byzantine quorum intersection and an explicit split-brain construction for an insufficient threshold.
- Battery scheduling with a Bellman dynamic program, state-of-charge checks and small-instance brute-force comparisons.

Seed zero is supported, fuzz controls are bounded, and the displayed duration is measured. Expected failures in a deliberately flawed baseline are distinct from violations in the tested implementation.

The Proposer, Skeptic and Judge panels contain bundled illustrative reasoning traces. They are not authenticated model-inference transcripts. The pipeline animation does not launch three live agents.

## Developer-agent boundary

The companion BlastRadius Zero project provides the default-deny action gate. The research package combines this verifier with that actual gate and evaluates four ablations on labelled arithmetic mutants and structured action fixtures.

In the campaign workspace, run `../../kaggle_submissions/gemma-4-developer-agent-paper/guardrail_benchmark.py`. The package includes raw decisions, counterexamples, source hashes, measured tables, an academic writeup and an executable notebook. Its examples are generated fixtures. No Gemma inference result is claimed.

This is a useful boundary for an open-weights developer agent because candidate generation and approval are separate. A model may propose a transition and action; only a verified transition and permitted action can pass the combined boundary. No executor is included.

## Isolated custom execution

Edited code no longer executes in the host page with a Function constructor. An opaque-origin sandbox frame owns a blob worker with network-denying Content Security Policy. The host owns the execution deadline and removes the frame after success, error or timeout.

Custom code can use `assert`, `log` and asynchronous operations. Output sizes are bounded. The supplied tests execute inside the same isolated context. A loop that never returns is timed out without freezing the host.

These assertions are observations supplied by untrusted code, not certificates. A malicious program can lie about its own assertions. Browser compromise and memory-exhaustion attacks are outside this containment claim.

## Optional model integration

Live inference is opt-in. The existing Baseten client accepts HTTPS on the exact provider hostname or an exact loopback host. Credential-bearing URLs, query parameters, misleading hostname matches and redirects are rejected.

Keys are session-only and are not written to localStorage. The old persistent key is removed on load. Live calls transmit the displayed task and code to the selected endpoint. The local benchmark does not make those calls, download weights or incur inference charges.

## Evidence and competition status

Kiro specs and hooks are included as inspectable development assets. Their presence alone does not prove Kiro was used. The hook executes actual Node regression tests.

Kiroween 2026 requires an age-of-majority entrant, substantial Kiro usage, a new project during the submission window, a public licensed repository and a working demonstration under three minutes. Those requirements must be established before entry. No competition eligibility, prize, acceptance or deployment is claimed by this repository.

MIT licensed. AI-assisted implementation and documentation are disclosed.
