"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const L = require("../js/ablation-lab.js");
const labSrc = fs.readFileSync(path.join(root, "js/ablation-lab.js"), "utf8");
const labUiSrc = fs.readFileSync(path.join(root, "js/lab-ui.js"), "utf8");
const indexHtml = fs.readFileSync(path.join(root, "index.html"), "utf8");

const UNIT = 1000000;

/* ---------------- SHA-256: KAT vectors + differential vs Node crypto ---------------- */

const KATS = [
  ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
  ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
  ["abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
    "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"],
  ["abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu",
    "cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1"],
  ["a".repeat(1000000), "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0"]
];
for (const [input, expected] of KATS) {
  test(`sha256 KAT len=${input.length}`, () => {
    assert.equal(L.sha256Hex(input), expected);
  });
}

for (const len of [55, 56, 57, 63, 64, 65, 127, 128, 129]) {
  test(`sha256 block-boundary input len=${len} matches Node crypto`, () => {
    const input = "x".repeat(len);
    assert.equal(L.sha256Hex(input), crypto.createHash("sha256").update(input, "utf8").digest("hex"));
  });
}

{
  const rng = L.seededRandom(7);
  for (let i = 0; i < 20; i++) {
    const len = 1 + Math.floor(rng() * 300);
    let s = "";
    for (let j = 0; j < len; j++) s += String.fromCharCode(Math.floor(rng() * 0xD7FF));
    test(`sha256 seeded random string ${i} matches Node crypto`, () => {
      assert.equal(L.sha256Hex(s), crypto.createHash("sha256").update(s, "utf8").digest("hex"));
    });
  }
}

test("sha256 handles multibyte and astral input matching Node crypto", () => {
  for (const s of ["café", "中文测试", "emoji 🚀🔒", "\u0000null\u0000bytes"]) {
    assert.equal(L.sha256Hex(s), crypto.createHash("sha256").update(s, "utf8").digest("hex"));
  }
});

/* ---------------- canonical JSON ---------------- */

test("canonicalize sorts keys recursively", () => {
  assert.equal(L.canonicalize({ b: 1, a: { d: 2, c: 3 } }), '{"a":{"c":3,"d":2},"b":1}');
});

test("canonicalize is order independent for objects, order sensitive for arrays", () => {
  const a = L.canonicalize({ x: [1, 2], y: { p: 1, q: 2 } });
  const b = L.canonicalize({ y: { q: 2, p: 1 }, x: [1, 2] });
  assert.equal(a, b);
  assert.notEqual(L.canonicalize([1, 2]), L.canonicalize([2, 1]));
});

test("canonicalize normalizes -0 and non-finite numbers", () => {
  assert.equal(L.canonicalize(-0), "0");
  assert.equal(L.canonicalize(NaN), "null");
  assert.equal(L.canonicalize(Infinity), "null");
  assert.equal(L.canonicalize(-Infinity), "null");
});

test("canonicalize serializes bigint deterministically and skips undefined/function", () => {
  assert.equal(L.canonicalize({ v: 42n }), '{"v":"42"}');
  assert.equal(L.canonicalize({ a: 1, b: undefined, c: () => 1 }), '{"a":1}');
});

test("canonicalize escapes strings exactly like JSON.stringify", () => {
  const s = 'quote " backslash \\ newline \n tab \t unicode \u00e9';
  assert.equal(L.canonicalize(s), JSON.stringify(s));
});

/* ---------------- utf8 + base64url ---------------- */

{
  const rng = L.seededRandom(11);
  for (let i = 0; i < 10; i++) {
    const len = Math.floor(rng() * 120);
    let s = "";
    for (let j = 0; j < len; j++) {
      const pick = rng();
      s += pick < 0.6 ? String.fromCharCode(32 + Math.floor(rng() * 95))
        : pick < 0.9 ? String.fromCharCode(Math.floor(rng() * 0x800))
        : "🚀";
    }
    test(`utf8 + base64url round-trip ${i} (len ${s.length})`, () => {
      const bytes = L.utf8Bytes(s);
      const enc = L.b64urlEncode(bytes);
      assert.ok(!/[+/=]/.test(enc), "output must be url-safe");
      const back = L.b64urlDecode(enc);
      assert.deepEqual(back, bytes);
      assert.equal(L.utf8String(back), s);
    });
  }
}

test("utf8 handles lone surrogates via replacement char", () => {
  const bytes = L.utf8Bytes("\ud800 lone");
  assert.deepEqual(L.utf8Bytes("\ufffd lone"), bytes);
});

for (const bad of ["+", "/", "=", "*", " ", "A B"]) {
  test(`b64urlDecode rejects invalid input ${JSON.stringify(bad)}`, () => {
    assert.equal(L.b64urlDecode(bad), null);
  });
}

/* ---------------- token oracle ---------------- */

const TOKEN_CASES = [
  // [cap, rate, bal, elapsed, expectedAdmit, expectedBal]
  [1, 1, 0, UNIT, true, 0],
  [1, 1, 0, UNIT - 1, false, UNIT - 1],
  [5, 1, 5 * UNIT, 10 * UNIT, true, 4 * UNIT],
  [5, 1, 0, 0, false, 0],
  [3, 7, 0, 142857, false, 999999],
  [3, 7, 0, 142858, true, 6],
  [2, 1, UNIT, 0, true, 0],
  [2, 1, UNIT - 1, 1, true, 0],
  [4, 1, 0, 9007199254740991, true, 3 * UNIT],
  [10, 3, 3 * UNIT, 0, true, 2 * UNIT]
];
for (const [cap, rate, bal, elapsed, admit, next] of TOKEN_CASES) {
  test(`tokenOracle cap=${cap} rate=${rate} bal=${bal} elapsed=${elapsed}`, () => {
    const r = L.tokenOracle(cap * UNIT, rate, bal, elapsed);
    assert.equal(r.admit, admit);
    assert.equal(r.bal, BigInt(next));
  });
}

test("tokenOracle never overflows on MAX_SAFE delta", () => {
  for (const cap of [1, 5, 10]) {
    const r = L.tokenOracle(cap * UNIT, 13, 0, Number.MAX_SAFE_INTEGER);
    assert.equal(r.bal, BigInt((cap - 1) * UNIT));
  }
});

/* ---------------- ablation matrix expectations ---------------- */

const EXPECTED = {
  none: { "tb-float": false, "tb-unclamped": false, "tb-strict": false, "tb-overflow": false,
    "q-safety-only": false, "q-liveness-only": false, "q-bft3f": false, "q-offbyone": false,
    "b-greedy": false, "b-nodeg": false, "b-horizon": false, "b-socclip": false },
  unit: { "tb-float": false, "tb-unclamped": true, "tb-strict": true, "tb-overflow": false,
    "q-safety-only": false, "q-liveness-only": true, "q-bft3f": true, "q-offbyone": true,
    "b-greedy": true, "b-nodeg": true, "b-horizon": true, "b-socclip": true },
  fuzz: { "tb-float": false, "tb-unclamped": true, "tb-strict": true, "tb-overflow": false,
    "q-safety-only": true, "q-liveness-only": true, "q-bft3f": true, "q-offbyone": true,
    "b-greedy": true, "b-nodeg": true, "b-horizon": true, "b-socclip": true },
  combined: { "tb-float": true, "tb-unclamped": true, "tb-strict": true, "tb-overflow": true,
    "q-safety-only": true, "q-liveness-only": true, "q-bft3f": true, "q-offbyone": true,
    "b-greedy": true, "b-nodeg": true, "b-horizon": true, "b-socclip": true }
};

for (const policy of Object.keys(EXPECTED)) {
  for (const mutant of Object.keys(EXPECTED[policy])) {
    test(`matrix ${policy} x ${mutant} => ${EXPECTED[policy][mutant] ? "caught" : "escaped"}`, () => {
      const cell = L.evaluateMutant(mutant, policy, 42);
      assert.equal(cell.caught, EXPECTED[policy][mutant]);
      assert.equal(cell.mutant, mutant);
      assert.equal(cell.policy, policy);
      if (cell.caught) {
        assert.ok(cell.witness, "caught cells must carry a witness");
        assert.ok(cell.check, "caught cells name the catching suite");
      } else {
        assert.equal(cell.witness, null);
      }
    });
  }
}

test("matrix summary counts match per-cell results", () => {
  const m = L.runAblationMatrix(42);
  assert.equal(m.cells.length, 48);
  assert.equal(m.summary.none.caught, 0);
  assert.equal(m.summary.unit.caught, 9);
  assert.equal(m.summary.fuzz.caught, 10);
  assert.equal(m.summary.combined.caught, 12);
  const recount = {};
  for (const c of m.cells) {
    recount[c.policy] = (recount[c.policy] || 0) + (c.caught ? 1 : 0);
  }
  for (const p of Object.keys(recount)) assert.equal(m.summary[p].caught, recount[p]);
});

test("ablation matrix is deterministic across seeds it controls and calls", () => {
  const a = L.runAblationMatrix(42);
  const b = L.runAblationMatrix(42);
  assert.equal(L.canonicalize(a.cells), L.canonicalize(b.cells));
});

test("mutant catalog has exactly 12 entries, 4 per domain", () => {
  assert.equal(L.MUTANTS.length, 12);
  for (const d of ["token", "quorum", "battery"]) {
    assert.equal(L.MUTANTS.filter((m) => m.domain === d).length, 4, d);
  }
  const ids = new Set(L.MUTANTS.map((m) => m.id));
  assert.equal(ids.size, 12);
});

for (const bad of ["nope", "", "TB-FLOAT", null, undefined, 5, "__proto__"]) {
  test(`evaluateMutant rejects unknown mutant ${JSON.stringify(bad)}`, () => {
    assert.throws(() => L.evaluateMutant(bad, "combined"), /unknown mutant/);
  });
}
for (const bad of ["nope", "", "UNIT", null, undefined, 5]) {
  test(`evaluateMutant rejects unknown policy ${JSON.stringify(bad)}`, () => {
    assert.throws(() => L.evaluateMutant("tb-float", bad), /unknown policy/);
  });
}

/* ---------------- witnesses are concrete and re-trigger ---------------- */

test("every caught witness describes a real divergence", () => {
  for (const m of L.MUTANTS) {
    const cell = L.evaluateMutant(m.id, "combined", 42);
    assert.ok(cell.caught, m.id);
    const w = cell.witness;
    assert.ok(w && typeof w === "object", m.id);
    if (m.domain === "quorum") {
      assert.equal(w.oracleVerdict !== w.mutantVerdict, true, m.id);
    } else if (m.domain === "battery") {
      assert.ok(["suboptimal", "infeasible-path", "dishonest-profit", "threw", "no-result"].includes(w.kind), m.id + " " + w.kind);
    } else {
      assert.ok(["admission-divergence", "capacity-exceeded", "balance-drift", "state-divergence", "admission-count"].includes(w.kind), m.id + " " + w.kind);
    }
  }
});

test("split-brain witnesses reconstruct two real quorums with no honest overlap", () => {
  const cell = L.evaluateMutant("q-liveness-only", "unit", 42);
  const sb = cell.witness.splitBrain;
  assert.ok(sb);
  const N = cell.witness.N, f = cell.witness.f, q = cell.witness.q;
  assert.equal(sb.q1.length, q);
  assert.equal(sb.q2.length, q);
  const honest = new Set();
  for (let i = 0; i < N - f; i++) honest.add(i);
  const q2 = new Set(sb.q2);
  for (const x of sb.q1) {
    if (honest.has(x)) assert.equal(q2.has(x), false, `honest ${x} in both quorums`);
  }
});

/* ---------------- quorum oracle + phase plane ---------------- */

for (let N = 1; N <= 16; N++) {
  for (let f = 0; f < N; f++) {
    test(`phaseCell grid N=${N} f=${f} matches formulas for all q`, () => {
      for (let q = 1; q <= N; q++) {
        const c = L.phaseCell(N, f, q);
        assert.equal(c.valid, true);
        assert.equal(c.safety, 2 * q - N > f, `N=${N} f=${f} q=${q}`);
        assert.equal(c.liveness, q <= N - f);
        assert.equal(c.bftFeasible, N >= 3 * f + 1);
        const expected = c.safety && c.liveness ? "safe"
          : !c.safety && c.liveness ? "split-brain"
          : c.safety && !c.liveness ? "deadlock" : "doomed";
        assert.equal(c.classification, expected);
        assert.equal(c.intersectionBound, 2 * q - N);
        assert.equal(c.honestAvailable, N - f);
        if (!c.safety) {
          const sb = c.splitBrain;
          assert.ok(sb, `missing split-brain at N=${N} f=${f} q=${q}`);
          assert.equal(sb.q1.length, q);
          assert.equal(sb.q2.length, q);
          assert.equal(sb.honestIntersection.length, 0);
          assert.ok(sb.sharedAllByzantine);
          assert.equal(sb.shared.length, Math.max(0, 2 * q - N));
        } else {
          assert.equal(c.splitBrain, undefined);
        }
      }
    });
  }
}

for (const [N, f, q] of [[0, 0, 0], [-1, 0, 0], [4, -1, 3], [4, 4, 3], [4, 0, 0], [4, 0, 5], [1.5, 0, 1], [4, 1.5, 3], [4, 1, 2.5], [NaN, 0, 1], [Infinity, 0, 1], ["4", 1, 3], [4, "1", 3], [4, 1, "3"], [null, 0, 1], [4, null, 3], [4, 1, null]]) {
  test(`phaseCell rejects invalid params N=${N} f=${f} q=${q}`, () => {
    const c = L.phaseCell(N, f, q);
    assert.equal(c.valid, false);
    assert.equal(c.classification, "invalid");
    assert.equal(L.quorumOracle(N, f, q), false);
    assert.equal(L.buildSplitBrain(N, f, q), null);
  });
}

for (const N of [1, 2, 3, 5, 8, 13, 33, 64]) {
  test(`phasePlane N=${N} shape is q rows x f columns`, () => {
    const p = L.phasePlane(N);
    assert.equal(p.N, N);
    assert.equal(p.rows.length, N);
    for (const row of p.rows) assert.equal(row.length, p.fMax + 1);
  });
}
for (const bad of [0, -1, 65, 1.5, NaN, "8", Infinity]) {
  test(`phasePlane rejects N=${bad}`, () => {
    assert.throws(() => L.phasePlane(bad), RangeError);
  });
}

test("split-brain construction is impossible when safety holds", () => {
  for (let N = 1; N <= 14; N++) {
    for (let f = 0; f < N; f++) {
      for (let q = 1; q <= N; q++) {
        const sb = L.buildSplitBrain(N, f, q);
        if (2 * q - N > f) assert.equal(sb, null, `safe config N=${N} f=${f} q=${q}`);
        else assert.ok(sb && sb.honestIntersection.length === 0);
      }
    }
  }
});

/* ---------------- battery DP / brute force / realize ---------------- */

const CURVES = [
  [[3, 1, 10, 2], 1, 1, 1.0, 1],
  [[1, 5, 1, 8], 2, 1, 0.5, 0],
  [[5, 5, 5], 1, 1, 0.2, 0],
  [[9, 1, 9, 1, 9], 2, 1, 0.4, 1],
  [[1], 1, 1, 0.5, 0],
  [[7], 1, 1, 0.5, 1],
  [[1, 9, 1, 9], 1, 1, 0.1, 0],
  [[2, 7, 2, 7], 3, 2, 0.3, 1],
  [[4, 2, 7, 1, 6, 3], 3, 2, 0.5, 0],
  [[0.5, 0.5, 0.5], 2, 1, 0.9, 0]
];
for (const [prices, C, R, d, init] of CURVES) {
  test(`battery DP equals brute force on ${JSON.stringify(prices)} C=${C} init=${init}`, () => {
    const dp = L.batteryOptimal(prices, C, R, d, init);
    const bf = L.batteryBruteForce(prices, C, R, d, init);
    assert.ok(Math.abs(dp.maxProfit - bf.maxProfit) < 1e-9, `dp=${dp.maxProfit} bf=${bf.maxProfit}`);
    const real = L.batteryRealize(prices, C, R, d, init, dp.path);
    assert.equal(real.feasible, true);
    assert.ok(Math.abs(real.realized - dp.maxProfit) < 1e-9);
  });
}

test("batteryRealize rejects hostile and malformed paths", () => {
  const prices = [1, 5, 1];
  for (const pathCase of [
    null, undefined, "x", [],
    [{ t: 0, soc: 0, action: 0 }],
    [{ t: 0, soc: 1, action: 0 }, { t: 1, soc: 0, action: 0 }, { t: 2, soc: 0, action: 0 }],
    [{ t: 0, soc: 0, action: 1.5 }, { t: 1, soc: 1.5, action: 0 }, { t: 2, soc: 1.5, action: 0 }],
    [{ t: 0, soc: 0, action: 2 }, { t: 1, soc: 2, action: 0 }, { t: 2, soc: 2, action: 0 }],
    [{ t: 0, soc: 0, action: -1 }, { t: 1, soc: -1, action: 0 }, { t: 2, soc: -1, action: 0 }]
  ]) {
    assert.equal(L.batteryRealize(prices, 2, 1, 0.5, 0, pathCase).feasible, false, JSON.stringify(pathCase));
  }
});

test("battery empty curve yields zero profit and empty path", () => {
  const dp = L.batteryOptimal([], 2, 1, 0.5, 0);
  assert.equal(dp.maxProfit, 0);
  assert.equal(dp.path.length, 0);
});

/* ---------------- certificate: parity, cache, tamper ---------------- */

const labState = { v: 1, tab: "all", n: 6, f: -1, q: -1, m: "" };

test("certificate caches one digest-stamped object per state key", () => {
  const p1 = L.buildLabPayload(labState);
  const p2 = L.buildLabPayload(labState);
  const c1 = L.certificate(p1);
  const c2 = L.certificate(p2);
  assert.ok(c1 === c2, "identical state must reuse the cached entry");
  assert.equal(c1.digest.length, 64);
  const c3 = L.certificate(L.buildLabPayload({ v: 1, tab: "token", n: 6, f: -1, q: -1, m: "" }));
  assert.notEqual(c3.digest, c1.digest, "different state must get a different digest");
});

test("digest parity: page value, JSON, CSV header and Markdown footer all match", () => {
  const p = L.buildLabPayload(labState);
  const cert = L.certificate(p);
  const json = L.exportCertificateJson(p);
  const csv = L.exportCertificateCsv(p);
  const md = L.exportCertificateMarkdown(p);
  assert.ok(json.includes(`"digest": "${cert.digest}"`));
  assert.ok(csv.includes(`# sha256-canonical-json: ${cert.digest}`));
  assert.ok(md.includes(`Digest: \`${cert.digest}\``));
  const recomputed = crypto.createHash("sha256").update(L.canonicalize(p), "utf8").digest("hex");
  assert.equal(recomputed, cert.digest, "external SHA-256 must match the pure-JS digest");
});

test("verifyCertificateJson accepts its own export and rejects tampering", () => {
  const p = L.buildLabPayload(labState);
  const json = L.exportCertificateJson(p);
  const intact = L.verifyCertificateJson(json);
  assert.equal(intact.ok, true);
  const doc = JSON.parse(json);
  doc.payload.cells[0].caught = !doc.payload.cells[0].caught;
  const forged = L.verifyCertificateJson(JSON.stringify(doc));
  assert.equal(forged.ok, false);
  assert.notEqual(forged.expected, forged.actual);
  // Tamper the digest itself instead.
  const doc2 = JSON.parse(json);
  doc2.integrity.digest = "0".repeat(64);
  assert.equal(L.verifyCertificateJson(JSON.stringify(doc2)).ok, false);
});

for (const bad of ["", "not json", "null", "{}", "[]", '{"payload":{}}', '{"integrity":{}}', '{"payload":{},"integrity":{"digest":"x"}}']) {
  test(`verifyCertificateJson fails closed on ${JSON.stringify(bad.slice(0, 40))}`, () => {
    assert.equal(L.verifyCertificateJson(bad).ok, false);
  });
}

test("CSV export header carries provenance and escapes witness cells", () => {
  const p = L.buildLabPayload(labState);
  const csv = L.exportCertificateCsv(p);
  const lines = csv.split("\n");
  assert.equal(lines[0], "# museweaver-ablation-certificate");
  assert.match(lines[1], /^# sha256-canonical-json: [0-9a-f]{64}$/);
  assert.equal(lines[3], "mutant,domain,policy,caught,check,witness");
  const rows = lines.slice(4).filter(Boolean);
  assert.equal(rows.length, 48);
  for (const row of rows) {
    const cols = row.split(",");
    assert.equal(cols.length >= 6, true, row);
  }
});

test("Markdown export carries the full matrix and the digest", () => {
  const p = L.buildLabPayload(labState);
  const md = L.exportCertificateMarkdown(p);
  assert.match(md, /12-mutant catalog/);
  for (const m of L.MUTANTS) assert.ok(md.includes(m.name), m.id);
  assert.match(md, /caught \(formal\)/);
  assert.match(md, /escaped/);
});

/* ---------------- CSV formula safety ---------------- */

const CSV_CASES = [
  ["=CMD()", "'=CMD()"],
  ["+SUM(A1)", "'+SUM(A1)"],
  ["-10+1", "'-10+1"],
  ["@mention", "'@mention"],
  ["\tlead", "'\tlead"],
  ["plain", "plain"],
  ["a,b", '"a,b"'],
  ['say "hi"', '"say ""hi"""'],
  ["line\nbreak", '"line\nbreak"'],
  ["carriage\rreturn", '"carriage\rreturn"'],
  [" lead space", '" lead space"'],
  ["trail ", '"trail "'],
  [123, "123"],
  [null, ""],
  [undefined, ""],
  [true, "true"],
  ["'=already", "'=already"]
];
for (const [input, expected] of CSV_CASES) {
  test(`csvCell ${JSON.stringify(input)} => ${JSON.stringify(expected)}`, () => {
    assert.equal(L.csvCell(input), expected);
  });
}

/* ---------------- #mw= codec ---------------- */

test("codec round-trips every lab control", () => {
  const states = [
    { v: 1, tab: "all", n: 3, f: -1, q: -1, m: "" },
    { v: 1, tab: "token", n: 20, f: 10, q: 20, m: "tb-float" },
    { v: 1, tab: "quorum", n: 12, f: 0, q: 1, m: "q-bft3f" },
    { v: 1, tab: "battery", n: 7, f: 3, q: 6, m: "b-socclip" }
  ];
  for (const s of states) {
    const h = L.encodeMwHash(s);
    assert.ok(h.startsWith("#mw="), h);
    assert.match(h, /^#mw=[A-Za-z0-9_-]+$/);
    const back = L.decodeMwHash(h);
    assert.deepEqual(back, L.normalizeLabState(s));
  }
});

test("encoded hash is compact and url-safe", () => {
  const h = L.encodeMwHash({ v: 1, tab: "quorum", n: 20, f: 10, q: 20, m: "q-bft3f" });
  assert.ok(h.length < 120, h);
  assert.match(h, /^#mw=[A-Za-z0-9_-]+$/);
});

test("normalizeLabState fills defaults for missing keys", () => {
  assert.deepEqual(L.normalizeLabState({}), { v: 1, tab: "all", n: 6, f: -1, q: -1, m: "" });
  assert.deepEqual(L.normalizeLabState({ n: 9 }), { v: 1, tab: "all", n: 9, f: -1, q: -1, m: "" });
});

const HASH_HOSTILE = [
  "", "#", "#mw=", "#mw=!!!", "#mw=<script>alert(1)</script>", "#mw=AAAA*",
  "javascript:alert(1)", "https://evil.example/#mw=AAAA",
  "#mw=" + "A".repeat(5000), "#mw=AAAA#frag", "#mw=AAA A",
  0, null, undefined, {}, [], 42, NaN,
  "#mw=" + L.b64urlEncode(L.utf8Bytes('{"v":2,"n":6}')),
  "#mw=" + L.b64urlEncode(L.utf8Bytes('{"v":1,"n":2}')),
  "#mw=" + L.b64urlEncode(L.utf8Bytes('{"v":1,"n":21}')),
  "#mw=" + L.b64urlEncode(L.utf8Bytes('{"v":1,"n":6.5}')),
  "#mw=" + L.b64urlEncode(L.utf8Bytes('{"v":1,"tab":"evil"}')),
  "#mw=" + L.b64urlEncode(L.utf8Bytes('{"v":1,"f":-2}')),
  "#mw=" + L.b64urlEncode(L.utf8Bytes('{"v":1,"n":6,"f":6}')),
  "#mw=" + L.b64urlEncode(L.utf8Bytes('{"v":1,"q":0}')),
  "#mw=" + L.b64urlEncode(L.utf8Bytes('{"v":1,"n":6,"q":7}')),
  "#mw=" + L.b64urlEncode(L.utf8Bytes('{"v":1,"m":"__proto__"}')),
  "#mw=" + L.b64urlEncode(L.utf8Bytes('{"__proto__":{"polluted":1},"v":1}')),
  "#mw=" + L.b64urlEncode(L.utf8Bytes('{"constructor":{"polluted":1},"v":1}')),
  "#mw=" + L.b64urlEncode(L.utf8Bytes('{"prototype":{"polluted":1},"v":1}')),
  "#mw=" + L.b64urlEncode(L.utf8Bytes("[1,2,3]")),
  "#mw=" + L.b64urlEncode(L.utf8Bytes("null")),
  "#mw=" + L.b64urlEncode(L.utf8Bytes('"just a string"')),
  "#mw=" + L.b64urlEncode(L.utf8Bytes("{bad json")),
  "#mw=" + L.b64urlEncode(L.utf8Bytes('{"v":1,"n":"8"}')),
  "#mw=" + L.b64urlEncode(L.utf8Bytes('{"v":1,"f":1.5}')),
  "#mw=" + L.b64urlEncode(L.utf8Bytes('{"v":1,"m":"tb-FLOAT"}'))
];
for (const bad of HASH_HOSTILE) {
  test(`decodeMwHash fails closed on ${JSON.stringify(String(bad)).slice(0, 60)}`, () => {
    assert.equal(L.decodeMwHash(bad), null);
  });
}

test("decoded state never carries prototype pollution", () => {
  const clean = L.decodeMwHash("#mw=" + L.b64urlEncode(L.utf8Bytes('{"v":1,"n":7,"extra":42,"weird":"ok"}')));
  assert.ok(clean, "unknown benign keys are tolerated");
  assert.equal(clean.n, 7);
  assert.equal(clean.extra, undefined);
  assert.equal(({}).polluted, undefined);
});

test("encodeMwHash rejects un-normalizable input", () => {
  for (const bad of [null, undefined, "x", 5, [], { v: 2 }, { n: 99 }, { tab: "nope" }]) {
    assert.equal(L.encodeMwHash(bad), null, JSON.stringify(bad));
  }
});

for (const [raw, key, expected] of [
  [{ f: -1 }, "f", -1], [{ q: -1 }, "q", -1], [{ f: null }, "f", -1], [{ q: null }, "q", -1],
  [{ f: 0 }, "f", 0], [{ n: 6, q: 1 }, "q", 1], [{ n: 20, q: 20 }, "q", 20], [{ n: 20, f: 19 }, "f", 19]
]) {
  test(`normalizeLabState ${JSON.stringify(raw)} keeps ${key}=${expected}`, () => {
    const s = L.normalizeLabState(raw);
    assert.equal(s[key], expected);
  });
}

/* ---------------- self-test suite ---------------- */

test("in-page self-test suite has 14+ checks and all pass", () => {
  const results = L.runSelfTests();
  assert.ok(results.length >= 14, `${results.length} checks`);
  for (const r of results) {
    assert.equal(r.pass, true, `${r.name}: ${r.detail}`);
  }
});

test("self-test names are unique and rerun is deterministic", () => {
  const a = L.runSelfTests();
  const b = L.runSelfTests();
  assert.deepEqual(a.map((r) => r.name), b.map((r) => r.name));
  assert.deepEqual(a.map((r) => r.pass), b.map((r) => r.pass));
  assert.equal(new Set(a.map((r) => r.name)).size, a.length);
});

/* ---------------- hostile inputs across the lab surface ---------------- */

test("evaluateMutant survives weird seeds deterministically", () => {
  for (const seed of [0, 1, 4294967295]) {
    const a = L.evaluateMutant("tb-unclamped", "fuzz", seed);
    const b = L.evaluateMutant("tb-unclamped", "fuzz", seed);
    assert.equal(a.caught, b.caught);
    assert.equal(a.caught, true);
  }
});

test("splitBrain handles f=0 boundary and huge N safely", () => {
  const c = L.phaseCell(64, 0, 32);
  // 2*32-64 = 0; safety needs > 0, so the boundary cell is a split-brain case.
  assert.equal(c.safety, false);
  assert.equal(c.liveness, true);
  assert.equal(c.classification, "split-brain");
  const sb = L.buildSplitBrain(6, 2, 3);
  assert.ok(sb);
  assert.equal(sb.honestIntersection.length, 0);
  assert.equal(sb.q1.length + sb.q2.length - sb.shared.length <= 6, true);
});

test("canonicalize rejects circular structures cleanly", () => {
  const o = { a: 1 };
  o.self = o;
  assert.throws(() => L.canonicalize(o));
});

test("sha256 of a large binary-ish string still matches Node crypto", () => {
  let s = "";
  for (let i = 0; i < 5000; i++) s += String.fromCharCode(i % 256);
  assert.equal(L.sha256Hex(s), crypto.createHash("sha256").update(s, "utf8").digest("hex"));
});

test("runAblationMatrix output cells are JSON serializable", () => {
  const m = L.runAblationMatrix(42);
  const text = JSON.stringify(m.cells);
  assert.ok(text.length > 100);
  const back = JSON.parse(text);
  assert.equal(back.length, 48);
});

/* ---------------- markup + wiring checks ---------------- */

test("workbench section exists, starts hidden and is reachable via one h2", () => {
  assert.match(indexHtml, /<section id="ablation-lab"[^>]*hidden>/);
  assert.match(indexHtml, /<h2 id="lab-title"/);
});

test("lab scripts load in the right order", () => {
  const order = ["js/ablation-lab.js", "js/lab-ui.js"];
  let pos = -1;
  for (const src of order) {
    const at = indexHtml.indexOf(`<script src="${src}"></script>`);
    assert.ok(at > pos, src);
    pos = at;
  }
});

test("every DOM id used by lab-ui.js exists in the markup", () => {
  const ids = new Set([...indexHtml.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  for (const m of labUiSrc.matchAll(/getElementById\("([^"]+)"\)/g)) {
    assert.ok(ids.has(m[1]), `#${m[1]} missing from index.html`);
  }
});

test("every element id referenced by lab-ui.js el() helper exists", () => {
  const ids = new Set([...indexHtml.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  for (const m of labUiSrc.matchAll(/el\("([^"]+)"\)/g)) {
    assert.ok(ids.has(m[1]), `#${m[1]} missing from index.html`);
  }
});

test("lab-ui.js injects no inline handlers through markup strings", () => {
  assert.equal(/<[^>]*\son[a-z]+\s*=/i.test(labUiSrc), false);
});

test("ablation-lab.js is browser-optional and CommonJS-safe", () => {
  assert.match(labSrc, /module\.exports/);
  assert.match(labSrc, /global\.MuseAblationLab|window\.MuseAblationLab/);
});


test('batch4 csv guard covers invisible unicode prefixes and numeric negatives', () => {
  for (const input of ['\u200b=cmd', '\ufeff=cmd', '\u00a0=cmd', '\u2060@cmd', ' \u200b\t=cmd']) {
    const out = L.csvCell(input);
    assert.ok(out.startsWith("'") || out.startsWith("\"'"), input + ' -> ' + out);
  }
  assert.ok(!String(L.csvCell(-12.5)).includes("'"));
});
