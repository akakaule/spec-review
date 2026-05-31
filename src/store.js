import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const STORE_VERSION = 1;

/** Error thrown when an optimistic-concurrency check fails (FR-044). */
export class RevConflictError extends Error {
  constructor(currentRev) {
    super('rev conflict');
    this.name = 'RevConflictError';
    this.currentRev = currentRev;
  }
}

/** Error thrown when a write targets a comment id that does not exist. */
export class UnknownCommentError extends Error {
  constructor(id) {
    super(`unknown comment: ${id}`);
    this.name = 'UnknownCommentError';
    this.id = id;
  }
}

/**
 * Derive a spec's sidecar path: replace the markdown extension with
 * `.review.json` (FR-040). `spec.md` -> `spec.review.json`.
 * @param {string} mdPath
 * @returns {string}
 */
export function sidecarPathFor(mdPath) {
  const dir = path.dirname(mdPath);
  const base = path.basename(mdPath);
  const withoutExt = base.replace(/\.md$/i, '');
  return path.join(dir, `${withoutExt}.review.json`);
}

/** True if a path looks like a review sidecar (FR-061a). */
export function isSidecarPath(p) {
  return /\.review\.json$/i.test(p);
}

/** The markdown filename a sidecar is expected to pair with. */
export function specNameForSidecar(sidecarPath) {
  return path.basename(sidecarPath).replace(/\.review\.json$/i, '.md');
}

function emptyStore(specName) {
  return { version: STORE_VERSION, rev: 0, spec: specName, comments: [] };
}

/**
 * Read a sidecar from disk, returning an empty store when it does not exist.
 * A malformed file throws a descriptive error rather than corrupting state
 * (NFR-007); callers surface it without crashing the server.
 * @param {string} sidecarPath
 * @param {string} specName markdown filename to record when creating fresh
 * @returns {Promise<object>}
 */
export async function readStore(sidecarPath, specName) {
  let raw;
  try {
    raw = await fs.readFile(sidecarPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return emptyStore(specName);
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`malformed sidecar ${path.basename(sidecarPath)}: ${err.message}`);
  }
  return normalizeStore(parsed, specName);
}

function normalizeStore(store, specName) {
  if (!store || typeof store !== 'object') throw new Error('sidecar is not an object');
  return {
    version: typeof store.version === 'number' ? store.version : STORE_VERSION,
    rev: typeof store.rev === 'number' ? store.rev : 0,
    spec: typeof store.spec === 'string' ? store.spec : specName,
    comments: Array.isArray(store.comments) ? store.comments : [],
  };
}

/**
 * Serialize a store with stable key ordering and 2-space indent so diffs stay
 * clean and git-mergeable (FR-042/NFR-005).
 * @param {object} store
 * @returns {string}
 */
export function serializeStore(store) {
  const ordered = {
    version: store.version,
    rev: store.rev,
    spec: store.spec,
    comments: (store.comments ?? []).map(orderComment),
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

function orderComment(c) {
  return {
    id: c.id,
    anchor: c.anchor
      ? {
          heading: c.anchor.heading ?? null,
          quote: c.anchor.quote ?? '',
          prefix: c.anchor.prefix ?? '',
          suffix: c.anchor.suffix ?? '',
          offsetHint: c.anchor.offsetHint ?? null,
        }
      : null,
    body: c.body ?? '',
    author: c.author ?? 'unknown',
    status: c.status ?? 'open',
    anchorState: c.anchorState ?? 'anchored',
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    thread: Array.isArray(c.thread) ? c.thread : [],
    resolution: c.resolution ?? null,
  };
}

/**
 * Atomically persist a store: write to a temp file in the same directory then
 * rename over the target (FR-042). Prevents partially-written sidecars.
 * @param {string} sidecarPath
 * @param {object} store
 * @returns {Promise<void>}
 */
export async function writeStoreAtomic(sidecarPath, store) {
  const dir = path.dirname(sidecarPath);
  const tmp = path.join(dir, `.${path.basename(sidecarPath)}.${process.pid}.${randomSuffix()}.tmp`);
  const data = serializeStore(store);
  await fs.writeFile(tmp, data, 'utf8');
  try {
    await fs.rename(tmp, sidecarPath);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
}

function randomSuffix() {
  return crypto.randomBytes(4).toString('hex');
}

/** New immutable comment id (FR-021). */
export function newCommentId() {
  return `c_${crypto.randomBytes(4).toString('hex')}`;
}

/**
 * Apply a single discrete write operation onto a store, mutating `comments[]`
 * by immutable `id` (FR-044 merge-by-id). Returns the affected/created comment.
 * Does NOT bump rev or write — the server orchestrates read->apply->write.
 *
 * Supported ops:
 *  - { type:'add-comment', anchor, body, author, anchorState }
 *  - { type:'add-reply', id, body, author }
 *  - { type:'set-status', id, status, resolution }
 *  - { type:'delete-comment', id }
 *
 * @param {object} store
 * @param {object} op
 * @param {string} nowIso ISO timestamp (injected for determinism/testability)
 * @returns {object} the affected comment
 */
export function applyOperation(store, op, nowIso) {
  switch (op.type) {
    case 'add-comment': {
      const comment = {
        id: op.id || newCommentId(),
        anchor: op.anchor ?? null,
        body: String(op.body ?? ''),
        author: op.author || 'unknown',
        status: 'open',
        anchorState: op.anchorState ?? 'anchored',
        createdAt: nowIso,
        updatedAt: nowIso,
        thread: [],
        resolution: null,
      };
      store.comments.push(comment);
      return comment;
    }
    case 'add-reply': {
      const comment = mustFind(store, op.id);
      comment.thread.push({
        author: op.author || 'unknown',
        body: String(op.body ?? ''),
        createdAt: nowIso,
      });
      comment.updatedAt = nowIso;
      return comment;
    }
    case 'set-status': {
      const comment = mustFind(store, op.id);
      const status = op.status;
      if (!['open', 'resolved', 'wontfix'].includes(status)) {
        throw new Error(`invalid status: ${status}`);
      }
      comment.status = status;
      if (status === 'open') {
        comment.resolution = null;
      } else {
        comment.resolution = {
          by: op.resolution?.by || op.author || 'unknown',
          note: String(op.resolution?.note ?? ''),
          at: op.resolution?.at || nowIso,
        };
      }
      comment.updatedAt = nowIso;
      return comment;
    }
    case 'delete-comment': {
      const idx = store.comments.findIndex((x) => x.id === op.id);
      if (idx === -1) throw new UnknownCommentError(op.id);
      const [comment] = store.comments.splice(idx, 1);
      return comment;
    }
    default:
      throw new Error(`unknown operation: ${op.type}`);
  }
}

function mustFind(store, id) {
  const c = store.comments.find((x) => x.id === id);
  if (!c) throw new UnknownCommentError(id);
  return c;
}
