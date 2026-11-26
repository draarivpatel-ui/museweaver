'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const HERE = __dirname;
const ROOT = fs.existsSync(path.join(HERE, 'index.html')) ? HERE : path.resolve(HERE, '..');
const SKIP_DIRS = new Set(['.git', '.github', '.kiro', '.pytest_cache', 'node_modules', 'demo', 'video']);
const SOURCE_EXTS = new Set(['.html', '.css', '.js', '.mjs', '.cjs']);
const REF_ATTRS = new Set([
  'for', 'aria-controls', 'aria-describedby', 'aria-labelledby',
  'aria-owns', 'aria-details', 'aria-errormessage', 'aria-activedescendant'
]);
const ASSET_LINK_RELS = new Set(['stylesheet', 'icon', 'preload', 'modulepreload', 'apple-touch-icon', 'manifest']);
const CDN_RE = /(?:https?:)?\/\/(?:cdn\.[^\s/]+|cdnjs\.cloudflare\.com|unpkg\.com|(?:[^\s/]+\.)?jsdelivr\.net|fonts\.googleapis\.com|fonts\.gstatic\.com|esm\.sh|cdn\.skypack\.dev)/i;

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (SOURCE_EXTS.has(path.extname(entry.name).toLowerCase())) out.push(full);
  }
  return out;
}

function parseAttrs(source) {
  const attrs = new Map();
  const re = /([A-Za-z_:][\w:.-]*)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g;
  for (const match of source.matchAll(re)) {
    let value = match[2] || '';
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    attrs.set(match[1].toLowerCase(), value);
  }
  return attrs;
}

function structuralHtml(html) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');
}

function inlineStyles(html) {
  return [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join('\n');
}

function localPath(url) {
  if (!url || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(url)) return null;
  const clean = url.split('#')[0].split('?')[0];
  if (!clean) return null;
  try { return decodeURIComponent(clean); } catch { return clean; }
}

const files = walk(ROOT);
const htmlFiles = files.filter((file) => path.extname(file).toLowerCase() === '.html');

test('static markup, aria references, assets, print rules, focus rules, and offline runtime stay intact', () => {
  assert.ok(htmlFiles.length > 0, 'expected at least one HTML file');

  for (const file of htmlFiles) {
    const rel = path.relative(ROOT, file);
    const html = fs.readFileSync(file, 'utf8');
    const structural = structuralHtml(html);
    const tags = [...structural.matchAll(/<([A-Za-z][\w:-]*)\b([^>]*)>/g)].map((m) => ({
      tag: m[1].toLowerCase(),
      attrs: parseAttrs(m[2] || '')
    }));

    const ids = [];
    for (const item of tags) if (item.attrs.get('id')) ids.push(item.attrs.get('id'));
    assert.equal(new Set(ids).size, ids.length, `${rel}: duplicate id attributes`);
    const idSet = new Set(ids);

    for (const item of tags) {
      for (const [name, value] of item.attrs) {
        if (!REF_ATTRS.has(name) || !value) continue;
        for (const target of value.split(/\s+/).filter(Boolean)) {
          assert.ok(idSet.has(target), `${rel}: <${item.tag}> ${name} references missing #${target}`);
        }
      }
    }

    for (const item of tags) {
      let url = null;
      if (item.tag === 'script') url = item.attrs.get('src');
      if (item.tag === 'img') url = item.attrs.get('src');
      if (item.tag === 'link') {
        const rels = new Set((item.attrs.get('rel') || '').toLowerCase().split(/\s+/).filter(Boolean));
        if ([...rels].some((relName) => ASSET_LINK_RELS.has(relName))) url = item.attrs.get('href');
      }
      const local = localPath(url);
      if (local) {
        assert.ok(fs.existsSync(path.resolve(path.dirname(file), local)), `${rel}: missing local asset ${url}`);
      }
    }
  }

  for (const file of files) {
    const rel = path.relative(ROOT, file);
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(!CDN_RE.test(text), `${rel}: runtime CDN dependency must stay offline`);
  }

  const cssText = files
    .filter((file) => path.extname(file).toLowerCase() === '.css')
    .map((file) => fs.readFileSync(file, 'utf8'))
    .join('\n') + '\n' + htmlFiles.map((file) => inlineStyles(fs.readFileSync(file, 'utf8'))).join('\n');
  assert.match(cssText, /@media\s+print\b/i, 'missing print stylesheet');
  assert.match(cssText, /:focus-visible\b/, 'missing keyboard focus-visible rule');
});
