// ============================================================
// MuseWeaver - Verification & Mutant Ablation Lab
// Pure deterministic logic: a 12-mutant adversarial catalog,
// a quorum safety-liveness phase-plane solver, a cached
// SHA-256 certificate exporter, a #mw= bookmark codec and an
// in-page self-test suite. No DOM, no network, no timers.
// Exposed as window.MuseAblationLab and module.exports.
// ============================================================
(function (global) {
  "use strict";

  var UNIT = 1000000;
  var UNIT_BI = 1000000n;

  // ---------- UTF-8 (dependency free for sandboxed contexts) ----------
  function utf8Bytes(str) {
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) {
        out.push(c);
      } else if (c < 0x800) {
        out.push(0xC0 | (c >> 6), 0x80 | (c & 0x3F));
      } else if (c >= 0xD800 && c <= 0xDBFF && i + 1 < str.length) {
        var c2 = str.charCodeAt(i + 1);
        if (c2 >= 0xDC00 && c2 <= 0xDFFF) {
          var cp = 0x10000 + ((c - 0xD800) << 10) + (c2 - 0xDC00);
          out.push(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3F),
            0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F));
          i++;
        } else {
          out.push(0xEF, 0xBF, 0xBD);
        }
      } else if (c >= 0xDC00 && c <= 0xDFFF) {
        out.push(0xEF, 0xBF, 0xBD);
      } else {
        out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F));
      }
    }
    return out;
  }

  function utf8String(bytes) {
    var out = "";
    for (var i = 0; i < bytes.length; i++) {
      var b = bytes[i], cp = 0, need = 0, min = 0;
      if (b < 0x80) { cp = b; need = 0; }
      else if (b >= 0xC2 && b < 0xE0) { cp = b & 0x1F; need = 1; min = 0x80; }
      else if (b >= 0xE0 && b < 0xF0) { cp = b & 0x0F; need = 2; min = 0x800; }
      else if (b >= 0xF0 && b < 0xF5) { cp = b & 0x07; need = 3; min = 0x10000; }
      else return null;
      if (i + need >= bytes.length) return null;
      for (var k = 1; k <= need; k++) {
        var cb = bytes[i + k];
        if ((cb & 0xC0) !== 0x80) return null;
        cp = (cp << 6) | (cb & 0x3F);
      }
      if (cp < min || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return null;
      i += need;
      if (cp > 0xFFFF) {
        cp -= 0x10000;
        out += String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF));
      } else {
        out += String.fromCharCode(cp);
      }
    }
    return out;
  }

  // ---------- base64url ----------
  var B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  function b64urlEncode(bytes) {
    var out = "";
    for (var i = 0; i < bytes.length; i += 3) {
      var b0 = bytes[i], b1 = i + 1 < bytes.length ? bytes[i + 1] : 0, b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
      var tri = (b0 << 16) | (b1 << 8) | b2;
      out += B64[(tri >> 18) & 63] + B64[(tri >> 12) & 63];
      if (i + 1 < bytes.length) out += B64[(tri >> 6) & 63];
      if (i + 2 < bytes.length) out += B64[tri & 63];
    }
    return out;
  }
  var B64REV = null;
  function b64urlDecode(str) {
    if (!B64REV) {
      B64REV = {};
      for (var i = 0; i < B64.length; i++) B64REV[B64[i]] = i;
    }
    if (typeof str !== "string" || str.length === 0 || str.length % 4 === 1) return null;
    var out = [], acc = 0, bits = 0;
    for (var j = 0; j < str.length; j++) {
      var v = B64REV[str[j]];
      if (v === undefined) return null;
      acc = (acc << 6) | v;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out.push((acc >> bits) & 0xFF);
      }
    }
    var rem = str.length % 4;
    var last = B64REV[str[str.length - 1]];
    if ((rem === 2 && (last & 0x0F) !== 0) || (rem === 3 && (last & 0x03) !== 0)) return null;
    return out;
  }

  // ---------- SHA-256 (FIPS 180-4, pure JS) ----------
  var SHA256_K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];

  function sha256Hex(input) {
    var bytes = typeof input === "string" ? utf8Bytes(input) : input;
    var bitLen = bytes.length * 8;
    var padded = bytes.slice();
    padded.push(0x80);
    while (padded.length % 64 !== 56) padded.push(0);
    // 64-bit big-endian length; bitLen fits in 2^53 for any sane input.
    var hi = Math.floor(bitLen / 0x100000000);
    var lo = bitLen >>> 0;
    for (var s = 3; s >= 0; s--) padded.push((hi >>> (s * 8)) & 0xFF);
    for (var s2 = 3; s2 >= 0; s2--) padded.push((lo >>> (s2 * 8)) & 0xFF);

    var h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    var w = new Array(64);
    for (var off = 0; off < padded.length; off += 64) {
      for (var t = 0; t < 16; t++) {
        w[t] = ((padded[off + t * 4] << 24) | (padded[off + t * 4 + 1] << 16) |
          (padded[off + t * 4 + 2] << 8) | padded[off + t * 4 + 3]) >>> 0;
      }
      for (var t2 = 16; t2 < 64; t2++) {
        var x = w[t2 - 15], y = w[t2 - 2];
        var s0 = (((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3)) >>> 0;
        var s1 = (((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10)) >>> 0;
        w[t2] = (w[t2 - 16] + s0 + w[t2 - 7] + s1) >>> 0;
      }
      var a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
      for (var t3 = 0; t3 < 64; t3++) {
        var S1 = (((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))) >>> 0;
        var ch = ((e & f) ^ (~e & g)) >>> 0;
        var t1 = (hh + S1 + ch + SHA256_K[t3] + w[t3]) >>> 0;
        var S0 = (((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))) >>> 0;
        var maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
        var t2v = (S0 + maj) >>> 0;
        hh = g; g = f; f = e; e = (d + t1) >>> 0;
        d = c; c = b; b = a; a = (t1 + t2v) >>> 0;
      }
      h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
      h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
    }
    var hex = "";
    for (var i = 0; i < 8; i++) hex += ("00000000" + h[i].toString(16)).slice(-8);
    return hex;
  }

  // ---------- Canonical JSON (sorted keys, strict types) ----------
  function canonicalize(value) {
    var t = typeof value;
    if (value === null || t === "number" || t === "boolean") {
      if (t === "number") {
        if (!Number.isFinite(value)) return "null";
        if (Object.is(value, -0)) return "0";
      }
      return JSON.stringify(value);
    }
    if (t === "bigint") return JSON.stringify(value.toString());
    if (t === "string") return JSON.stringify(value);
    if (Array.isArray(value)) {
      var parts = [];
      for (var i = 0; i < value.length; i++) {
        var el = value[i];
        parts.push(el === undefined ? "null" : canonicalize(el));
      }
      return "[" + parts.join(",") + "]";
    }
    if (t === "object") {
      var keys = Object.keys(value).sort();
      var out = [];
      for (var k = 0; k < keys.length; k++) {
        var v = value[keys[k]];
        if (v === undefined || typeof v === "function" || typeof v === "symbol") continue;
        out.push(JSON.stringify(keys[k]) + ":" + canonicalize(v));
      }
      return "{" + out.join(",") + "}";
    }
    throw new TypeError("canonicalize: unsupported type " + t);
  }

  // ---------- Seeded RNG (same LCG family as js/verifier.js) ----------
  function seededRandom(seed) {
    var s = (seed >>> 0) || 0;
    return function () {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  // ============================================================
  // DOMAIN 1 - Token bucket transition system
  // State: integer micro-tokens. refill(elapsedMicros) adds
  // elapsed*rate micro-tokens, clamped at capacity. Reference is BigInt.
  // ============================================================
  function tokenOracle(capMicros, rate, balMicros, elapsedMicros) {
    var limit = BigInt(capMicros);
    var next = BigInt(balMicros) + BigInt(elapsedMicros) * BigInt(rate);
    if (next > limit) next = limit;
    if (next < 0n) next = 0n; // oracle inputs are nonnegative; guard anyway
    var admit = next >= UNIT_BI;
    return { bal: admit ? next - UNIT_BI : next, admit: admit };
  }

  // A candidate bucket: refill(elapsedMicros), tryConsume(), balanceMicros().
  function makeVerifiedBucket(cap, rate, initial) {
    var limit = cap * UNIT;
    var bal = initial === undefined ? limit : initial;
    return {
      refill: function (elapsed) {
        bal = Math.min(limit, bal + elapsed * rate);
      },
      tryConsume: function () {
        if (bal >= UNIT) { bal -= UNIT; return true; }
        return false;
      },
      balanceMicros: function () { return bal; }
    };
  }

  var TOKEN_MUTANTS = [
    {
      id: "tb-float",
      domain: "token",
      name: "Float accumulator",
      blurb: "Accrues elapsed*rate through IEEE doubles instead of exact integer micro-tokens.",
      make: function (cap, rate, initial) {
        var tokens = initial === undefined ? cap : initial / UNIT;
        return {
          refill: function (elapsed) {
            tokens = Math.min(cap, tokens + (elapsed / 1000) * (rate / 1000));
          },
          tryConsume: function () { if (tokens >= 1.0) { tokens -= 1.0; return true; } return false; },
          balanceMicros: function () { return tokens * UNIT; }
        };
      }
    },
    {
      id: "tb-unclamped",
      domain: "token",
      name: "Missing capacity clamp",
      blurb: "Refill skips the min(capacity) bound, so idle time mints tokens.",
      make: function (cap, rate, initial) {
        var bal = initial === undefined ? cap * UNIT : initial;
        return {
          refill: function (elapsed) { bal = bal + elapsed * rate; },
          tryConsume: function () { if (bal >= UNIT) { bal -= UNIT; return true; } return false; },
          balanceMicros: function () { return bal; }
        };
      }
    },
    {
      id: "tb-strict",
      domain: "token",
      name: "Strict-boundary admission",
      blurb: "Admits only above one whole token instead of at one whole token.",
      make: function (cap, rate, initial) {
        var limit = cap * UNIT, bal = initial === undefined ? limit : initial;
        return {
          refill: function (elapsed) { bal = Math.min(limit, bal + elapsed * rate); },
          tryConsume: function () { if (bal > UNIT) { bal -= UNIT; return true; } return false; },
          balanceMicros: function () { return bal; }
        };
      }
    },
    {
      id: "tb-overflow",
      domain: "token",
      name: "32-bit refill overflow",
      blurb: "The refill increment is computed in signed 32-bit arithmetic and wraps negative.",
      make: function (cap, rate, initial) {
        var limit = cap * UNIT, bal = initial === undefined ? limit : initial;
        return {
          refill: function (elapsed) { bal = Math.min(limit, bal + Math.imul(elapsed, rate)); },
          tryConsume: function () { if (bal >= UNIT) { bal -= UNIT; return true; } return false; },
          balanceMicros: function () { return bal; }
        };
      }
    }
  ];

  // Token check helpers. A check returns { pass, witness } on a candidate factory.
  function runTokenTrace(cand, cap, rate, startBal, elapsedSeq, driftTol) {
    var obal = BigInt(startBal);
    for (var i = 0; i < elapsedSeq.length; i++) {
      cand.refill(elapsedSeq[i]);
      var oracle = tokenOracle(cap, rate, obal, elapsedSeq[i]);
      obal = oracle.bal;
      var candAdmit = cand.tryConsume();
      if (candAdmit !== oracle.admit) {
        return {
          pass: false,
          witness: {
            kind: "admission-divergence", step: i, elapsed: elapsedSeq[i], rate: rate,
            oracleAdmit: oracle.admit, mutantAdmit: candAdmit,
            oracleBal: String(oracle.admit ? oracle.bal + UNIT_BI : oracle.bal),
            mutantBal: String(Math.round(cand.balanceMicros() + (candAdmit ? UNIT : 0)))
          }
        };
      }
      var candBal = cand.balanceMicros();
      if (candBal > Number(obal) + 0.5) {
        return {
          pass: false,
          witness: {
            kind: "capacity-exceeded", step: i, elapsed: elapsedSeq[i], rate: rate,
            oracleBal: String(obal), mutantBal: String(candBal)
          }
        };
      }
      var drift = Math.abs(candBal - Number(obal));
      if (drift > driftTol) {
        return {
          pass: false,
          witness: {
            kind: "balance-drift", step: i, elapsed: elapsedSeq[i], rate: rate,
            oracleBal: String(obal), mutantBal: String(candBal),
            driftMicros: String(Math.round(drift * 1000) / 1000)
          }
        };
      }
    }
    return { pass: true };
  }

  function tokenUnitChecks(cand, cap, rate) {
    // Fixed three-scenario suite: exact boundary admission, capacity count,
    // and two half-token refills that must sum to one admission.
    var c1 = cand(cap, rate);
    var seq = [];
    for (var d = 0; d < cap; d++) seq.push(0);
    seq.push(UNIT / rate);
    var r1 = runTokenTrace(c1, cap * UNIT, rate, cap * UNIT, seq, 0.5);
    if (!r1.pass) {
      r1.witness.scenario = "drain then refill exactly one token; admission must include the boundary";
      return r1;
    }

    var c2 = cand(cap, rate);
    c2.refill(2 * cap * UNIT / rate);
    var seen = 0;
    for (var i = 0; i < cap * 2 + 2; i++) if (c2.tryConsume()) seen++;
    if (seen !== cap) {
      return {
        pass: false,
        witness: {
          kind: "admission-count", scenario: "refill 2x capacity worth of time then drain",
          expectedAdmits: cap, mutantAdmits: seen
        }
      };
    }

    var c3 = cand(cap, rate, 0);
    var r3 = runTokenTrace(c3, cap * UNIT, rate, 0, [UNIT / 2 / rate, UNIT - UNIT / 2], 0.5);
    if (!r3.pass) {
      r3.witness.scenario = "two half-token refills from empty must admit exactly once";
      return r3;
    }
    return { pass: true };
  }

  function tokenFuzzCheck(cand, cap, rate, seed, traces, ops) {
    var rng = seededRandom(seed);
    for (var tr = 0; tr < traces; tr++) {
      var seq = [];
      if (tr === 0) {
        // Deterministic edge trace: drain to empty, then land exactly on one token.
        for (var d = 0; d < cap; d++) seq.push(0);
        seq.push(UNIT / rate);
      }
      for (var i = seq.length; i < ops; i++) {
        var pick = rng();
        if (pick < 0.15) seq.push((UNIT - 1) / rate);
        else if (pick < 0.3) seq.push(UNIT / rate);
        else if (pick < 0.4) seq.push((UNIT + 1) / rate);
        else seq.push(Math.floor(rng() * 4 * UNIT / rate));
      }
      var c = cand(cap, rate);
      var r = runTokenTrace(c, cap * UNIT, rate, cap * UNIT, seq, 0.5);
      if (!r.pass) {
        r.witness.trace = tr;
        r.witness.elapsedPrefix = seq.slice(0, r.witness.step + 1);
        return r;
      }
    }
    return { pass: true };
  }

  function tokenFormalCheck(cand) {
    // Exhaustive single-transition check over a boundary corpus. The gate
    // compares exact integer state, so a correct candidate matches bit-for-bit.
    var caps = [1, 2, 3, 5, 10];
    var rates = [1, 7];
    var elapsedCorpus = [0, 1, 13, 999999, 1000000, 1000001, 2000000, 5000000,
      306783379, 2147483647, 2147483648, 4294967296, 9007199254740991];
    for (var ci = 0; ci < caps.length; ci++) {
      var cap = caps[ci];
      var balOptions = [0, UNIT - 1, UNIT, Math.floor(cap * UNIT / 2), cap * UNIT - 1, cap * UNIT];
      for (var ri = 0; ri < rates.length; ri++) {
        var rate = rates[ri];
        for (var bi = 0; bi < balOptions.length; bi++) {
          for (var di = 0; di < elapsedCorpus.length; di++) {
            var bal = balOptions[bi], elapsed = elapsedCorpus[di];
            var oracle = tokenOracle(cap * UNIT, rate, bal, elapsed);
            var probe = cand(cap, rate, bal);
            probe.refill(elapsed);
            var admitM = probe.tryConsume();
            var balM = probe.balanceMicros();
            if (admitM !== oracle.admit) {
              return {
                pass: false,
                witness: {
                  kind: "admission-divergence", scenario: "single transition",
                  cap: cap, rate: rate, balance: bal, elapsed: elapsed,
                  oracleAdmit: oracle.admit, mutantAdmit: admitM,
                  oracleNext: String(oracle.bal), mutantNext: String(Math.round(balM))
                }
              };
            }
            if (balM !== Number(oracle.bal)) {
              return {
                pass: false,
                witness: {
                  kind: "state-divergence", scenario: "single transition, exact integer equality",
                  cap: cap, rate: rate, balance: bal, elapsed: elapsed,
                  oracleNext: String(oracle.bal), mutantNext: String(balM)
                }
              };
            }
          }
        }
      }
    }
    return { pass: true };
  }

  // ============================================================
  // DOMAIN 2 - Byzantine quorum safety vs liveness
  // Safe iff intersection bound holds AND an honest quorum exists.
  // ============================================================
  var N_MAX = 64;
  function quorumParamsValid(N, f, q) {
    return Number.isSafeInteger(N) && Number.isSafeInteger(f) && Number.isSafeInteger(q) &&
      N >= 1 && N <= N_MAX && f >= 0 && f < N && q >= 1 && q <= N;
  }

  function quorumOracle(N, f, q) {
    if (!quorumParamsValid(N, f, q)) return false;
    return (2 * q - N > f) && (q <= N - f);
  }

  var QUORUM_MUTANTS = [
    {
      id: "q-safety-only",
      domain: "quorum",
      name: "Intersection-only gate",
      blurb: "Checks 2q - N > f but never checks that an honest quorum can form.",
      make: function () {
        return {
          verdict: function (N, f, q) {
            return quorumParamsValid(N, f, q) && (2 * q - N > f);
          }
        };
      }
    },
    {
      id: "q-liveness-only",
      domain: "quorum",
      name: "Liveness-only gate",
      blurb: "Checks q <= N - f but never checks quorum intersection.",
      make: function () {
        return {
          verdict: function (N, f, q) {
            return quorumParamsValid(N, f, q) && (q <= N - f);
          }
        };
      }
    },
    {
      id: "q-bft3f",
      domain: "quorum",
      name: "N >= 3f threshold gate",
      blurb: "Approves any q whenever N >= 3f, ignoring the intersection bound.",
      make: function () {
        return {
          verdict: function (N, f, q) {
            return quorumParamsValid(N, f, q) && N >= 3 * f && q <= N;
          }
        };
      }
    },
    {
      id: "q-offbyone",
      domain: "quorum",
      name: "Off-by-one intersection bound",
      blurb: "Uses 2q - N >= f, admitting a boundary where the whole overlap is Byzantine.",
      make: function () {
        return {
          verdict: function (N, f, q) {
            return quorumParamsValid(N, f, q) && (2 * q - N >= f) && (q <= N - f);
          }
        };
      }
    }
  ];

  // Constructive split-brain witness. When 2q - N <= f the minimal quorum
  // intersection fits entirely inside the Byzantine set: build two concrete
  // quorums whose honest overlap is empty.
  function buildSplitBrain(N, f, q) {
    if (!quorumParamsValid(N, f, q)) return null;
    var minInter = Math.max(0, 2 * q - N);
    if (minInter > f) return null; // safety holds; no split brain exists
    var honest = [], byz = [];
    for (var i = 0; i < N; i++) (i < N - f ? honest : byz).push(i);
    var shared = byz.slice(0, minInter);
    var pool = byz.slice(minInter).concat(honest);
    var need = q - minInter;
    if (need < 0 || 2 * need > pool.length) return null;
    var q1 = shared.concat(pool.slice(0, need));
    var q2 = shared.concat(pool.slice(need, 2 * need));
    var hset = {};
    for (var h = 0; h < honest.length; h++) hset[honest[h]] = true;
    var q2set = {};
    for (var m = 0; m < q2.length; m++) q2set[q2[m]] = true;
    var honestInter = q1.filter(function (x) { return hset[x] && q2set[x]; });
    return {
      q1: q1, q2: q2,
      shared: shared,
      sharedAllByzantine: shared.every(function (x) { return x >= N - f; }),
      honestIntersection: honestInter,
      minIntersectionBound: minInter
    };
  }

  function quorumUnitChecks(cand) {
    // Fixed pair suite: one safe config and one classic split-brain config.
    var inst = cand();
    var cases = [
      { N: 7, f: 2, q: 5, expect: true },
      { N: 6, f: 2, q: 4, expect: false },
      { N: 4, f: 1, q: 3, expect: true }
    ];
    for (var i = 0; i < cases.length; i++) {
      var c = cases[i];
      var got = inst.verdict(c.N, c.f, c.q);
      if (got !== c.expect) {
        var w = {
          kind: "verdict-divergence", N: c.N, f: c.f, q: c.q,
          oracleVerdict: c.expect, mutantVerdict: got
        };
        if (c.expect === false && quorumParamsValid(c.N, c.f, c.q) && (2 * c.q - c.N) <= c.f) {
          w.splitBrain = buildSplitBrain(c.N, c.f, c.q);
        }
        return { pass: false, witness: w };
      }
    }
    return { pass: true };
  }

  function quorumFuzzCheck(cand, seed, trials) {
    var inst = cand();
    var rng = seededRandom(seed);
    var probes = [
      { N: 6, f: 2, q: 4 }, { N: 7, f: 2, q: 6 }, { N: 4, f: 1, q: 4 }, { N: 9, f: 3, q: 7 }
    ];
    for (var p = 0; p < probes.length; p++) {
      var pr = probes[p];
      var g = inst.verdict(pr.N, pr.f, pr.q);
      var o = quorumOracle(pr.N, pr.f, pr.q);
      if (g !== o) return { pass: false, witness: quorumWitness(pr.N, pr.f, pr.q, o, g, "fixed-probe") };
    }
    for (var t = 0; t < trials; t++) {
      var N = 2 + Math.floor(rng() * 23);
      var f = Math.floor(rng() * N);
      var q = 1 + Math.floor(rng() * N);
      var got = inst.verdict(N, f, q);
      var expected = quorumOracle(N, f, q);
      if (got !== expected) {
        return { pass: false, witness: quorumWitness(N, f, q, expected, got, "fuzz-trial-" + t) };
      }
    }
    return { pass: true };
  }

  function quorumWitness(N, f, q, oracleVerdict, mutantVerdict, source) {
    var w = {
      kind: "verdict-divergence", N: N, f: f, q: q, source: source,
      oracleVerdict: oracleVerdict, mutantVerdict: mutantVerdict,
      intersectionBound: 2 * q - N,
      livenessBound: N - f
    };
    if (quorumParamsValid(N, f, q)) {
      var safety = 2 * q - N > f, liveness = q <= N - f;
      w.failedInvariant = !safety ? "safety" : (!liveness ? "liveness" : "none");
      if (!safety) w.splitBrain = buildSplitBrain(N, f, q);
      if (!liveness) w.stall = { note: "q exceeds N - f: f crashed honest nodes leave fewer than q voters", q: q, honestAvailable: N - f };
    }
    return w;
  }

  function quorumFormalCheck(cand) {
    // Exhaustive grid: every (N, f, q) with 1 <= N <= 12 must match the oracle.
    var inst = cand();
    for (var N = 1; N <= 12; N++) {
      for (var f = 0; f < N; f++) {
        for (var q = 1; q <= N; q++) {
          var got = inst.verdict(N, f, q);
          var expected = quorumOracle(N, f, q);
          if (got !== expected) {
            return { pass: false, witness: quorumWitness(N, f, q, expected, got, "exhaustive-grid") };
          }
        }
      }
    }
    return { pass: true };
  }

  // ============================================================
  // DOMAIN 3 - Battery Bellman optimality
  // Reference: DP optimum. Candidate must return the same profit
  // with a feasible honest path.
  // ============================================================
  function batteryProfit(a, price, d) {
    return -a * price - Math.abs(a) * d;
  }

  function batteryOptimal(prices, C, R, d, initSoc) {
    var T = prices.length;
    var V = [], choice = [];
    for (var t = 0; t <= T; t++) { V.push(new Array(C + 1).fill(0)); }
    for (var t2 = 0; t2 < T; t2++) { choice.push(new Array(C + 1).fill(0)); }
    for (var t3 = T - 1; t3 >= 0; t3--) {
      for (var s = 0; s <= C; s++) {
        var best = -Infinity, bestA = 0;
        for (var a = -R; a <= R; a++) {
          var ns = s + a;
          if (ns < 0 || ns > C) continue;
          var val = batteryProfit(a, prices[t3], d) + V[t3 + 1][ns];
          if (val > best) { best = val; bestA = a; }
        }
        V[t3][s] = best;
        choice[t3][s] = bestA;
      }
    }
    var soc = initSoc, path = [];
    for (var t4 = 0; t4 < T; t4++) {
      var a4 = choice[t4][soc];
      path.push({ t: t4, soc: soc, action: a4, profit: batteryProfit(a4, prices[t4], d) });
      soc += a4;
    }
    return { maxProfit: V[0][initSoc], path: path };
  }

  function batteryBruteForce(prices, C, R, d, initSoc) {
    var T = prices.length, best = -Infinity, bestPath = null;
    function dfs(t, soc, profit, path) {
      if (t === T) {
        if (profit > best) { best = profit; bestPath = path.slice(); }
        return;
      }
      for (var a = -R; a <= R; a++) {
        var ns = soc + a;
        if (ns < 0 || ns > C) continue;
        path.push({ t: t, soc: soc, action: a });
        dfs(t + 1, ns, profit + batteryProfit(a, prices[t], d), path);
        path.pop();
      }
    }
    dfs(0, initSoc, 0, []);
    return { maxProfit: best, bestPath: bestPath };
  }

  // Replay a candidate path under the real transition rules.
  function batteryRealize(prices, C, R, d, initSoc, path) {
    if (!Array.isArray(path) || path.length !== prices.length) {
      return { feasible: false, realized: -Infinity, reason: "path length mismatch" };
    }
    var soc = initSoc, realized = 0;
    for (var t = 0; t < path.length; t++) {
      var a = path[t] && path[t].action;
      if (!Number.isSafeInteger(a) || Math.abs(a) > R) {
        return { feasible: false, realized: -Infinity, reason: "illegal action at t=" + t };
      }
      if (path[t].soc !== soc) {
        return { feasible: false, realized: -Infinity, reason: "soc mismatch at t=" + t };
      }
      var ns = soc + a;
      if (ns < 0 || ns > C) {
        return { feasible: false, realized: -Infinity, reason: "soc bounds violated at t=" + t };
      }
      realized += batteryProfit(a, prices[t], d);
      soc = ns;
    }
    return { feasible: true, realized: realized };
  }

  function batteryCheckCase(cand, prices, C, R, d, initSoc) {
    var oracle = batteryOptimal(prices, C, R, d, initSoc);
    var out;
    try {
      out = cand().optimize(prices.slice(), C, R, d, initSoc);
    } catch (e) {
      return { pass: false, witness: { kind: "threw", prices: prices, C: C, R: R, d: d, initSoc: initSoc, error: String(e && e.message || e) } };
    }
    if (!out || typeof out.profit !== "number" || !Number.isFinite(out.profit)) {
      return { pass: false, witness: { kind: "no-result", prices: prices, C: C, R: R, d: d, initSoc: initSoc } };
    }
    var real = batteryRealize(prices, C, R, d, initSoc, out.path);
    var base = { prices: prices, C: C, R: R, d: d, initSoc: initSoc, claimed: out.profit, optimal: oracle.maxProfit };
    if (!real.feasible) {
      base.kind = "infeasible-path";
      base.detail = real.reason;
      base.path = out.path;
      return { pass: false, witness: base };
    }
    base.realized = real.realized;
    if (Math.abs(out.profit - real.realized) > 1e-9) {
      base.kind = "dishonest-profit";
      base.detail = "claimed " + out.profit + " but the reported path earns " + real.realized;
      return { pass: false, witness: base };
    }
    if (real.realized < oracle.maxProfit - 1e-9) {
      base.kind = "suboptimal";
      base.gap = oracle.maxProfit - real.realized;
      base.path = out.path;
      base.oraclePath = oracle.path;
      return { pass: false, witness: base };
    }
    return { pass: true };
  }

  var BATTERY_MUTANTS = [
    {
      id: "b-greedy",
      domain: "battery",
      name: "One-step greedy",
      blurb: "Picks the locally best action each period, ignoring option value of stored charge.",
      make: function () {
        return {
          optimize: function (prices, C, R, d, initSoc) {
            var soc = initSoc, total = 0, path = [];
            for (var t = 0; t < prices.length; t++) {
              var best = -Infinity, bestA = 0;
              for (var a = -R; a <= R; a++) {
                var ns = soc + a;
                if (ns < 0 || ns > C) continue;
                var v = batteryProfit(a, prices[t], d);
                if (v > best) { best = v; bestA = a; }
              }
              total += batteryProfit(bestA, prices[t], d);
              path.push({ t: t, soc: soc, action: bestA });
              soc += bestA;
            }
            return { profit: total, path: path };
          }
        };
      }
    },
    {
      id: "b-nodeg",
      domain: "battery",
      name: "Missing degradation cost",
      blurb: "Optimizes -a*price and drops the |a|*d term, so it over-cycles and misreports profit.",
      make: function () {
        return {
          optimize: function (prices, C, R, d, initSoc) {
            var T = prices.length, V = [], choice = [];
            for (var t = 0; t <= T; t++) V.push(new Array(C + 1).fill(0));
            for (var t2 = 0; t2 < T; t2++) choice.push(new Array(C + 1).fill(0));
            for (var t3 = T - 1; t3 >= 0; t3--) {
              for (var s = 0; s <= C; s++) {
                var best = -Infinity, bestA = 0;
                for (var a = -R; a <= R; a++) {
                  var ns = s + a;
                  if (ns < 0 || ns > C) continue;
                  var v = -a * prices[t3] + V[t3 + 1][ns];
                  if (v > best) { best = v; bestA = a; }
                }
                V[t3][s] = best;
                choice[t3][s] = bestA;
              }
            }
            var soc = initSoc, path = [], total = 0;
            for (var t4 = 0; t4 < T; t4++) {
              var a4 = choice[t4][soc];
              total += batteryProfit(a4, prices[t4], d);
              path.push({ t: t4, soc: soc, action: a4 });
              soc += a4;
            }
            // Reports its own objective value, not the realized profit.
            return { profit: V[0][initSoc], path: path };
          }
        };
      }
    },
    {
      id: "b-horizon",
      domain: "battery",
      name: "Truncated horizon",
      blurb: "Runs the DP on prices[0..T-2] and silently pads the last period with a hold.",
      make: function () {
        return {
          optimize: function (prices, C, R, d, initSoc) {
            var sub = prices.slice(0, Math.max(0, prices.length - 1));
            var r = batteryOptimal(sub, C, R, d, initSoc);
            var path = r.path.slice();
            var lastSoc = path.length ? path[path.length - 1].soc + path[path.length - 1].action : initSoc;
            if (prices.length) path.push({ t: prices.length - 1, soc: lastSoc, action: 0 });
            return { profit: r.maxProfit, path: path };
          }
        };
      }
    },
    {
      id: "b-socclip",
      domain: "battery",
      name: "SoC clipping mutant",
      blurb: "Clips soc + a into bounds instead of rejecting the action, booking phantom throughput.",
      make: function () {
        return {
          optimize: function (prices, C, R, d, initSoc) {
            var T = prices.length, V = [], choice = [];
            for (var t = 0; t <= T; t++) V.push(new Array(C + 1).fill(0));
            for (var t2 = 0; t2 < T; t2++) choice.push(new Array(C + 1).fill(0));
            var clip = function (x) { return Math.max(0, Math.min(C, x)); };
            for (var t3 = T - 1; t3 >= 0; t3--) {
              for (var s = 0; s <= C; s++) {
                var best = -Infinity, bestA = 0;
                for (var a = -R; a <= R; a++) {
                  var ns = clip(s + a);
                  var v = batteryProfit(a, prices[t3], d) + V[t3 + 1][ns];
                  if (v > best) { best = v; bestA = a; }
                }
                V[t3][s] = best;
                choice[t3][s] = bestA;
              }
            }
            var soc = initSoc, path = [], total = 0;
            for (var t4 = 0; t4 < T; t4++) {
              var a4 = choice[t4][clip(soc)];
              total += batteryProfit(a4, prices[t4], d);
              path.push({ t: t4, soc: clip(soc), action: a4 });
              soc = clip(soc + a4);
            }
            return { profit: total, path: path };
          }
        };
      }
    }
  ];

  function batteryUnitChecks(cand) {
    var cases = [
      { prices: [3, 1, 10, 2], C: 1, R: 1, d: 1.0, initSoc: 1 },
      { prices: [1, 5, 1, 8], C: 2, R: 1, d: 0.5, initSoc: 0 },
      { prices: [5, 5, 5], C: 1, R: 1, d: 0.2, initSoc: 0 }
    ];
    for (var i = 0; i < cases.length; i++) {
      var r = batteryCheckCase(cand, cases[i].prices, cases[i].C, cases[i].R, cases[i].d, cases[i].initSoc);
      if (!r.pass) return r;
    }
    return { pass: true };
  }

  function batteryFuzzCheck(cand, seed, trials) {
    var probes = [
      { prices: [3, 1, 10, 2], C: 1, R: 1, d: 1.0, initSoc: 1 },
      { prices: [1, 1, 9], C: 1, R: 1, d: 0.5, initSoc: 1 },
      { prices: [5, 1, 8], C: 1, R: 1, d: 0.4, initSoc: 1 }
    ];
    for (var p = 0; p < probes.length; p++) {
      var pr = probes[p];
      var r0 = batteryCheckCase(cand, pr.prices, pr.C, pr.R, pr.d, pr.initSoc);
      if (!r0.pass) {
        r0.witness.source = "fixed-probe-" + p;
        return r0;
      }
    }
    var rng = seededRandom(seed);
    for (var t = 0; t < trials; t++) {
      var C = 1 + Math.floor(rng() * 3);
      var R = 1 + Math.floor(rng() * 2);
      var d = Math.floor(rng() * 15) / 10;
      var T = 3 + Math.floor(rng() * 4);
      var prices = [];
      for (var i = 0; i < T; i++) prices.push(Math.floor(rng() * 95) / 10 + 0.5);
      var initSoc = Math.floor(rng() * (C + 1));
      var r = batteryCheckCase(cand, prices, C, R, d, initSoc);
      if (!r.pass) {
        r.witness.source = "fuzz-trial-" + t;
        return r;
      }
    }
    return { pass: true };
  }

  function batteryFormalCheck(cand) {
    // Exhaustive small-horizon agreement: every price curve over {1,5,9} of
    // length <= 4, both start charges, two degradation rates.
    var alphabet = [1, 5, 9];
    var ds = [0.3, 0.8];
    for (var T = 1; T <= 4; T++) {
      var total = Math.pow(alphabet.length, T);
      for (var idx = 0; idx < total; idx++) {
        var x = idx, prices = [];
        for (var i = 0; i < T; i++) { prices.push(alphabet[x % alphabet.length]); x = Math.floor(x / alphabet.length); }
        for (var di = 0; di < ds.length; di++) {
          for (var init = 0; init <= 2; init++) {
            var r = batteryCheckCase(cand, prices, 2, 1, ds[di], init);
            if (!r.pass) {
              r.witness.source = "exhaustive-horizon";
              return r;
            }
          }
        }
      }
    }
    return { pass: true };
  }

  // ============================================================
  // Mutant catalog, policies and the ablation runner
  // ============================================================
  var MUTANTS = TOKEN_MUTANTS.concat(QUORUM_MUTANTS, BATTERY_MUTANTS);

  var POLICIES = [
    { id: "none", name: "No Gate", desc: "Ships every candidate unchecked." },
    { id: "unit", name: "Unit Tests Only", desc: "A fixed suite of canonical cases per domain." },
    { id: "fuzz", name: "Property Fuzz", desc: "Seeded randomized differential checks plus edge probes." },
    { id: "combined", name: "Formal + Gate Combined", desc: "Unit suite, fuzz and exhaustive formal checks." }
  ];

  function makeCandidate(mutantId) {
    for (var i = 0; i < MUTANTS.length; i++) {
      if (MUTANTS[i].id === mutantId) return MUTANTS[i];
    }
    return null;
  }

  var CHECK_SUITES = {
    token: {
      unit: function (cand) { return tokenUnitChecks(cand, 5, 1); },
      fuzz: function (cand, seed) { return tokenFuzzCheck(cand, 5, 1, seed, 6, 40); },
      formal: function (cand) { return tokenFormalCheck(cand); }
    },
    quorum: {
      unit: function (cand) { return quorumUnitChecks(cand); },
      fuzz: function (cand, seed) { return quorumFuzzCheck(cand, seed, 200); },
      formal: function (cand) { return quorumFormalCheck(cand); }
    },
    battery: {
      unit: function (cand) { return batteryUnitChecks(cand); },
      fuzz: function (cand, seed) { return batteryFuzzCheck(cand, seed, 40); },
      formal: function (cand) { return batteryFormalCheck(cand); }
    }
  };

  var POLICY_SUITES = {
    none: [],
    unit: ["unit"],
    fuzz: ["fuzz"],
    combined: ["unit", "fuzz", "formal"]
  };

  function evaluateMutant(mutantId, policyId, seed) {
    var mutant = makeCandidate(mutantId);
    if (!mutant) throw new RangeError("unknown mutant " + mutantId);
    var suites = POLICY_SUITES[policyId];
    if (!suites) throw new RangeError("unknown policy " + policyId);
    var checksRun = 0;
    var cand = mutant.make;
    for (var i = 0; i < suites.length; i++) {
      var check = CHECK_SUITES[mutant.domain][suites[i]];
      checksRun++;
      var r = check(cand, seed === undefined ? 42 : seed);
      if (!r.pass) {
        return {
          mutant: mutantId, domain: mutant.domain, policy: policyId,
          caught: true, check: suites[i], checksRun: checksRun, witness: r.witness || null
        };
      }
    }
    return {
      mutant: mutantId, domain: mutant.domain, policy: policyId,
      caught: false, check: null, checksRun: checksRun, witness: null
    };
  }

  function runAblationMatrix(seed) {
    var cells = [];
    var summary = {};
    for (var pi = 0; pi < POLICIES.length; pi++) {
      summary[POLICIES[pi].id] = { caught: 0, escaped: 0 };
    }
    for (var mi = 0; mi < MUTANTS.length; mi++) {
      for (var pj = 0; pj < POLICIES.length; pj++) {
        var cell = evaluateMutant(MUTANTS[mi].id, POLICIES[pj].id, seed);
        cells.push(cell);
        if (cell.caught) summary[POLICIES[pj].id].caught++;
        else summary[POLICIES[pj].id].escaped++;
      }
    }
    return { mutants: MUTANTS.map(function (m) { return { id: m.id, domain: m.domain, name: m.name, blurb: m.blurb }; }), policies: POLICIES, cells: cells, summary: summary, seed: seed === undefined ? 42 : seed };
  }

  // ============================================================
  // Phase-plane solver
  // ============================================================
  function phaseCell(N, f, q) {
    if (!Number.isSafeInteger(N) || !Number.isSafeInteger(f) || !Number.isSafeInteger(q)) {
      return { valid: false, classification: "invalid" };
    }
    var valid = quorumParamsValid(N, f, q);
    if (!valid) return { valid: false, classification: "invalid" };
    var safety = 2 * q - N > f;
    var liveness = q <= N - f;
    var bft = N >= 3 * f + 1;
    var classification = safety && liveness ? "safe"
      : (!safety && liveness) ? "split-brain"
      : (safety && !liveness) ? "deadlock" : "doomed";
    var cell = {
      valid: true, N: N, f: f, q: q,
      safety: safety, liveness: liveness, bftFeasible: bft,
      intersectionBound: 2 * q - N,
      honestAvailable: N - f,
      classification: classification
    };
    if (!safety) cell.splitBrain = buildSplitBrain(N, f, q);
    return cell;
  }

  function phasePlane(N, fMax) {
    if (!Number.isSafeInteger(N) || N < 1 || N > N_MAX) {
      throw new RangeError("phasePlane requires integer 1 <= N <= " + N_MAX);
    }
    if (fMax !== undefined && (!Number.isSafeInteger(fMax) || fMax < 0 || fMax > N - 1)) {
      throw new RangeError("phasePlane fMax requires integer 0 <= f <= N - 1");
    }
    var fLim = fMax === undefined ? Math.floor(N / 2) : fMax;
    var rows = [];
    for (var q = N; q >= 1; q--) {
      var row = [];
      for (var f = 0; f <= fLim; f++) row.push(phaseCell(N, f, q));
      rows.push(row);
    }
    return { N: N, fMax: fLim, rows: rows };
  }

  // ============================================================
  // Certificate: cached canonical digest, JSON, CSV, Markdown
  // ============================================================
  var certCache = new Map();

  function certificate(payload) {
    var canonical = canonicalize(payload);
    var entry = certCache.get(canonical);
    if (!entry) {
      entry = { canonical: canonical, digest: sha256Hex(canonical) };
      certCache.set(canonical, entry);
    }
    return entry;
  }

  function buildLabPayload(state, matrix) {
    var cells = (matrix && matrix.cells) || runAblationMatrix().cells;
    return {
      schema: "museweaver-ablation/1",
      scope: "Deterministic mathematical checks over fixed mutant catalog; not a whole-program proof",
      state: state,
      mutants: MUTANTS.map(function (m) { return { id: m.id, domain: m.domain, name: m.name }; }),
      cells: cells.map(function (c) {
        return { mutant: c.mutant, domain: c.domain, policy: c.policy, caught: c.caught, check: c.check, witness: c.witness };
      }),
      summary: (matrix && matrix.summary) || runAblationMatrix().summary
    };
  }

  function exportCertificateJson(payload) {
    var cert = certificate(payload);
    var body = {
      schema: payload.schema || "museweaver-ablation/1",
      payload: payload,
      integrity: { algorithm: "SHA-256", encoding: "canonical-json-utf8", digest: cert.digest }
    };
    return JSON.stringify(body, null, 2);
  }

  function csvCell(value) {
    var s = value === null || value === undefined ? "" : String(value);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    if (/[",\n\r]/.test(s) || s !== s.trim()) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function exportCertificateCsv(payload) {
    var cert = certificate(payload);
    var lines = [
      "# museweaver-ablation-certificate",
      "# sha256-canonical-json: " + cert.digest,
      "# scope: deterministic mathematical checks; not a whole-program proof",
      "mutant,domain,policy,caught,check,witness"
    ];
    var cells = payload.cells || [];
    for (var i = 0; i < cells.length; i++) {
      var c = cells[i];
      lines.push([
        csvCell(c.mutant), csvCell(c.domain), csvCell(c.policy),
        csvCell(c.caught ? "caught" : "escaped"), csvCell(c.check || ""),
        csvCell(c.witness ? JSON.stringify(c.witness) : "")
      ].join(","));
    }
    return lines.join("\n") + "\n";
  }

  function exportCertificateMarkdown(payload) {
    var cert = certificate(payload);
    var cells = payload.cells || [];
    var byMutant = {};
    for (var i = 0; i < cells.length; i++) {
      var c = cells[i];
      (byMutant[c.mutant] = byMutant[c.mutant] || {})[c.policy] = c;
    }
    var lines = [];
    lines.push("# MuseWeaver Ablation Certificate");
    lines.push("");
    lines.push("Deterministic mathematical checks over the bundled 12-mutant catalog. Coverage of this certificate is the mutant set below, not the whole application.");
    lines.push("");
    lines.push("| Mutant | Domain | No Gate | Unit Tests | Property Fuzz | Formal + Gate |");
    lines.push("| --- | --- | --- | --- | --- | --- |");
    var order = ["none", "unit", "fuzz", "combined"];
    var ids = Object.keys(byMutant);
    for (var m = 0; m < ids.length; m++) {
      var row = byMutant[ids[m]];
      var marks = order.map(function (p) {
        var cell = row[p];
        if (!cell) return "-";
        return cell.caught ? "caught (" + (cell.check || "?") + ")" : "escaped";
      });
      var meta = null;
      for (var mm = 0; mm < MUTANTS.length; mm++) if (MUTANTS[mm].id === ids[m]) meta = MUTANTS[mm];
      lines.push("| " + (meta ? meta.name : ids[m]) + " | " + (meta ? meta.domain : "") + " | " + marks.join(" | ") + " |");
    }
    lines.push("");
    lines.push("## Integrity");
    lines.push("");
    lines.push("- Algorithm: SHA-256 over canonical JSON (UTF-8, sorted keys)");
    lines.push("- Digest: `" + cert.digest + "`");
    lines.push("");
    return lines.join("\n");
  }

  // Recompute the digest over the payload inside an exported JSON document.
  function verifyCertificateJson(jsonText) {
    var doc;
    try { doc = JSON.parse(jsonText); } catch (e) { return { ok: false, reason: "unparseable-json" }; }
    if (!doc || typeof doc !== "object" || !doc.integrity || !doc.payload) {
      return { ok: false, reason: "missing-integrity-block" };
    }
    var recomputed = sha256Hex(canonicalize(doc.payload));
    return {
      ok: recomputed === doc.integrity.digest,
      expected: recomputed,
      actual: doc.integrity.digest
    };
  }

  // ============================================================
  // #mw= bookmark codec - normalized, fail-closed
  // ============================================================
  var MW_TABS = { all: 1, token: 1, quorum: 1, battery: 1 };
  var MW_MAX_N = 20;

  function normalizeLabState(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    var state = { v: 1, tab: "all", n: 6, f: -1, q: -1, m: "" };
    if (raw.v !== undefined && raw.v !== 1) return null;
    if (raw.tab !== undefined) {
      if (typeof raw.tab !== "string" || !MW_TABS[raw.tab]) return null;
      state.tab = raw.tab;
    }
    if (raw.n !== undefined) {
      if (!Number.isSafeInteger(raw.n) || raw.n < 3 || raw.n > MW_MAX_N) return null;
      state.n = raw.n;
    }
    if (raw.f !== undefined && raw.f !== null && raw.f !== -1) {
      if (!Number.isSafeInteger(raw.f) || raw.f < 0 || raw.f > state.n - 1) return null;
      state.f = raw.f;
    }
    if (raw.q !== undefined && raw.q !== null && raw.q !== -1) {
      if (!Number.isSafeInteger(raw.q) || raw.q < 1 || raw.q > state.n) return null;
      state.q = raw.q;
    }
    if (raw.m !== undefined && raw.m !== null && raw.m !== "") {
      if (typeof raw.m !== "string" || !makeCandidate(raw.m)) return null;
      state.m = raw.m;
    }
    return state;
  }

  function encodeMwHash(state) {
    var norm = normalizeLabState(state);
    if (!norm) return null;
    return "#mw=" + b64urlEncode(utf8Bytes(JSON.stringify(norm)));
  }

  function decodeMwHash(hash) {
    if (typeof hash !== "string" || hash.length > 4096) return null;
    var m = /^#?mw=([A-Za-z0-9_-]+)$/.exec(hash);
    if (!m) return null;
    var bytes = b64urlDecode(m[1]);
    if (!bytes || bytes.length > 2048) return null;
    var text;
    try { text = utf8String(bytes); } catch (e) { return null; }
    var obj;
    try { obj = JSON.parse(text); } catch (e) { return null; }
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
    var keys = Object.keys(obj);
    for (var k = 0; k < keys.length; k++) {
      if (keys[k] === "__proto__" || keys[k] === "constructor" || keys[k] === "prototype") return null;
    }
    return normalizeLabState(obj);
  }

  // ============================================================
  // In-page deterministic self-tests
  // ============================================================
  function runSelfTests() {
    var out = [];
    var t = function (name, fn) {
      try {
        var r = fn();
        out.push({ name: name, pass: r === undefined || r === true || (r && r.pass === true), detail: r && r.detail || "" });
      } catch (e) {
        out.push({ name: name, pass: false, detail: String(e && e.message || e) });
      }
    };

    t("sha256-kat-empty", function () {
      return sha256Hex("") === "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    });
    t("sha256-kat-abc", function () {
      return sha256Hex("abc") === "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
    });
    t("sha256-kat-56byte", function () {
      return sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq") ===
        "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1";
    });
    t("sha256-kat-112byte", function () {
      return sha256Hex("abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu") ===
        "cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1";
    });
    t("bigint-saturation", function () {
      var r = tokenOracle(5 * UNIT, 7, 0, 9007199254740991);
      return r.bal === 4000000n && r.admit === true;
    });
    t("splitbrain-constructive", function () {
      for (var N = 2; N <= 10; N++) {
        for (var f = 0; f < N; f++) {
          for (var q = 1; q <= N; q++) {
            if (2 * q - N > f) continue;
            var sb = buildSplitBrain(N, f, q);
            if (!sb || sb.q1.length !== q || sb.q2.length !== q || sb.honestIntersection.length !== 0) return false;
          }
        }
      }
      return true;
    });
    t("dp-equals-bruteforce", function () {
      var curves = [[3, 1, 10, 2], [1, 5, 1, 8], [9, 1, 9], [2, 7, 2, 7]];
      for (var i = 0; i < curves.length; i++) {
        var dp = batteryOptimal(curves[i], 2, 1, 0.5, 0);
        var bf = batteryBruteForce(curves[i], 2, 1, 0.5, 0);
        if (Math.abs(dp.maxProfit - bf.maxProfit) > 1e-9) return false;
      }
      return true;
    });
    t("csv-formula-escape", function () {
      return csvCell("=CMD()") === "'=CMD()" &&
        csvCell("+1") === "'+1" &&
        csvCell("-1") === "'-1" &&
        csvCell("@x") === "'@x" &&
        csvCell('a,b') === '"a,b"' &&
        csvCell('say "hi"') === '"say ""hi"""' &&
        csvCell("line\nbreak") === '"line\nbreak"';
    });
    t("tamper-detect", function () {
      var payload = buildLabPayload({ v: 1, tab: "all", n: 6, f: -1, q: -1, m: "" });
      var json = exportCertificateJson(payload);
      if (!verifyCertificateJson(json).ok) return false;
      var doc = JSON.parse(json);
      doc.payload.cells[0].caught = !doc.payload.cells[0].caught;
      var forged = JSON.stringify(doc);
      return verifyCertificateJson(forged).ok === false;
    });
    t("mw-roundtrip", function () {
      var states = [
        { v: 1, tab: "all", n: 6, f: -1, q: -1, m: "" },
        { v: 1, tab: "quorum", n: 20, f: 10, q: 15, m: "tb-float" },
        { v: 1, tab: "battery", n: 3, f: 0, q: 1, m: "b-greedy" }
      ];
      for (var i = 0; i < states.length; i++) {
        var h = encodeMwHash(states[i]);
        var back = decodeMwHash(h);
        if (!back || JSON.stringify(back) !== JSON.stringify(normalizeLabState(states[i]))) return false;
      }
      return true;
    });
    t("mw-failclosed", function () {
      var hostile = ["", "#", "#mw=", "#mw=!!!", "#mw=<script>", "mw=AAAA",
        "#other=AAAA", "#mw=" + b64urlEncode(utf8Bytes('{"v":2}')),
        "#mw=" + b64urlEncode(utf8Bytes('{"v":1,"n":999}')),
        "#mw=" + b64urlEncode(utf8Bytes('{"v":1,"tab":"x"}')),
        "#mw=" + b64urlEncode(utf8Bytes('{"v":1,"m":"nope"}')),
        "#mw=" + b64urlEncode(utf8Bytes('[1,2]')),
        "#mw=" + b64urlEncode(utf8Bytes('null')),
        "#mw=" + b64urlEncode(utf8Bytes('"str"')),
        "#mw=" + b64urlEncode(utf8Bytes('{"__proto__":{"polluted":1},"v":1}')),
        "javascript:alert(1)", 0, null, {}, "#mw=" + "A".repeat(5000)];
      for (var i = 0; i < hostile.length; i++) {
        if (decodeMwHash(hostile[i]) !== null) return false;
      }
      var clean = decodeMwHash("#mw=" + b64urlEncode(utf8Bytes('{"__proto__":{"polluted":1},"v":1,"n":7}')));
      return clean === null || ({}).polluted === undefined && clean.polluted === undefined;
    });
    t("canonical-determinism", function () {
      var a = canonicalize({ b: 1, a: [3, 2, 1], c: { z: 0, y: true } });
      var b = canonicalize({ c: { y: true, z: 0 }, a: [3, 2, 1], b: 1 });
      if (a !== b) return false;
      var c1 = certificate({ x: 1 });
      var c2 = certificate({ x: 1 });
      return c1 === c2 && c1.digest.length === 64;
    });
    t("phaseplane-oracle-agreement", function () {
      for (var N = 1; N <= 12; N++) {
        for (var f = 0; f < N; f++) {
          for (var q = 1; q <= N; q++) {
            var cell = phaseCell(N, f, q);
            if (cell.safety !== (2 * q - N > f)) return false;
            if (cell.liveness !== (q <= N - f)) return false;
            if (cell.bftFeasible !== (N >= 3 * f + 1)) return false;
            var safe = cell.safety && cell.liveness;
            if ((cell.classification === "safe") !== safe) return false;
          }
        }
      }
      return true;
    });
    t("ablation-combined-catches-12", function () {
      var matrix = runAblationMatrix(42);
      return matrix.summary.combined.caught === 12 && matrix.summary.none.caught === 0;
    });
    t("witness-replay", function () {
      for (var i = 0; i < MUTANTS.length; i++) {
        var cell = evaluateMutant(MUTANTS[i].id, "combined", 42);
        if (!cell.caught || !cell.witness) return false;
      }
      return true;
    });
    t("b64url-roundtrip", function () {
      var bytes = utf8Bytes("MuseWeaver-lab-\u00e9\u4e2d\ud83d\ude80");
      var enc = b64urlEncode(bytes);
      if (/[+/=]/.test(enc)) return false;
      var back = b64urlDecode(enc);
      if (!back || back.length !== bytes.length) return false;
      for (var i = 0; i < bytes.length; i++) if (back[i] !== bytes[i]) return false;
      return true;
    });

    return out;
  }

  // ============================================================
  // Public surface
  // ============================================================
  var api = {
    UNIT: UNIT,
    utf8Bytes: utf8Bytes,
    utf8String: utf8String,
    b64urlEncode: b64urlEncode,
    b64urlDecode: b64urlDecode,
    sha256Hex: sha256Hex,
    canonicalize: canonicalize,
    seededRandom: seededRandom,
    tokenOracle: tokenOracle,
    makeVerifiedBucket: makeVerifiedBucket,
    quorumOracle: quorumOracle,
    quorumParamsValid: quorumParamsValid,
    buildSplitBrain: buildSplitBrain,
    phaseCell: phaseCell,
    phasePlane: phasePlane,
    batteryProfit: batteryProfit,
    batteryOptimal: batteryOptimal,
    batteryBruteForce: batteryBruteForce,
    batteryRealize: batteryRealize,
    MUTANTS: MUTANTS,
    TOKEN_MUTANTS: TOKEN_MUTANTS,
    QUORUM_MUTANTS: QUORUM_MUTANTS,
    BATTERY_MUTANTS: BATTERY_MUTANTS,
    POLICIES: POLICIES,
    evaluateMutant: evaluateMutant,
    runAblationMatrix: runAblationMatrix,
    certificate: certificate,
    buildLabPayload: buildLabPayload,
    exportCertificateJson: exportCertificateJson,
    exportCertificateCsv: exportCertificateCsv,
    exportCertificateMarkdown: exportCertificateMarkdown,
    verifyCertificateJson: verifyCertificateJson,
    csvCell: csvCell,
    encodeMwHash: encodeMwHash,
    decodeMwHash: decodeMwHash,
    normalizeLabState: normalizeLabState,
    runSelfTests: runSelfTests,
    _checks: CHECK_SUITES
  };

  global.MuseAblationLab = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  return api;
})(typeof window !== "undefined" ? window : globalThis);
