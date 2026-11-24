'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const L = require('../js/ablation-lab.js');

test('base64url decoder rejects impossible length and noncanonical trailing bits', () => {
  assert.equal(L.b64urlDecode('A'), null);
  assert.equal(L.b64urlDecode('AB'), null);
  assert.equal(L.b64urlDecode('AAB'), null);
  assert.deepEqual(L.b64urlDecode('AA'), [0]);
  assert.deepEqual(L.b64urlDecode('AAA'), [0, 0]);
});

test('UTF-8 decoder rejects malformed byte sequences', () => {
  assert.equal(L.utf8String([0x80]), null);
  assert.equal(L.utf8String([0xc0, 0x80]), null);
  assert.equal(L.utf8String([0xed, 0xa0, 0x80]), null);
  assert.equal(L.utf8String([0xf4, 0x90, 0x80, 0x80]), null);
  assert.equal(L.utf8String(L.utf8Bytes('valid text')), 'valid text');
});

test('bookmark hash fails closed on noncanonical base64url spelling', () => {
  const good = L.encodeMwHash({ v: 1, tab: 'quorum', n: 6, f: 1, q: 4, m: '' });
  assert.ok(good);
  const body = good.slice(4);
  assert.equal(L.decodeMwHash('#mw=' + body.slice(0, -1) + 'B'), null, 'altering only unused padding bits must not decode');
});

test('phasePlane validates optional fMax as an integer in range', () => {
  assert.equal(L.phasePlane(6).fMax, 3);
  assert.equal(L.phasePlane(6, 1).rows[0].length, 2);
  for (const bad of [-1, 6, 1.5, NaN, Infinity, '1']) {
    assert.throws(() => L.phasePlane(6, bad), RangeError);
  }
});

test('skip link target accepts keyboard focus', () => {
  const html = fs.readFileSync('index.html', 'utf8');
  assert.match(html, /<main id="main" tabindex="-1">/);
});
