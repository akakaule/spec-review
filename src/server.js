import http from 'node:http';
import { promises as fs } from 'node:fs';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRenderer, renderMarkdown } from './render.js';
import { reanchor, createAnchor } from './anchor.js';
import {
  readStore,
  writeStoreAtomic,
  applyOperation,
  sidecarPathFor,
  newCommentId,
  RevConflictError,
  UnknownCommentError,
} from './store.js';
import { discover } from './discovery.js';
import { authorizeRead, authorizeWrite, hostAllowed } from './security.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

/**
 * Create (but do not start) the review server.
 * @param {{ targetDir:string, glob:string, token:string, readOnly:boolean, author:string, nowFn?:()=>string }} opts
 */
export function createServer(opts) {
  const { targetDir, glob, token, readOnly, author } = opts;
  const nowFn = opts.nowFn || (() => new Date().toISOString());
  const md = createRenderer();
  const locks = new Map(); // per-sidecar promise chain
  const sseClients = new Set();

  // --- short-lived discovery cache --------------------------------------
  let cache = null;
  let cacheAt = 0;
  async function getDiscovery(force = false) {
    const now = Date.now();
    if (!force && cache && now - cacheAt < 1500) return cache;
    cache = await discover(targetDir, glob);
    cacheAt = now;
    return cache;
  }
  function invalidate() {
    cache = null;
  }

  // --- per-sidecar serialization (in-process lost-update guard) ---------
  function withLock(key, fn) {
    const prev = locks.get(key) || Promise.resolve();
    const next = prev.then(fn, fn);
    locks.set(
      key,
      next.then(
        () => {
          if (locks.get(key) === next) locks.delete(key);
        },
        () => {
          if (locks.get(key) === next) locks.delete(key);
        },
      ),
    );
    return next;
  }

  function anchorsFor(source, store) {
    const map = {};
    let changed = false;
    for (const c of store.comments) {
      const r = reanchor(source, c.anchor || {});
      map[c.id] = r;
      if (c.anchorState !== r.anchorState) {
        c.anchorState = r.anchorState; // tool-maintained (FR-034)
        changed = true;
      }
    }
    return { map, changed };
  }

  async function findSpec(relPath) {
    const { specs } = await getDiscovery();
    return specs.find((s) => s.path === relPath) || null;
  }

  // --- request handlers -------------------------------------------------
  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      sendJson(res, 500, { error: String(err && err.message ? err.message : err) });
    });
  });

  async function handle(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const pathname = url.pathname;

    // Host validation guards every endpoint against DNS-rebinding (FR-008).
    if (!hostAllowed(req, opts.port)) {
      return sendJson(res, 403, { error: 'forbidden host' });
    }

    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      return serveStatic(res, 'index.html');
    }
    if (req.method === 'GET' && (pathname === '/app.js' || pathname === '/styles.css')) {
      return serveStatic(res, pathname.slice(1));
    }

    if (pathname === '/api/events' && req.method === 'GET') {
      // EventSource cannot set headers; accept token via query (Host already checked).
      if (url.searchParams.get('token') !== token) return sendJson(res, 403, { error: 'bad token' });
      return startSse(req, res);
    }

    if (pathname.startsWith('/api/')) {
      if (req.method === 'GET') {
        const auth = authorizeRead(req, { token, port: opts.port });
        if (!auth.ok) return sendJson(res, auth.status, { error: auth.reason });
        return handleGet(pathname, url, res);
      }
      if (req.method === 'POST') {
        const auth = authorizeWrite(req, { token, port: opts.port, readOnly });
        if (!auth.ok) return sendJson(res, auth.status, { error: auth.reason });
        return handlePost(pathname, url, req, res);
      }
      return sendJson(res, 405, { error: 'method not allowed' });
    }

    return sendJson(res, 404, { error: 'not found' });
  }

  async function handleGet(pathname, url, res) {
    if (pathname === '/api/meta') {
      return sendJson(res, 200, {
        target: targetDir,
        glob,
        readOnly,
        author,
        version: 1,
      });
    }
    if (pathname === '/api/specs') {
      const d = await getDiscovery(true);
      return sendJson(res, 200, {
        specs: d.specs.map((s) => ({
          path: s.path,
          title: s.title,
          hasSidecar: s.hasSidecar,
          commentCount: s.commentCount,
          openCount: s.openCount,
        })),
        orphanSidecars: d.orphanSidecars,
      });
    }
    if (pathname === '/api/spec') {
      const rel = url.searchParams.get('path');
      const spec = rel && (await findSpec(rel));
      if (!spec) return sendJson(res, 404, { error: 'spec not found' });
      const result = await loadSpec(spec);
      return sendJson(res, 200, result);
    }
    if (pathname === '/api/sidecar') {
      const rel = url.searchParams.get('path');
      const spec = rel && (await findSpec(rel));
      if (!spec) return sendJson(res, 404, { error: 'spec not found' });
      const store = await readStore(spec.sidecarPath, path.basename(spec.absPath));
      return sendJson(res, 200, store);
    }
    return sendJson(res, 404, { error: 'not found' });
  }

  async function loadSpec(spec) {
    const source = await fs.readFile(spec.absPath, 'utf8');
    const html = renderMarkdown(md, source);
    return withLock(spec.sidecarPath, async () => {
      const store = await readStore(spec.sidecarPath, path.basename(spec.absPath));
      const { map, changed } = anchorsFor(source, store);
      if (changed && !readOnly) {
        store.rev += 1;
        await writeStoreAtomic(spec.sidecarPath, store);
        invalidate();
      }
      return { path: spec.path, title: spec.title, markdown: source, html, store, anchors: map };
    });
  }

  async function handlePost(pathname, url, req, res) {
    if (pathname !== '/api/review') return sendJson(res, 404, { error: 'not found' });
    const rel = url.searchParams.get('path');
    const spec = rel && (await findSpec(rel));
    if (!spec) return sendJson(res, 404, { error: 'spec not found' });

    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      return sendJson(res, 400, { error: `invalid JSON body: ${err.message}` });
    }
    const op = body.op;
    if (!op || typeof op.type !== 'string') return sendJson(res, 400, { error: 'missing op' });

    try {
      const result = await withLock(spec.sidecarPath, async () => {
        const source = await fs.readFile(spec.absPath, 'utf8');
        const store = await readStore(spec.sidecarPath, path.basename(spec.absPath));

        // Optimistic concurrency (FR-044): reject stale writes.
        if (typeof body.rev === 'number' && body.rev !== store.rev) {
          throw new RevConflictError(store.rev);
        }

        // Server computes the anchor for new comments from the reported selection.
        const enriched = { ...op, author: op.author || author };
        if (op.type === 'add-comment') {
          const anchor = createAnchor(source, op.quote ?? op.anchor?.quote ?? '', {
            line: typeof op.blockStart === 'number' ? op.blockStart : undefined,
            offset: typeof op.offsetHint === 'number' ? op.offsetHint : undefined,
          });
          if (!anchor) throw new Error('selection text not found in spec source');
          enriched.anchor = anchor;
          enriched.id = newCommentId();
          const r0 = reanchor(source, anchor);
          enriched.anchorState = r0.anchorState;
        }

        const affected = applyOperation(store, enriched, nowFn());
        const { map } = anchorsFor(source, store);
        if (op.type === 'delete-comment' && store.comments.length === 0) {
          await fs.rm(spec.sidecarPath, { force: true });
          store.rev = 0;
        } else {
          store.rev += 1;
          await writeStoreAtomic(spec.sidecarPath, store);
        }
        invalidate();
        return { store, anchors: map, comment: affected };
      });
      broadcast({ type: 'change', path: spec.path });
      return sendJson(res, 200, result);
    } catch (err) {
      if (err instanceof RevConflictError) {
        const store = await readStore(spec.sidecarPath, path.basename(spec.absPath));
        return sendJson(res, 409, { error: 'rev conflict', currentRev: err.currentRev, store });
      }
      if (err instanceof UnknownCommentError) {
        return sendJson(res, 404, { error: err.message });
      }
      return sendJson(res, 400, { error: String(err.message || err) });
    }
  }

  // --- SSE live reload ---------------------------------------------------
  function startSse(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
  }
  function broadcast(payload) {
    const line = `data: ${JSON.stringify(payload)}\n\n`;
    for (const client of sseClients) {
      try {
        client.write(line);
      } catch {
        sseClients.delete(client);
      }
    }
  }

  // --- file watching (FR-013) -------------------------------------------
  let watchers = [];
  let debounceTimer = null;
  async function setupWatch() {
    closeWatchers();
    const { specs } = await getDiscovery(true);
    const dirs = new Set(specs.map((s) => path.dirname(s.absPath)));
    for (const dir of dirs) {
      try {
        const w = fsSync.watch(dir, { persistent: false }, (_evt, filename) => onFsEvent(dir, filename));
        watchers.push(w);
      } catch {
        // ignore unwatchable directories
      }
    }
  }
  function onFsEvent(dir, filename) {
    invalidate();
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const rel = filename
        ? path.relative(targetDir, path.join(dir, filename.toString())).split(path.sep).join('/')
        : null;
      broadcast({ type: 'change', path: rel });
      setupWatch().catch(() => {}); // pick up newly added spec dirs
    }, 150);
  }
  function closeWatchers() {
    for (const w of watchers) {
      try {
        w.close();
      } catch {
        /* ignore */
      }
    }
    watchers = [];
  }

  // --- static + helpers --------------------------------------------------
  async function serveStatic(res, name) {
    const file = path.join(PUBLIC_DIR, name);
    if (!file.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { error: 'forbidden' });
    try {
      const data = await fs.readFile(file);
      const type = STATIC_TYPES[path.extname(file)] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type });
      res.end(data);
    } catch {
      sendJson(res, 404, { error: 'not found' });
    }
  }

  return {
    httpServer: server,
    async start(port) {
      opts.port = port;
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', resolve);
      });
      const actualPort = server.address().port;
      opts.port = actualPort;
      await setupWatch();
      return actualPort;
    },
    async close() {
      closeWatchers();
      for (const c of sseClients) {
        try {
          c.end();
        } catch {
          /* ignore */
        }
      }
      sseClients.clear();
      await new Promise((resolve) => server.close(resolve));
    },
    // exposed for tests
    _internals: { getDiscovery, anchorsFor },
  };
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readJsonBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}
