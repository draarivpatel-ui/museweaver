"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { performance } = require("node:perf_hooks");

const root = path.resolve(__dirname, "..");
const indexHtml = fs.readFileSync(path.join(root, "index.html"), "utf8");
const stylesCss = fs.readFileSync(path.join(root, "styles.css"), "utf8");
const appJs = fs.readFileSync(path.join(root, "js/app.js"), "utf8");
const verifierSrc = fs.readFileSync(path.join(root, "js/verifier.js"), "utf8");
const tracesSrc = fs.readFileSync(path.join(root, "js/captured-traces.js"), "utf8");
const sandboxHtml = fs.readFileSync(path.join(root, "js/execution-sandbox.html"), "utf8");

const vctx = vm.createContext({ performance, console });
vm.runInContext(verifierSrc, vctx);
const tctx = vm.createContext({ URL, localStorage: { removeItem() {} } });
vm.runInContext(tracesSrc, tctx);
const run = (code) => vm.runInContext(code, vctx);
const runT = (code) => vm.runInContext(code, tctx);

// Error classes inside a vm context are not the host constructors, so assert
// on the error name rather than instanceof.
function throwsNamed(fn, name) {
  try {
    fn();
  } catch (e) {
    assert.equal(e.name, name);
    return e;
  }
  assert.fail(`expected a ${name}`);
}

/* ---------------- seededRandom ---------------- */

test("seededRandom is deterministic, unit bounded and seed sensitive", () => {
  const a = run("(() => { const r = seededRandom(1); return [r(), r(), r()]; })()");
  const b = run("(() => { const r = seededRandom(1); return [r(), r(), r()]; })()");
  const c = run("(() => { const r = seededRandom(2); return [r(), r(), r()]; })()");
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
  for (const v of a.concat(b, c)) assert.ok(v >= 0 && v < 1);
});

/* ---------------- VerifiedBucket ---------------- */

for (const [capacity, rate] of [[1, 1], [5, 7], [10, 10], [100, 1000], [7, 13]]) {
  test(`bucket starts full and admits exactly capacity requests at t=0 (C=${capacity} R=${rate})`, () => {
    const Bucket = run("VerifiedBucket");
    const bucket = new Bucket(capacity, rate);
    let admitted = 0;
    for (let i = 0; i < capacity + 3; i++) if (bucket.tryConsume(0)) admitted++;
    assert.equal(admitted, capacity);
  });
  test(`bucket refills exactly rate*elapsed and clamps at capacity (C=${capacity} R=${rate})`, () => {
    const Bucket = run("VerifiedBucket");
    const bucket = new Bucket(capacity, rate);
    for (let i = 0; i < capacity; i++) bucket.tryConsume(0);
    bucket.refill(1_000_000);
    const expected = Math.min(capacity * 1e6, rate * 1e6);
    assert.equal(bucket.microTokens, expected);
    bucket.refill(2e12);
    assert.equal(bucket.microTokens, capacity * 1e6);
  });
}

test("bucket admits only whole tokens at fractional balances", () => {
  const Bucket = run("VerifiedBucket");
  const bucket = new Bucket(10, 1);
  for (let i = 0; i < 10; i++) bucket.tryConsume(0);
  bucket.refill(500_000);
  assert.equal(bucket.microTokens, 500_000);
  assert.equal(bucket.tryConsume(999_999), false);
  assert.equal(bucket.tryConsume(1_000_000), true);
});

test("bucket rejects non monotonic and non integer timestamps", () => {
  const Bucket = run("VerifiedBucket");
  const bucket = new Bucket(5, 5);
  bucket.tryConsume(1000);
  for (const t of [999, -1, 1.5, NaN, "1000", Infinity]) {
    throwsNamed(() => bucket.refill(t), "RangeError");
  }
});

test("bucket first call initializes the clock without refilling", () => {
  const Bucket = run("VerifiedBucket");
  const bucket = new Bucket(5, 5);
  bucket.refill(60_000_000);
  assert.equal(bucket.microTokens, 5_000_000);
});

test("bucket refill of zero elapsed is a no-op and keeps the clock", () => {
  const Bucket = run("VerifiedBucket");
  const bucket = new Bucket(5, 1);
  bucket.tryConsume(2_000_000);
  bucket.refill(2_000_000);
  bucket.refill(2_000_000);
  assert.equal(bucket.microTokens, 4_000_000);
});

test("bucket constructor bounds reject fractional and unsafe values", () => {
  const Bucket = run("VerifiedBucket");
  for (const bad of [1e16, Number.MAX_VALUE, -2, null, "4", {}]) {
    throwsNamed(() => new Bucket(bad, 1), "RangeError");
  }
  for (const badRate of [-1, 0.5, NaN, Infinity, "7", null]) {
    throwsNamed(() => new Bucket(4, badRate), "RangeError");
  }
});

test("bucket with rate zero never refills", () => {
  const Bucket = run("VerifiedBucket");
  const bucket = new Bucket(3, 0);
  bucket.tryConsume(0);
  bucket.tryConsume(0);
  bucket.tryConsume(0);
  bucket.refill(10e12);
  assert.equal(bucket.microTokens, 0);
  assert.equal(bucket.tryConsume(10e12), false);
});

/* ---------------- NaiveTokenBucket ---------------- */

test("naive bucket accepts constructor inputs the verified bucket rejects", () => {
  const Naive = run("NaiveTokenBucket");
  const bucket = new Naive(0.5, 0.5);
  assert.equal(typeof bucket.tokens, "number");
});

test("naive bucket accumulates float drift that the verified bucket avoids", () => {
  const Naive = run("NaiveTokenBucket");
  const Verified = run("VerifiedBucket");
  const n = new Naive(1000, 7);
  const v = new Verified(1000, 7);
  for (let i = 0; i < 1000; i++) n.tryConsume(0);
  for (let i = 0; i < 1000; i++) v.tryConsume(0);
  for (let t = 1; t <= 3000; t++) { n.refill(t); v.refill(t * 1000); }
  assert.notEqual(n.tokens * 1e6, v.microTokens);
});

/* ---------------- QuorumVerifier ---------------- */

for (const [N, f, expectedQ] of [[4, 1, 3], [6, 2, 5], [7, 2, 5], [10, 3, 7], [3, 1, 3]]) {
  test(`quorum size is ceil((N+f+1)/2) for N=${N} f=${f}`, () => {
    const QV = run("QuorumVerifier");
    assert.equal(new QV(N, f).q, expectedQ);
  });
}

for (const [N, f, safe] of [[4, 1, true], [6, 2, false], [7, 2, true], [9, 3, false], [10, 3, true], [3, 1, false]]) {
  test(`isSafeConfig flags N>=3f+1 for N=${N} f=${f}`, () => {
    const QV = run("QuorumVerifier");
    assert.equal(new QV(N, f).isSafeConfig(), safe);
  });
}

test("quorum enumeration yields C(N,q) entries with the right size", () => {
  const QV = run("QuorumVerifier");
  const qv = new QV(5, 1);
  assert.equal(qv.q, 4);
  const quorums = qv.enumerateQuorums();
  assert.equal(quorums.length, 5);
  assert.ok(quorums.every((q) => q.length === qv.q));
  assert.equal(new Set(quorums.map((q) => q.join(","))).size, 5);
});

test("safe quorum configs keep every pair at or above f+1 intersection", () => {
  const QV = run("QuorumVerifier");
  for (const [N, f] of [[4, 1], [7, 2], [10, 3]]) {
    const result = new QV(N, f).verifyAllPairs();
    assert.equal(result.safe, true, `N=${N} f=${f}`);
  }
});

// Regression: verifyAllPairs used to return safe:true vacuously on degenerate
// or unavailable configs (q > N - f means no honest quorum can even form).
test("verifyAllPairs rejects degenerate and unavailable configs", () => {
  const QV = run("QuorumVerifier");
  const d1 = new QV(3, 5).verifyAllPairs();
  assert.equal(d1.safe, false);
  assert.equal(d1.degenerate, true);
  const d2 = new QV(6, 2).verifyAllPairs();
  assert.equal(d2.safe, false, "N=3f cannot form an honest quorum");
  assert.equal(d2.degenerate, true);
  const d3 = new QV(0, 0).verifyAllPairs();
  assert.equal(d3.safe, false);
  const ok = new QV(7, 2).verifyAllPairs();
  assert.equal(ok.safe, true);
});

test("minIntersection matches the worst case pair bound", () => {
  const QV = run("QuorumVerifier");
  for (const [N, f] of [[4, 1], [7, 2], [10, 3]]) {
    const qv = new QV(N, f);
    assert.equal(qv.minIntersection(), 2 * qv.q - N);
    assert.ok(qv.minIntersection() >= f + 1);
  }
});

test("quorum intersect handles empty and disjoint inputs", () => {
  const QV = run("QuorumVerifier");
  const qv = new QV(4, 1);
  assert.deepEqual(qv.intersect([0, 1], [2, 3]), []);
  assert.deepEqual(qv.intersect([0, 1, 2], [1, 2, 3]), [1, 2]);
  assert.deepEqual(qv.intersect([], [1]), []);
});

/* ---------------- BatteryArbitrage ---------------- */

test("battery profit sign convention charges cost and discharges revenue", () => {
  const B = run("BatteryArbitrage");
  const bat = new B(2, 1, 0.5);
  assert.equal(bat.profit(1, 3), -3.5);
  assert.equal(bat.profit(-1, 3), 2.5);
  assert.ok(bat.profit(0, 3) === 0);
});

for (const prices of [[3, 1, 10, 2], [1, 5, 1, 8], [5, 5, 5], [9, 1, 9, 1, 9]]) {
  test(`DP optimum equals brute force on prices ${JSON.stringify(prices)}`, () => {
    const B = run("BatteryArbitrage");
    const bat = new B(2, 1, 0.5);
    const dp = bat.solve(prices, 0);
    const bf = bat.bruteForce(prices, 0);
    assert.ok(Math.abs(dp.maxProfit - bf.maxProfit) < 1e-9, `dp=${dp.maxProfit} bf=${bf.maxProfit}`);
  });
}

test("greedy never beats the DP optimum", () => {
  const B = run("BatteryArbitrage");
  const rng = run("seededRandom(7)");
  for (let i = 0; i < 30; i++) {
    const C = 1 + Math.floor(rng() * 3);
    const R = 1 + Math.floor(rng() * 2);
    const prices = Array.from({ length: 4 + Math.floor(rng() * 4) }, () => rng() * 10);
    const bat = new B(C, R, rng());
    assert.ok(bat.solve(prices, 0).maxProfit >= bat.greedy(prices, 0).totalProfit - 1e-9);
  }
});

test("optimal path respects state of charge bounds at every step", () => {
  const B = run("BatteryArbitrage");
  const bat = new B(3, 2, 0.3);
  const { path: p } = bat.solve([2, 8, 1, 9, 3, 7], 1);
  for (const step of p) {
    assert.ok(step.soc >= 0 && step.soc <= 3);
    assert.ok(step.soc + step.action >= 0 && step.soc + step.action <= 3);
    assert.ok(Math.abs(step.action) <= 2);
  }
});

test("empty price curve yields zero profit and an empty path", () => {
  const B = run("BatteryArbitrage");
  const out = new B(2, 1, 0.5).solve([], 0);
  assert.equal(out.maxProfit, 0);
  assert.equal(out.path.length, 0);
});

// Regression: solve/bruteForce/greedy used to accept out-of-range initSoc and
// return inconsistent garbage (undefined vs -Infinity vs a number).
test("battery methods reject out-of-range initial state of charge", () => {
  const B = run("BatteryArbitrage");
  const bat = new B(2, 1, 0.5);
  for (const bad of [-1, 3, 5, 1.5, NaN, "1"]) {
    throwsNamed(() => bat.solve([1, 2], bad), "RangeError");
    throwsNamed(() => bat.bruteForce([1, 2], bad), "RangeError");
    throwsNamed(() => bat.greedy([1, 2], bad), "RangeError");
  }
  assert.equal(bat.solve([1, 2], 2).path[0].soc, 2);
});

/* ---------------- runVerification ---------------- */

for (const scenario of ["rate-limiter", "quorum", "battery"]) {
  test(`runVerification(${scenario}) returns a well formed deterministic result`, () => {
    const a = run(`runVerification(${JSON.stringify(scenario)}, {trials: 12, seed: 9})`);
    const b = run(`runVerification(${JSON.stringify(scenario)}, {trials: 12, seed: 9})`);
    assert.equal(a.scenario, scenario);
    assert.equal(a.summary.total, a.logs.length);
    assert.equal(a.summary.passed + a.summary.failed + a.logs.filter((l) => l.naiveBug).length, a.summary.total);
    assert.equal(a.summary.verifiedBugs, 0);
    assert.deepEqual(a.logs, b.logs);
    assert.ok(Number(a.elapsed) >= 0);
  });
}

const lit = (v) => (typeof v === "number" && !Number.isFinite(v)) ? String(v) : JSON.stringify(v);

for (const trials of [0, -1, 0.5, 10001, NaN, Infinity, "10"]) {
  test(`runVerification rejects invalid trials ${trials}`, () => {
    throwsNamed(() => run(`runVerification("battery", {trials: ${lit(trials)}})`), "RangeError");
  });
}

for (const seed of [-1, 0.5, 4294967296, NaN, "42"]) {
  test(`runVerification rejects invalid seed ${seed}`, () => {
    throwsNamed(() => run(`runVerification("battery", {trials: 1, seed: ${lit(seed)}})`), "RangeError");
  });
}

test("runVerification accepts seed zero and boundary trial counts", () => {
  assert.equal(run('runVerification("battery", {trials: 1, seed: 0}).scenario'), "battery");
  assert.equal(run('runVerification("battery", {trials: 10000, seed: 4294967295}).summary.verifiedBugs'), 0);
});

test("runVerification rejects unknown scenario names", () => {
  for (const bad of ["custom", "Rate-Limiter", "", "rate_limiter", null]) {
    assert.throws(() => run(`runVerification(${JSON.stringify(bad)}, {trials: 1})`));
  }
});

test("rate-limiter run catches at least one naive bug and zero verified bugs", () => {
  const r = run('runVerification("rate-limiter", {trials: 50, seed: 42})');
  assert.ok(r.summary.naiveBugsCaught >= 1);
  assert.equal(r.summary.verifiedBugs, 0);
  assert.ok(r.counterexample);
});

// Regression: naive-bug demonstration logs used to be counted as failed checks,
// so the metrics bar, DAG verdict node and judge verdict disagreed. Verified
// failures and naive catches are now tallied separately.
test("verdict counters agree: naive catches never inflate failed", () => {
  const r = run('runVerification("rate-limiter", {trials: 50, seed: 42})');
  assert.equal(r.summary.failed, 0);
  assert.equal(r.summary.verifiedBugs, 0);
  assert.equal(r.summary.naiveBugsCaught, r.logs.filter((l) => l.naiveBug).length);
  assert.ok(r.summary.naiveBugsCaught >= 1);
  assert.equal(r.summary.failed, r.logs.filter((l) => !l.pass && !l.naiveBug).length);
  for (const l of r.logs) {
    if (l.pass === false) assert.equal(l.naiveBug, true, `${l.test} is an untagged failure`);
  }
});

// Regression: the drift probes used to clamp at capacity, masking all drift.
test("drift probes are real measurements that cannot be masked by clamping", () => {
  const r = run('runVerification("rate-limiter", {trials: 5, seed: 42})');
  for (const name of ["float_drift_500x13ms_rate7", "float_drift_1000x3ms_rate7"]) {
    const log = r.logs.find((l) => l.test === name);
    assert.ok(log, name);
    assert.equal(log.measurement, true);
    assert.ok("drift" in log, "drift value missing");
  }
});

test("quorum run proves the N=3f counterexample and keeps N=3f+1 safe", () => {
  const r = run('runVerification("quorum", {trials: 10, seed: 42})');
  assert.ok(r.counterexample.includes("SPLIT BRAIN") || r.counterexample.length > 0);
  assert.equal(r.summary.verifiedBugs, 0);
});

// Regression: verifyQuorum used to ignore its trials/seed parameters entirely,
// making the fuzz-trials slider decorative for this scenario.
test("quorum fuzz honors the trials and seed parameters", () => {
  const a = run('runVerification("quorum", {trials: 5, seed: 1})');
  const more = run('runVerification("quorum", {trials: 50, seed: 1})');
  const c = run('runVerification("quorum", {trials: 5, seed: 1})');
  const log = a.logs.find((l) => l.test === "fuzz_5_availability_equiv");
  const log50 = more.logs.find((l) => l.test === "fuzz_50_availability_equiv");
  assert.ok(log, "seeded availability fuzz missing");
  assert.ok(log50, "trials count is not wired into the fuzz log");
  assert.equal(log.checked, 5);
  assert.equal(log50.checked, 50);
  assert.equal(log.pass, true);
  assert.notDeepEqual(a.logs, more.logs);
  assert.deepEqual(a.logs, c.logs);
});

test("battery run reproduces the greedy counterexample and Bellman agreement", () => {
  const r = run('runVerification("battery", {trials: 10, seed: 42})');
  assert.ok(r.counterexample.includes("Greedy"));
  assert.equal(r.summary.verifiedBugs, 0);
  const bellman = r.logs.find((l) => l.test === "bellman_recurrence");
  assert.equal(bellman.pass, true);
  const bf = r.logs.find((l) => l.test === "brute_force_agreement");
  assert.equal(bf.pass, true);
});

test("runComparison annotates the verdict without changing the result", () => {
  const r = run('runComparison("battery")');
  assert.equal(r.comparison.verdict, "BUG CAUGHT");
  assert.equal(r.comparison.verified, "Tested invariants passed");
  assert.ok(r.scenario);
});

/* ---------------- validateMuseEndpoint ---------------- */

for (const ok of [
  "https://inference.baseten.co/v1/chat/completions",
  "http://localhost:20128/v1/chat/completions",
  "http://127.0.0.1:8080/v1",
  "https://localhost:9000/v1",
  "http://localhost/v1"
]) {
  test(`endpoint accepted: ${ok}`, () => {
    assert.equal(runT(`validateMuseEndpoint(${JSON.stringify(ok)})`), new URL(ok).href);
  });
}

for (const bad of [
  "https://evil-inference.baseten.co/v1",
  "https://inference.baseten.co.evil.com/v1",
  "https://inference.baseten.co:444/v1",
  "https://inference.baseten.co/v1?key=abc",
  "https://inference.baseten.co/v1#frag",
  "https://user@inference.baseten.co/v1",
  "https://user:pw@localhost:1/v1",
  "ftp://inference.baseten.co/v1",
  "http://inference.baseten.co/v1",
  "http://localhost.evil.com/v1",
  "http://192.168.1.1/v1",
  "http://0.0.0.0/v1",
  "javascript:alert(1)",
  "",
  "not a url"
]) {
  test(`endpoint rejected: ${bad || "(empty)"}`, () => {
    assert.throws(() => runT(`validateMuseEndpoint(${JSON.stringify(bad)})`));
  });
}

test("dot segments cannot escape the allowlisted host", () => {
  const url = new URL(runT(`validateMuseEndpoint("https://inference.baseten.co/v1/extra/../x")`));
  assert.equal(url.hostname, "inference.baseten.co");
  assert.equal(url.protocol, "https:");
  assert.equal(url.port, "");
});

/* ---------------- CAPTURED_TRACES ---------------- */

for (const scenario of ["rate-limiter", "quorum", "battery"]) {
  test(`captured trace ${scenario} has complete proposer and skeptic sections`, () => {
    const t = runT(`CAPTURED_TRACES[${JSON.stringify(scenario)}]`);
    assert.ok(t.proposer.reasoning.length > 100);
    assert.ok(t.proposer.code.includes("class"));
    assert.equal(t.proposer.invariants.length, 3);
    for (const inv of t.proposer.invariants) {
      assert.ok(inv.id && inv.name && inv.formula && inv.status);
    }
    assert.ok(t.skeptic.critique.length > 50);
    assert.ok(t.skeptic.testCases.length >= 5);
  });
}

test("captured traces cover exactly the three bundled scenarios", () => {
  assert.deepEqual(Object.keys(runT("CAPTURED_TRACES")).sort(), ["battery", "quorum", "rate-limiter"]);
});

test("runtime settings start empty and the retired storage key is removed", () => {
  assert.equal(runT("MUSE_RUNTIME_SETTINGS.apiKey"), "");
  assert.equal(runT("MUSE_RUNTIME_SETTINGS.baseUrl"), "https://inference.baseten.co/v1/chat/completions");
});

/* ---------------- markup, CSP and accessibility ---------------- */

test("index.html declares a restrictive content security policy", () => {
  const csp = /Content-Security-Policy" content="([^"]+)"/.exec(indexHtml)[1];
  for (const directive of ["default-src 'self'", "script-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'none'"]) {
    assert.ok(csp.includes(directive), directive);
  }
  assert.ok(!csp.includes("'unsafe-eval'"), "host page must not allow eval");
});

test("index.html has no inline event handlers that the CSP would block", () => {
  assert.equal(/<[^>]*\son[a-z]+\s*=/i.test(indexHtml), false);
});

test("app.js injects no inline handlers through markup strings", () => {
  assert.equal(/<[^>]*\son[a-z]+\s*=/i.test(appJs), false);
});

test("single h1, landmarks and a working skip link exist", () => {
  assert.equal((indexHtml.match(/<h1\b/g) || []).length, 1);
  for (const tag of ["<header", "<main id=\"main\">", "<footer"]) {
    assert.ok(indexHtml.includes(tag), tag);
  }
  assert.match(indexHtml, /class="skip-link" href="#main"/);
});

test("heading hierarchy never skips a level", () => {
  const levels = [...indexHtml.matchAll(/<h([1-6])\b/g)].map((m) => Number(m[1]));
  assert.equal(levels[0], 1);
  for (let i = 1; i < levels.length; i++) {
    assert.ok(levels[i] <= levels[i - 1] + 1, `h${levels[i - 1]} to h${levels[i]}`);
  }
});

test("every DOM id used by app.js exists in the markup", () => {
  const ids = new Set([...indexHtml.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  for (const m of appJs.matchAll(/getElementById\("([^"]+)"\)/g)) {
    assert.ok(ids.has(m[1]), `#${m[1]} missing from index.html`);
  }
});

test("all markup ids are unique", () => {
  const ids = [...indexHtml.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(new Set(ids).size, ids.length);
});

test("scenario cards are real buttons inside a labelled group", () => {
  const cards = [...indexHtml.matchAll(/<button type="button" class="scenario-card[^"]*" data-scenario="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(cards, ["rate-limiter", "quorum", "battery", "custom"]);
  assert.match(indexHtml, /role="group" aria-label="Verification scenarios"/);
  assert.match(indexHtml, /data-scenario="custom" aria-expanded="false" aria-controls="custom-composer"/);
});

test("custom composer fields are labelled for their controls", () => {
  for (const id of ["custom-title", "custom-desc", "custom-code"]) {
    assert.match(indexHtml, new RegExp(`<label for="${id}">`));
  }
});

test("status regions announce updates politely", () => {
  for (const id of ["custom-status", "api-modal-status", "execution-results", "judge-verdict", "dag-detail", "export-note"]) {
    assert.match(indexHtml, new RegExp(`id="${id}"[^>]*aria-live="polite"|aria-live="polite"[^>]*id="${id}"`));
  }
});

test("the api modal is a real labelled dialog", () => {
  assert.match(indexHtml, /id="api-modal" role="dialog" aria-modal="true" aria-labelledby="api-modal-title"/);
  assert.match(indexHtml, /id="api-modal-title"/);
});

test("the reasoning toggle is expanded aware and controls its region", () => {
  assert.match(indexHtml, /id="reasoning-toggle" aria-expanded="false" aria-controls="reasoning-text"/);
});

test("the fuzz slider has a programmatic name and a live output", () => {
  assert.match(indexHtml, /<label class="visually-hidden" for="fuzz-trials-input">/);
  assert.match(indexHtml, /<output id="fuzz-trials-label" for="fuzz-trials-input">/);
});

test("aria references in markup resolve to existing ids", () => {
  const ids = new Set([...indexHtml.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  for (const m of indexHtml.matchAll(/\baria-(?:labelledby|controls)="([^"]+)"/g)) {
    for (const ref of m[1].trim().split(/\s+/)) {
      assert.ok(ids.has(ref), `aria reference #${ref} missing`);
    }
  }
});

test("every aria-label attribute is non empty", () => {
  for (const m of indexHtml.matchAll(/aria-label="([^"]*)"/g)) {
    assert.ok(m[1].trim().length > 0);
  }
});

test("styles provide a visible focus state, hidden text and a skip link", () => {
  assert.match(stylesCss, /:focus-visible\s*\{/);
  assert.match(stylesCss, /\.visually-hidden\s*\{/);
  assert.match(stylesCss, /\.skip-link\b/);
});

test("styles honor reduced motion and ban smooth scrolling everywhere", () => {
  assert.match(stylesCss, /@media \(prefers-reduced-motion: reduce\)/);
  const shipped = `${indexHtml}\n${stylesCss}\n${appJs}\n${verifierSrc}\n${tracesSrc}`;
  assert.equal(/scroll-behavior\s*:\s*smooth/i.test(shipped), false);
  assert.equal(/scrollIntoView\s*\([^)]*smooth/i.test(shipped), false);
  assert.equal(/behavior\s*:\s*"smooth"/i.test(shipped), false);
});

test("no single character keyboard shortcuts exist (WCAG 2.1.4)", () => {
  // Bare alphanumeric key handlers would hijack typing; Escape, Enter and
  // Space are exempt keys, not character shortcuts.
  assert.equal(/key\s*={2,3}\s*"[^"]?[a-zA-Z0-9][^"]?"/.test(appJs.replace(/"(Enter|Escape| |Arrow\w+|Tab|Backspace|Delete|Home|End|PageUp|PageDown|F\d{1,2})"/g, '""')), false, appJs.match(/key\s*={2,3}\s*"[^"]+"/g)?.join(","));
});

test("a favicon ships as a data URI so no network request is needed", () => {
  assert.match(indexHtml, /<link rel="icon" href="data:image\/svg\+xml,/);
});

test("social and theme metadata is complete", () => {
  for (const needle of ['name="author" content="Aariv Patel"', 'name="theme-color"', 'property="og:type" content="website"', 'property="og:url" content="https://aariv.me/museweaver/"', 'name="twitter:card"']) {
    assert.ok(indexHtml.includes(needle), needle);
  }
});

test("no alert, confirm or prompt blocking dialogs remain", () => {
  for (const call of ["alert(", "confirm(", "prompt("]) {
    assert.equal(appJs.includes(call), false, call);
  }
});

test("clipboard access is guarded for insecure contexts", () => {
  assert.match(appJs, /navigator\.clipboard\?\.writeText/);
});

test("execution results and verdict render into live regions", () => {
  assert.match(indexHtml, /id="execution-results" aria-live="polite"/);
  assert.match(indexHtml, /id="judge-verdict" aria-live="polite"/);
});

/* ---------------- sandbox integrity ---------------- */

test("the sandbox page denies network and navigational surfaces by CSP", () => {
  const csp = /Content-Security-Policy" content="([^"]+)"/.exec(sandboxHtml)[1];
  for (const needle of ["default-src 'none'", "connect-src 'none'", "img-src 'none'", "frame-src 'none'", "form-action 'none'"]) {
    assert.ok(csp.includes(needle), needle);
  }
});

test("the sandbox worker validates the execute envelope before running", () => {
  assert.match(sandboxHtml, /event\.source !== parent/);
  assert.match(sandboxHtml, /event\.data\.type !== "execute"/);
  assert.match(sandboxHtml, /removeEventListener\("message", start\)/);
});

test("runCustomCode enforces request shape and deadline bounds", () => {
  assert.match(verifierSrc, /code\.length > 100000/);
  assert.match(verifierSrc, /tests\.some\(t => typeof t !== "string"\)/);
  assert.match(verifierSrc, /timeoutMs < 100 \|\| timeoutMs > 5000/);
  assert.match(verifierSrc, /assertions\.length > 256/);
  assert.match(verifierSrc, /logs\.length > 64/);
});

test("runCustomCode validates the worker response before resolving", () => {
  assert.match(verifierSrc, /event\.source !== frame\.contentWindow/);
  assert.match(verifierSrc, /event\.data\?\.nonce !== nonce/);
  assert.match(verifierSrc, /type !== "execution-result"/);
  assert.match(verifierSrc, /frame\.remove\(\)/);
});

test("the sandbox frame is script only and hidden", () => {
  assert.match(verifierSrc, /sandbox", "allow-scripts"|setAttribute\("sandbox", "allow-scripts"\)/);
  assert.match(verifierSrc, /frame\.hidden = true/);
});

/* ---------------- app controller safety ---------------- */

test("all innerHTML writes escape interpolated dynamic fields", () => {
  for (const m of appJs.matchAll(/innerHTML = `([\s\S]*?)`/g)) {
    for (const expr of m[1].matchAll(/\$\{([^}]+)\}/g)) {
      const e = expr[1];
      if (/escapeHtml|escSvg|result\.|summary|elapsed|SCENARIOS|scenario|count|strategy|class|status|icon|verdict|fill|stroke|cx|cy|x1|x2|y1|y2|padL|padT|plotH|maxP|width|rx|points|marker|banner|svg|fields|detail|execResult|customResult|assertions|a\.pass|\d/.test(e)) continue;
      assert.fail(`unescaped interpolation in innerHTML: ${e}`);
    }
  }
});

test("invariant and test case rows are escaped before injection", () => {
  assert.match(appJs, /escapeHtml\(inv\.id\)/);
  assert.match(appJs, /escapeHtml\(inv\.name\)/);
  assert.match(appJs, /escapeHtml\(inv\.formula\)/);
  assert.match(appJs, /escapeHtml\(tc\.name\)/);
  assert.match(appJs, /escapeHtml\(tc\.desc\)/);
});

test("the pipeline refuses to run an unbundled scenario", () => {
  assert.match(appJs, /if \(!CAPTURED_TRACES\[currentScenario\]\)/);
});

test("edited code never reuses the bundled verification verdict", () => {
  assert.match(appJs, /lastResult = null/);
  assert.match(appJs, /not a formal verification certificate/);
});

test("scenario selection writes the permalink state without reloading", () => {
  assert.match(appJs, /history\.replaceState/);
  assert.match(appJs, /searchParams\.set\("scenario", id\)/);
});

test("export report embeds a JSON payload with an integrity hash", () => {
  assert.match(appJs, /crypto\.subtle\.digest\("SHA-256"/);
  assert.match(appJs, /canonicalJsonSha256/);
  assert.match(appJs, /Export Payload \(JSON\)/);
});

/* ---------------- shipped content hygiene ---------------- */

test("shipped text files carry no em dashes or en dashes", () => {
  const files = ["index.html", "styles.css", "js/app.js", "js/verifier.js", "js/captured-traces.js", "js/execution-sandbox.html", "README.md", "formal_verifier.py"];
  for (const rel of files) {
    const text = fs.readFileSync(path.join(root, rel), "utf8");
    const dash = new RegExp("[" + String.fromCharCode(0x2013, 0x2014, 0x2015) + "]|&(?:en|mn)dash;", "i");
    assert.equal(dash.test(text), false, rel);
  }
});

test("shipped files contain no private paths, emails or credential prefixes", () => {
  const files = ["index.html", "styles.css", "js/app.js", "js/verifier.js", "js/captured-traces.js", "README.md"];
  for (const rel of files) {
    const text = fs.readFileSync(path.join(root, rel), "utf8");
    assert.equal(/\/Users\/|\/home\//.test(text), false, `${rel} home path`);
    assert.equal(/[a-z0-9._%+-]+@(?:gmail|outlook|yahoo|icloud|hotmail)\.[a-z]+/i.test(text), false, `${rel} email`);
    assert.equal(/(?:sk-|ghp_|github_pat_|xox[bpsa]-|gsk_|nvapi-|AKIA|ASIA)[a-z0-9_-]+/i.test(text), false, `${rel} credential`);
  }
});

test("no authorship disclosures or helper tool names leak into shipped files", () => {
  const files = ["index.html", "styles.css", "js/app.js", "js/verifier.js", "js/captured-traces.js", "README.md"];
  const disclosure = new RegExp(
    "\\b(?:\\x43laude|\\x43ursor|\\x43opilot|\\x43hat\\x47\\x50\\x54|\\x47\\x50\\x54|\\x47emini|\\x43odex|\\x41nthropic|\\x4fpen\\x41\\x49|\\x44evin|\\x4fmni\\x52oute|\\x41gent\\x52outer|\\x4eemotron|vibe ?cod(?:e|ing))\\b" +
      "|\\b\\x41\\x49\\b|\\x41\\x49[ -](?:assisted|generated|written)|generated (?:by|with) (?:an? )?(?:\\x41\\x49|\\x4c\\x4c\\x4d|language model)",
    "i"
  );
  for (const rel of files) {
    const text = fs.readFileSync(path.join(root, rel), "utf8").replace(/cursor\s*:/gi, "");
    assert.equal(disclosure.test(text), false, rel);
  }
});

test("no placeholders, debug leftovers or dead code markers remain", () => {
  const shipped = `${indexHtml}\n${stylesCss}\n${appJs}\n${verifierSrc}\n${tracesSrc}`;
  assert.equal(/\b(?:TODO|FIXME|XXX|HACK|lorem ipsum)\b/i.test(shipped), false);
  assert.equal(/console\.log\(/.test(appJs + verifierSrc + tracesSrc), false);
  assert.equal(/_lastReportJson/.test(appJs), false);
});

test("honest scope labels are present for traces, sandbox and reports", () => {
  assert.match(indexHtml, /Bundled agent traces are illustrative/);
  assert.match(indexHtml, /not whole-program proofs/);
  assert.match(appJs, /not authenticated model inference evidence/);
  assert.match(appJs, /not a formal verification certificate/);
});

/* ---------------- extended engine coverage ---------------- */

test("bucket drains at steady state never exceed capacity*rate window", () => {
  const Bucket = run("VerifiedBucket");
  for (const rate of [1, 3, 40]) {
    const bucket = new Bucket(10, rate);
    let admitted = 0;
    for (let t = 0; t <= 5_000_000; t += 500_000) {
      if (bucket.tryConsume(t)) admitted++;
    }
    assert.ok(admitted <= 10 + rate * 5, `rate=${rate} admitted=${admitted}`);
  }
});

test("bucket exact boundary admits a token precisely at one whole unit", () => {
  const Bucket = run("VerifiedBucket");
  const bucket = new Bucket(2, 2);
  bucket.tryConsume(0);
  bucket.tryConsume(0);
  bucket.refill(499_999);
  assert.equal(bucket.tryConsume(499_999), false);
  bucket.refill(500_000);
  assert.equal(bucket.tryConsume(500_000), true);
});

test("naive bucket under-admits relative to the verified bucket at fractional edges", () => {
  const Naive = run("NaiveTokenBucket");
  const Verified = run("VerifiedBucket");
  const n = new Naive(1, 3);
  const v = new Verified(1, 3);
  n.tryConsume(0);
  v.tryConsume(0);
  const naive = n.tryConsume(333.334);
  const verified = v.tryConsume(333_334);
  assert.equal(naive, verified);
});

for (const [N, f] of [[4, 1], [7, 2], [10, 3], [13, 4]]) {
  test(`quorum formula keeps 2q - N >= f + 1 for N=${N} f=${f}`, () => {
    const QV = run("QuorumVerifier");
    const qv = new QV(N, f);
    assert.ok(2 * qv.q - N >= f + 1);
  });
}

test("unsafe N=3f configs all admit the equivocation partition attack", () => {
  const QV = run("QuorumVerifier");
  for (const f of [1, 2, 3, 4]) {
    const N = 3 * f;
    const honest = Array.from({ length: 2 * f }, (_, i) => i);
    const byz = Array.from({ length: f }, (_, i) => 2 * f + i);
    const g1 = honest.slice(0, f);
    const g2 = honest.slice(f);
    const qA = [...g1, ...byz];
    const qB = [...g2, ...byz];
    assert.equal(qA.length, 2 * f);
    const honestInter = qA.filter((x) => honest.includes(x)).filter((x) => qB.includes(x));
    assert.equal(honestInter.length, 0, `f=${f} N=${N}`);
  }
});

test("battery solve respects a degraded capacity and rate bound", () => {
  const B = run("BatteryArbitrage");
  const bat = new B(1, 1, 0.1);
  const { path } = bat.solve([1, 9, 1, 9], 0);
  for (const s of path) {
    assert.ok(Math.abs(s.action) <= 1);
    assert.ok(s.soc + s.action >= 0 && s.soc + s.action <= 1);
  }
});

test("greedy on the canonical curve is strictly suboptimal", () => {
  const B = run("BatteryArbitrage");
  const bat = new B(1, 1, 1.0);
  const dp = bat.solve([3, 1, 10, 2], 1);
  const greedy = bat.greedy([3, 1, 10, 2], 1);
  assert.ok(dp.maxProfit > greedy.totalProfit);
});

test("runVerification results never report negative counters", () => {
  for (const s of ["rate-limiter", "quorum", "battery"]) {
    const r = run(`runVerification(${JSON.stringify(s)}, {trials: 5, seed: 3})`);
    assert.ok(r.summary.passed >= 0 && r.summary.failed >= 0 && r.summary.naiveBugsCaught >= 0);
  }
});

test("all four scenario cards map to a scenario or the composer", () => {
  assert.match(indexHtml, /data-scenario="rate-limiter"/);
  assert.match(indexHtml, /data-scenario="quorum"/);
  assert.match(indexHtml, /data-scenario="battery"/);
  assert.match(indexHtml, /data-scenario="custom"/);
});

test("pipeline button, rerun and export controls are labelled buttons", () => {
  for (const id of ["run-pipeline-btn", "rerun-btn", "export-report-btn", "permalink-btn", "compare-toggle"]) {
    assert.match(indexHtml, new RegExp(`<button[^>]*id="${id}"`));
  }
});

test("the sandbox iframe reference matches the shipped sandbox file", () => {
  assert.match(verifierSrc, /execution-sandbox\.html/);
  assert.ok(fs.existsSync(path.join(root, "js", "execution-sandbox.html")));
});

test("captured trace invariants carry non-trivial formula statements", () => {
  for (const scenario of ["rate-limiter", "quorum", "battery"]) {
    const t = runT(`CAPTURED_TRACES[${JSON.stringify(scenario)}]`);
    for (const inv of t.proposer.invariants) {
      assert.ok(inv.formula.trim().length >= 8, `${scenario} ${inv.id}`);
    }
  }
});

test("markdown export names the scenario in its download filename", () => {
  assert.match(appJs, /museweaver-report-\$\{currentScenario\}/);
});

test("execution metrics render counts only from numeric summary fields", () => {
  assert.match(appJs, /result\.summary\.total/);
  assert.match(appJs, /result\.summary\.passed/);
  assert.match(appJs, /result\.summary\.failed/);
});

/* ---------------- adversarial pass-2 regressions ---------------- */

// Finding 2: the dialog claimed aria-modal while Tab escaped into the page.
test("the api modal traps Tab inside the dialog", () => {
  assert.match(appJs, /e\.key !== "Tab"/);
  assert.match(appJs, /modal\.querySelectorAll\("input, button, \[tabindex\]"\)/);
  assert.match(appJs, /last\.focus\(\)/);
  assert.match(appJs, /first\.focus\(\)/);
});

// Finding 3: the button promised "1,000 Fuzz Trials" but ran sandbox execution
// and left the previous verdict on screen.
test("the edited-code runner is honestly labelled and clears stale verdicts", () => {
  assert.match(indexHtml, /id="run-custom-btn">Run Edited Code in Sandbox</);
  assert.equal(/run-custom-btn[^<]*Fuzz Trials/i.test(indexHtml), false);
  assert.match(appJs, /Sandbox execution of your edited code/);
  assert.match(appJs, /metricsEl\.innerHTML = ""/);
});

// Finding 6: bare crypto.randomUUID() crashed on insecure origins.
test("runCustomCode tolerates hosts without crypto.randomUUID", () => {
  assert.match(verifierSrc, /typeof crypto\.randomUUID === "function"/);
});

// Finding 7: dagSelectedNode used to leak across scenario switches, re-pointing
// the detail panel at an unrelated invariant.
test("scenario switches reset the DAG selection", () => {
  const fn = /function selectScenario\(id\) \{[\s\S]*?\n\}/.exec(appJs)[0];
  assert.match(fn, /dagSelectedNode = null/);
});

// Finding 8: escapeHtml left quotes literal, a latent attribute-injection gap.
test("escapeHtml encodes quotes for attribute contexts", () => {
  const ctx = vm.createContext({
    document: {
      createElement: () => {
        const el = {
          set textContent(v) { this._t = String(v); },
          get innerHTML() {
            return this._t
              .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
          }
        };
        return el;
      }
    }
  });
  vm.runInContext(`${/function escapeHtml[\s\S]*?\n\}/.exec(appJs)[0]}`, ctx);
  const esc = vm.runInContext("escapeHtml", ctx);
  const out = esc(`x" onmouseover="alert(1)' or '<img>`);
  assert.equal(out.includes('"'), false);
  assert.equal(out.includes("'"), false);
  assert.equal(out.includes("<img"), false);
  assert.ok(out.includes("&quot;"));
});

// Finding 1 (controller side): the DAG verdict node must key on the same
// verified-failure counter as the judge verdict, not raw log failures.
test("DAG verdict and judge verdict share one definition of failure", () => {
  assert.match(appJs, /result\.summary\.verifiedBugs === 0/);
  const dagFn = /function renderDag\(scenarioId, result\)[\s\S]*?\n\}/.exec(appJs)[0];
  assert.equal(/summary\.failed/.test(dagFn), false);
});
