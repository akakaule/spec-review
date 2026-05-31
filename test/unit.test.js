import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { slugify, offsetToLine, lineToOffset } from '../src/util.js';
import { createRenderer, renderMarkdown, extractTitle } from '../src/render.js';
import { findOccurrences, nearestHeading, createAnchor, reanchor } from '../src/anchor.js';
import {
  sidecarPathFor,
  isSidecarPath,
  specNameForSidecar,
  serializeStore,
  applyOperation,
  newCommentId,
  STORE_VERSION,
} from '../src/store.js';
import { globToRegExp, discover } from '../src/discovery.js';
import { authorizeWrite, authorizeRead, hostAllowed, mintToken } from '../src/security.js';

const NOW = '2026-05-29T10:00:00.000Z';

// --- util ---------------------------------------------------------------
test('slugify produces stable url-safe anchors', () => {
  assert.equal(slugify('FR-033: The Tool'), 'fr-033-the-tool');
  assert.equal(slugify('  Hello  World  '), 'hello-world');
  assert.equal(slugify('**bold** _x_'), 'bold-x');
});

test('offset/line conversions round-trip', () => {
  const src = 'a\nbb\nccc';
  assert.equal(offsetToLine(src, 0), 0);
  assert.equal(offsetToLine(src, 2), 1);
  assert.equal(offsetToLine(src, 5), 2);
  assert.equal(lineToOffset(src, 1), 2);
  assert.equal(lineToOffset(src, 2), 5);
});

// --- render -------------------------------------------------------------
test('render adds heading anchors and source lines, escapes raw HTML', () => {
  const md = createRenderer();
  const src = '# Title\n\nSome text\n\n<script>alert(1)</script>\n';
  const html = renderMarkdown(md, src);
  assert.match(html, /<h1 id="title"[^>]*>Title<\/h1>/);
  assert.match(html, /data-source-start="0"/);
  // SC-006: script must be escaped, never executable
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});

test('render blocks GFM tables and code with language classes', () => {
  const md = createRenderer();
  const html = renderMarkdown(md, '| a | b |\n|---|---|\n| 1 | 2 |\n\n```js\nx\n```\n');
  assert.match(html, /<table[ >]/);
  assert.match(html, /language-js/);
});

test('render gives fenced code blocks source-line attributes (self-contained tokens)', () => {
  const md = createRenderer();
  // Fence opens on line 2 (0-indexed): "para" \n\n ```js
  const html = renderMarkdown(md, 'para\n\n```js\ncode\n```\n');
  // The fence token is self-contained (nesting 0); it must still carry the map
  // so comments on code blocks map back to source (FR-012).
  assert.match(html, /data-source-start="2"[^>]*>[\s\S]*code/);
});

test('extractTitle returns first h1, ignoring fenced content', () => {
  assert.equal(extractTitle('```\n# not a title\n```\n\n# Real Title\n'), 'Real Title');
  assert.equal(extractTitle('no heading here'), null);
});

// --- anchor -------------------------------------------------------------
test('findOccurrences finds all positions', () => {
  assert.deepEqual(findOccurrences('abcabc', 'bc'), [1, 4]);
  assert.deepEqual(findOccurrences('abc', 'zzz'), []);
});

test('nearestHeading returns the preceding heading', () => {
  const src = '# A\n\ntext1\n\n## B\n\ntext2\n';
  const off = src.indexOf('text2');
  assert.equal(nearestHeading(src, off).text, 'B');
});

test('createAnchor captures quote, heading, prefix, suffix, offset', () => {
  const src = '# FR-033\n\nThe tool MUST dead-letter the message now.\n';
  const a = createAnchor(src, 'MUST dead-letter');
  assert.equal(a.quote, 'MUST dead-letter');
  assert.equal(a.heading, 'FR-033');
  assert.ok(a.prefix.endsWith('tool '));
  assert.ok(a.suffix.startsWith(' the'));
  assert.equal(typeof a.offsetHint, 'number');
});

test('reanchor: located after edits above the passage (User Story 4)', () => {
  const src = '# H\n\nThe quick brown fox.\n';
  const a = createAnchor(src, 'quick brown fox');
  const edited = 'Inserted paragraph above.\n\nMore text.\n\n' + src;
  const r = reanchor(edited, a);
  assert.equal(r.anchorState, 'anchored');
  assert.equal(edited.slice(r.offset, r.offset + a.quote.length), 'quick brown fox');
});

test('reanchor: orphaned when quote deleted, never attaches elsewhere', () => {
  const a = createAnchor('# H\n\nunique-passage-xyz here.\n', 'unique-passage-xyz');
  const r = reanchor('# H\n\ncompletely different content.\n', a);
  assert.equal(r.anchorState, 'orphaned');
  assert.equal(r.offset, null);
});

test('reanchor: prefix/suffix disambiguate duplicate quotes', () => {
  const src = 'alpha TARGET beta\n\ngamma TARGET delta\n';
  const a = createAnchor(src, 'TARGET', { offset: src.indexOf('gamma') });
  assert.ok(a.prefix.endsWith('gamma '));
  const r = reanchor(src, a);
  assert.equal(r.anchorState, 'anchored');
  assert.equal(src.slice(0, r.offset).endsWith('gamma '), true);
});

test('reanchor: ambiguous when identical context cannot disambiguate', () => {
  const src = 'x TARGET y x TARGET y';
  const a = { quote: 'TARGET', prefix: 'x ', suffix: ' y', offsetHint: undefined };
  const r = reanchor(src, a);
  assert.equal(r.anchorState, 'ambiguous');
});

// --- store --------------------------------------------------------------
test('sidecar path derives from markdown filename (FR-040)', () => {
  assert.equal(path.basename(sidecarPathFor('/x/spec.md')), 'spec.review.json');
  assert.equal(path.basename(sidecarPathFor('/x/architecture.md')), 'architecture.review.json');
  assert.ok(isSidecarPath('/x/spec.review.json'));
  assert.equal(specNameForSidecar('/x/architecture.review.json'), 'architecture.md');
});

test('serializeStore is stable and ends with newline', () => {
  const store = { version: 1, rev: 2, spec: 'spec.md', comments: [] };
  const out = serializeStore(store);
  assert.ok(out.endsWith('}\n'));
  assert.equal(serializeStore(store), out);
});

test('applyOperation: add-comment, add-reply, set-status, delete-comment', () => {
  const store = { version: STORE_VERSION, rev: 0, spec: 'spec.md', comments: [] };
  const c = applyOperation(store, { type: 'add-comment', body: 'hi', author: 'al', anchor: { quote: 'q' }, anchorState: 'anchored' }, NOW);
  assert.equal(store.comments.length, 1);
  assert.equal(c.status, 'open');
  assert.equal(c.resolution, null);

  applyOperation(store, { type: 'add-reply', id: c.id, body: 'reply', author: 'al' }, NOW);
  assert.equal(store.comments[0].thread.length, 1);

  applyOperation(store, { type: 'set-status', id: c.id, status: 'resolved', resolution: { by: 'agent', note: 'done' } }, NOW);
  assert.equal(store.comments[0].status, 'resolved');
  assert.equal(store.comments[0].resolution.note, 'done');

  const deleted = applyOperation(store, { type: 'delete-comment', id: c.id }, NOW);
  assert.equal(deleted.id, c.id);
  assert.equal(store.comments.length, 0);
});

test('newCommentId is unique and prefixed', () => {
  const a = newCommentId();
  const b = newCommentId();
  assert.match(a, /^c_[0-9a-f]+$/);
  assert.notEqual(a, b);
});

// --- discovery ----------------------------------------------------------
test('globToRegExp matches ** and * correctly', () => {
  const re = globToRegExp('**/spec.md');
  assert.ok(re.test('spec.md'));
  assert.ok(re.test('008-foo/spec.md'));
  assert.ok(re.test('a/b/c/spec.md'));
  assert.ok(!re.test('008-foo/other.md'));
  const re2 = globToRegExp('**/*.md');
  assert.ok(re2.test('a/b/readme.md'));
});

test('discover finds specs and orphan sidecars (FR-006/FR-061a)', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sr-disc-'));
  await fs.mkdir(path.join(dir, '008-foo'), { recursive: true });
  await fs.writeFile(path.join(dir, '008-foo', 'spec.md'), '# Foo Spec\n');
  await fs.writeFile(
    path.join(dir, '008-foo', 'spec.review.json'),
    JSON.stringify({
      version: 1,
      rev: 1,
      spec: 'spec.md',
      comments: [
        { id: 'c1', status: 'open' },
        { id: 'c2', status: 'resolved' },
      ],
    }),
  );
  // an orphan sidecar whose spec was renamed/deleted
  await fs.mkdir(path.join(dir, '009-bar'), { recursive: true });
  await fs.writeFile(path.join(dir, '009-bar', 'gone.review.json'), '{"version":1,"rev":0,"spec":"gone.md","comments":[]}');

  const d = await discover(dir, '**/spec.md');
  assert.equal(d.specs.length, 1);
  assert.equal(d.specs[0].title, 'Foo Spec');
  assert.equal(d.specs[0].hasSidecar, true);
  assert.equal(d.specs[0].commentCount, 2);
  assert.equal(d.specs[0].openCount, 1);
  assert.equal(d.orphanSidecars.length, 1);
  assert.equal(d.orphanSidecars[0].expectedSpec, 'gone.md');
  await fs.rm(dir, { recursive: true, force: true });
});

// --- security -----------------------------------------------------------
function fakeReq(headers) {
  return { headers };
}

test('hostAllowed only accepts localhost/127.0.0.1', () => {
  assert.ok(hostAllowed(fakeReq({ host: '127.0.0.1:5000' }), 5000));
  assert.ok(hostAllowed(fakeReq({ host: 'localhost:5000' }), 5000));
  assert.ok(!hostAllowed(fakeReq({ host: 'evil.example.com:5000' }), 5000));
});

test('authorizeWrite enforces token, host, origin, json (FR-007)', () => {
  const port = 5000;
  const token = mintToken();
  const good = fakeReq({
    host: `127.0.0.1:${port}`,
    origin: `http://127.0.0.1:${port}`,
    'content-type': 'application/json',
    'x-spec-review-token': token,
  });
  assert.equal(authorizeWrite(good, { token, port, readOnly: false }).ok, true);

  assert.equal(authorizeWrite({ headers: { ...good.headers, 'x-spec-review-token': 'bad' } }, { token, port }).status, 403);
  assert.equal(authorizeWrite({ headers: { ...good.headers, host: 'evil.com:5000' } }, { token, port }).status, 403);
  assert.equal(authorizeWrite({ headers: { ...good.headers, origin: 'http://evil.com' } }, { token, port }).status, 403);
  assert.equal(authorizeWrite({ headers: { ...good.headers, 'content-type': 'text/plain' } }, { token, port }).status, 400);
  assert.equal(authorizeWrite(good, { token, port, readOnly: true }).status, 403);
});

test('authorizeRead requires host + token', () => {
  const port = 5000;
  const token = mintToken();
  const ok = authorizeRead(fakeReq({ host: `localhost:${port}`, 'x-spec-review-token': token }), { token, port });
  assert.equal(ok.ok, true);
  assert.equal(authorizeRead(fakeReq({ host: `localhost:${port}` }), { token, port }).status, 403);
});
