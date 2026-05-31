import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

import { createServer } from '../src/server.js';

// Raw HTTP request — unlike fetch (undici), this lets us forge the otherwise
// "forbidden" Host/Origin headers needed to exercise the security checks.
function rawPost(p, headers, bodyStr) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: p, method: 'POST', headers },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      },
    );
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

let dir, specPath, sidecarPath, srv, port, token;
const AUTHOR = 'tester';

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sr-srv-'));
  await fs.mkdir(path.join(dir, '001-demo'), { recursive: true });
  specPath = path.join(dir, '001-demo', 'spec.md');
  sidecarPath = path.join(dir, '001-demo', 'spec.review.json');
  await fs.writeFile(
    specPath,
    '# Demo Spec\n\n## FR-001\n\nThe tool MUST dead-letter the message safely.\n\n<script>alert(1)</script>\n',
  );
  token = 'test-token-1234567890';
  srv = createServer({ targetDir: dir, glob: '**/spec.md', token, readOnly: false, author: AUTHOR, port: 0 });
  port = await srv.start(0);
});

after(async () => {
  await srv.close();
  await fs.rm(dir, { recursive: true, force: true });
});

function url(p) {
  return `http://127.0.0.1:${port}${p}`;
}
const goodHeaders = () => ({
  Host: `127.0.0.1:${port}`,
  Origin: `http://127.0.0.1:${port}`,
  'Content-Type': 'application/json',
  'X-Spec-Review-Token': token,
});

async function getJson(p, headers = { Host: `127.0.0.1:${port}`, 'X-Spec-Review-Token': token }) {
  const res = await fetch(url(p), { headers });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

test('SC-007: server reachable only on 127.0.0.1', async () => {
  const addr = srv.httpServer.address();
  assert.equal(addr.address, '127.0.0.1');
});

test('lists specs with title (FR-006)', async () => {
  const { status, body } = await getJson('/api/specs');
  assert.equal(status, 200);
  assert.equal(body.specs.length, 1);
  assert.equal(body.specs[0].title, 'Demo Spec');
  assert.equal(body.specs[0].path, '001-demo/spec.md');
  assert.equal(body.specs[0].openCount, 0);
  assert.equal(body.specs[0].commentCount, 0);
});

test('SC-006: served HTML escapes embedded script', async () => {
  const { body } = await getJson('/api/spec?path=001-demo/spec.md');
  assert.doesNotMatch(body.html, /<script>alert/);
  assert.match(body.html, /&lt;script&gt;/);
  assert.match(body.html, /<h2 id="fr-001"/);
});

test('SC-008: write rejected without token / bad origin / bad host / non-JSON; accepted when correct', async () => {
  const bodyStr = JSON.stringify({ rev: 0, op: { type: 'add-comment', quote: 'MUST dead-letter', body: 'ambiguous?', author: AUTHOR } });
  const P = '/api/review?path=001-demo/spec.md';
  const base = () => ({ Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, 'Content-Type': 'application/json', 'X-Spec-Review-Token': token });

  // missing token
  const noTok = base();
  delete noTok['X-Spec-Review-Token'];
  assert.equal((await rawPost(P, noTok, bodyStr)).status, 403);
  // foreign origin
  assert.equal((await rawPost(P, { ...base(), Origin: 'http://evil.com' }, bodyStr)).status, 403);
  // rebinding host
  assert.equal((await rawPost(P, { ...base(), Host: 'evil.com' }, bodyStr)).status, 403);
  // non-JSON content type
  assert.equal((await rawPost(P, { ...base(), 'Content-Type': 'text/plain' }, bodyStr)).status, 400);

  // correct, same-origin, tokened JSON write succeeds
  const ok = await rawPost(P, base(), bodyStr);
  assert.equal(ok.status, 200);
  const okBody = JSON.parse(ok.body);
  assert.equal(okBody.store.comments.length, 1);
  assert.equal(okBody.store.rev, 1);
  assert.equal(okBody.comment.anchor.heading, 'FR-001');
  assert.equal(okBody.anchors[okBody.comment.id].anchorState, 'anchored');

  const afterList = await getJson('/api/specs');
  assert.equal(afterList.body.specs[0].openCount, 1);
  assert.equal(afterList.body.specs[0].commentCount, 1);
});

test('SC-002 + SC-005: comment round-trips and spec stays byte-identical', async () => {
  const before = await fs.readFile(specPath, 'utf8');
  // a fresh comment from the previous test already persisted; verify it re-anchors
  const sidecar = JSON.parse(await fs.readFile(sidecarPath, 'utf8'));
  assert.equal(sidecar.comments.length, 1);
  const { body } = await getJson('/api/spec?path=001-demo/spec.md');
  const c = body.store.comments[0];
  assert.equal(body.anchors[c.id].anchorState, 'anchored');
  const after = await fs.readFile(specPath, 'utf8');
  assert.equal(after, before, 'spec.md must be byte-identical (NFR-004)');
});

test('SC-009: stale rev write is rejected 409, succeeds after refetch (FR-044)', async () => {
  const cur = await getJson('/api/spec?path=001-demo/spec.md');
  const staleRev = cur.body.store.rev;

  // First writer succeeds, advancing rev.
  const w1 = await fetch(url('/api/review?path=001-demo/spec.md'), {
    method: 'POST',
    headers: goodHeaders(),
    body: JSON.stringify({ rev: staleRev, op: { type: 'add-comment', quote: 'message safely', body: 'first', author: 'a' } }),
  });
  assert.equal(w1.status, 200);

  // Second writer uses the now-stale rev → 409.
  const w2 = await fetch(url('/api/review?path=001-demo/spec.md'), {
    method: 'POST',
    headers: goodHeaders(),
    body: JSON.stringify({ rev: staleRev, op: { type: 'add-comment', quote: 'dead-letter', body: 'second', author: 'b' } }),
  });
  assert.equal(w2.status, 409);
  const conflict = await w2.json();
  assert.ok(conflict.store.rev > staleRev);

  // Retry with the current rev → success; neither write lost.
  const w3 = await fetch(url('/api/review?path=001-demo/spec.md'), {
    method: 'POST',
    headers: goodHeaders(),
    body: JSON.stringify({ rev: conflict.store.rev, op: { type: 'add-comment', quote: 'dead-letter', body: 'second', author: 'b' } }),
  });
  assert.equal(w3.status, 200);
  const final = await w3.json();
  const bodies = final.store.comments.map((c) => c.body);
  assert.ok(bodies.includes('first') && bodies.includes('second'));
});

test('FR-040/FR-050: agent resolution sets status + resolution; tool reflects it', async () => {
  const cur = await getJson('/api/spec?path=001-demo/spec.md');
  const target = cur.body.store.comments[0];
  const res = await fetch(url('/api/review?path=001-demo/spec.md'), {
    method: 'POST',
    headers: goodHeaders(),
    body: JSON.stringify({
      rev: cur.body.store.rev,
      op: { type: 'set-status', id: target.id, status: 'resolved', resolution: { by: 'agent', note: 'clarified wording' } },
    }),
  });
  assert.equal(res.status, 200);
  const updated = await res.json();
  const resolved = updated.store.comments.find((c) => c.id === target.id);
  assert.equal(resolved.status, 'resolved');
  assert.equal(resolved.resolution.by, 'agent');
  assert.equal(resolved.resolution.note, 'clarified wording');
});

test('delete-comment removes a comment from the sidecar without touching spec.md', async () => {
  const deleteDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sr-delete-'));
  const deleteSpec = path.join(deleteDir, 'spec.md');
  const deleteSidecar = path.join(deleteDir, 'spec.review.json');
  await fs.writeFile(deleteSpec, '# Delete\n\nOnly comment target.\n');
  const deleteServer = createServer({ targetDir: deleteDir, glob: '**/spec.md', token, readOnly: false, author: AUTHOR, port: 0 });
  const deletePort = await deleteServer.start(0);
  const deleteHeaders = {
    Host: `127.0.0.1:${deletePort}`,
    Origin: `http://127.0.0.1:${deletePort}`,
    'Content-Type': 'application/json',
    'X-Spec-Review-Token': token,
  };

  try {
    const before = await fs.readFile(deleteSpec, 'utf8');
    const add = await fetch(`http://127.0.0.1:${deletePort}/api/review?path=spec.md`, {
      method: 'POST',
      headers: deleteHeaders,
      body: JSON.stringify({
        rev: 0,
        op: { type: 'add-comment', quote: 'Only comment target', body: 'remove me', author: AUTHOR },
      }),
    });
    assert.equal(add.status, 200);
    assert.ok(await fs.stat(deleteSidecar));

    const cur = await fetch(`http://127.0.0.1:${deletePort}/api/spec?path=spec.md`, {
      headers: { Host: `127.0.0.1:${deletePort}`, 'X-Spec-Review-Token': token },
    });
    const curBody = await cur.json();
    const target = curBody.store.comments[0];

    const res = await fetch(`http://127.0.0.1:${deletePort}/api/review?path=spec.md`, {
      method: 'POST',
      headers: deleteHeaders,
      body: JSON.stringify({
        rev: curBody.store.rev,
        op: { type: 'delete-comment', id: target.id },
      }),
    });
    assert.equal(res.status, 200);
    const updated = await res.json();
    assert.equal(updated.store.comments.length, 0);

    await assert.rejects(() => fs.stat(deleteSidecar), /ENOENT/);
    const after = await fs.readFile(deleteSpec, 'utf8');
    assert.equal(after, before, 'deleting the last review comment must not mutate spec.md');
  } finally {
    await deleteServer.close();
    await fs.rm(deleteDir, { recursive: true, force: true });
  }
});

test('User Story 4: edit above an anchored comment keeps it anchored; deleting the quote orphans it', async () => {
  const original = await fs.readFile(specPath, 'utf8');
  try {
    // Insert text above → still anchored.
    await fs.writeFile(specPath, 'Brand new intro paragraph.\n\n' + original);
    await new Promise((r) => setTimeout(r, 50));
    const a = await getJson('/api/spec?path=001-demo/spec.md');
    const anchoredStates = Object.values(a.body.anchors).map((x) => x.anchorState);
    assert.ok(anchoredStates.includes('anchored'));

    // Remove a quoted passage → that comment orphans.
    await fs.writeFile(specPath, original.replace('The tool MUST dead-letter the message safely.', 'Replaced entirely.'));
    await new Promise((r) => setTimeout(r, 50));
    const b = await getJson('/api/spec?path=001-demo/spec.md');
    const states = Object.values(b.body.anchors).map((x) => x.anchorState);
    assert.ok(states.includes('orphaned'), `expected an orphaned anchor, got ${states.join(',')}`);
  } finally {
    await fs.writeFile(specPath, original);
  }
});

test('SC-010: two markdown files in one dir produce distinct sidecars; orphan sidecar surfaced', async () => {
  // second reviewed markdown under a broad glob
  const srv2dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sr-multi-'));
  await fs.writeFile(path.join(srv2dir, 'spec.md'), '# One\n\nAlpha passage.\n');
  await fs.writeFile(path.join(srv2dir, 'architecture.md'), '# Two\n\nBeta passage.\n');
  const s2 = createServer({ targetDir: srv2dir, glob: '**/*.md', token, readOnly: false, author: AUTHOR, port: 0 });
  const p2 = await s2.start(0);
  try {
    const post = (rel, quote) =>
      fetch(`http://127.0.0.1:${p2}/api/review?path=${encodeURIComponent(rel)}`, {
        method: 'POST',
        headers: { Host: `127.0.0.1:${p2}`, Origin: `http://127.0.0.1:${p2}`, 'Content-Type': 'application/json', 'X-Spec-Review-Token': token },
        body: JSON.stringify({ rev: 0, op: { type: 'add-comment', quote, body: 'x', author: AUTHOR } }),
      });
    assert.equal((await post('spec.md', 'Alpha passage')).status, 200);
    assert.equal((await post('architecture.md', 'Beta passage')).status, 200);
    assert.ok(await fs.stat(path.join(srv2dir, 'spec.review.json')));
    assert.ok(await fs.stat(path.join(srv2dir, 'architecture.review.json')));

    // rename a spec away → its sidecar becomes orphaned in discovery
    await fs.rename(path.join(srv2dir, 'architecture.md'), path.join(srv2dir, 'renamed.md'));
    const d = await s2._internals.getDiscovery(true);
    assert.ok(d.orphanSidecars.some((o) => o.expectedSpec === 'architecture.md'));
  } finally {
    await s2.close();
    await fs.rm(srv2dir, { recursive: true, force: true });
  }
});

test('read-only server refuses writes (FR-003)', async () => {
  const roDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sr-ro-'));
  await fs.writeFile(path.join(roDir, 'spec.md'), '# RO\n\nText here.\n');
  const ro = createServer({ targetDir: roDir, glob: '**/spec.md', token, readOnly: true, author: AUTHOR, port: 0 });
  const rp = await ro.start(0);
  try {
    const res = await fetch(`http://127.0.0.1:${rp}/api/review?path=spec.md`, {
      method: 'POST',
      headers: { Host: `127.0.0.1:${rp}`, Origin: `http://127.0.0.1:${rp}`, 'Content-Type': 'application/json', 'X-Spec-Review-Token': token },
      body: JSON.stringify({ rev: 0, op: { type: 'add-comment', quote: 'Text here', body: 'x', author: AUTHOR } }),
    });
    assert.equal(res.status, 403);
  } finally {
    await ro.close();
    await fs.rm(roDir, { recursive: true, force: true });
  }
});
