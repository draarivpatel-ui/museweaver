"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { performance } = require("node:perf_hooks");
const context = vm.createContext({ performance, console });
vm.runInContext(fs.readFileSync(path.join(__dirname, "../js/verifier.js"), "utf8"), context);
const Bucket = vm.runInContext("VerifiedBucket", context);

test("integer bucket saturates without overflowing intermediate arithmetic", () => {
  const bucket = new Bucket(10, Number.MAX_SAFE_INTEGER);
  for (let i = 0; i < 10; i++) assert.equal(bucket.tryConsume(0), true);
  bucket.refill(Number.MAX_SAFE_INTEGER);
  assert.equal(bucket.microTokens, 10000000);
  assert.equal(Number.isSafeInteger(bucket.microTokens), true);
});
for (const capacity of [-1, 0, 0.5, Infinity, Number.MAX_SAFE_INTEGER]) {
  test("reject invalid capacity " + capacity, () => assert.throws(() => new Bucket(capacity, 7)));
}
for (const rate of [-1, 0.5, NaN, Infinity]) {
  test("reject invalid rate " + rate, () => assert.throws(() => new Bucket(10, rate)));
}
test("monotonic time and exact admission boundaries", () => {
  const bucket = new Bucket(1, 1);
  assert.equal(bucket.tryConsume(0), true);
  assert.equal(bucket.tryConsume(999999), false);
  assert.equal(bucket.tryConsume(1000000), true);
  assert.throws(() => bucket.refill(999999));
  assert.throws(() => bucket.refill(NaN));
});
test("exact oracle agrees on 5000 seeded transitions", () => {
  const rng = vm.runInContext("seededRandom(0)", context);
  const bucket = new Bucket(7, 13);
  let time = 0, balance = 7000000n, last = 0;
  for (let i = 0; i < 5000; i++) {
    time += Math.floor(rng() * 50000);
    if (i) balance = balance + BigInt(time - last) * 13n;
    if (balance > 7000000n) balance = 7000000n;
    const admitted = balance >= 1000000n;
    if (admitted) balance -= 1000000n;
    assert.equal(bucket.tryConsume(time), admitted);
    assert.equal(bucket.microTokens, Number(balance));
    last = time;
  }
});
for (const scenario of ["rate-limiter", "quorum", "battery"]) {
  test("actual bundled verification scenario " + scenario, () => {
    const result = vm.runInContext("runVerification(" + JSON.stringify(scenario) + ", {trials: 12, seed: 0})", context);
    assert.equal(result.summary.verifiedBugs, 0);
    assert.ok(result.logs.length > 0);
  });
}
test("invalid fuzz controls are rejected", () => {
  for (const trials of [0, -1, 0.5, 10001]) {
    assert.throws(() => vm.runInContext("runVerification('battery', {trials:" + trials + "})", context));
  }
});
test("remote API endpoints reject hostname tricks and credential URLs", () => {
  const client = vm.createContext({ URL, localStorage: { removeItem() {} } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../js/captured-traces.js"), "utf8"), client);
  const validate = vm.runInContext("validateMuseEndpoint", client);
  for (const endpoint of ["https://evil-localhost.example/v1", "http://inference.baseten.co/v1",
                          "https://inference.baseten.co.evil.example/v1",
                          "https://user:pass@inference.baseten.co/v1", "https://inference.baseten.co/v1?token=demo"])
    assert.throws(() => validate(endpoint));
  assert.ok(validate("http://127.0.0.1:8080/v1").startsWith("http://127.0.0.1"));
});
