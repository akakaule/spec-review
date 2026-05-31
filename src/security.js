import crypto from 'node:crypto';

/** Mint a high-entropy per-run token, embedded in the served URL (FR-007). */
export function mintToken() {
  return crypto.randomBytes(24).toString('hex');
}

const TOKEN_HEADER = 'x-spec-review-token';

function constantTimeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/** Extract the per-run token from a request (header or Bearer). */
export function tokenFromRequest(req) {
  const direct = req.headers[TOKEN_HEADER];
  if (direct) return Array.isArray(direct) ? direct[0] : direct;
  const auth = req.headers['authorization'];
  if (auth && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  return null;
}

/**
 * The Host header MUST be 127.0.0.1:<port> or localhost:<port>; any other host
 * (e.g. a DNS-rebinding hostname) is rejected (FR-007/FR-008).
 */
export function hostAllowed(req, port) {
  const host = req.headers['host'];
  if (!host) return false;
  const allowed = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
  return allowed.includes(host.toLowerCase());
}

/** Origin/Referer (when present) must match our own served origin (FR-007). */
function originAllowed(req, port) {
  const origin = req.headers['origin'];
  const referer = req.headers['referer'];
  const allowedOrigins = [
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    `http://[::1]:${port}`,
  ];
  if (origin) return allowedOrigins.includes(origin.toLowerCase());
  if (referer) return allowedOrigins.some((o) => referer.toLowerCase().startsWith(`${o}/`) || referer.toLowerCase() === o);
  // No Origin/Referer on a state-changing request from a browser is itself
  // suspect; the token + Host + JSON checks still guard the write.
  return true;
}

function isJsonContentType(req) {
  const ct = req.headers['content-type'] || '';
  return /^application\/json\b/i.test(ct);
}

/**
 * Authorize a state-changing (write) request. ALL of token, Origin, Host, and
 * JSON content-type must hold (FR-007). Returns {ok} or {ok:false,status,reason}.
 */
export function authorizeWrite(req, { token, port, readOnly }) {
  if (readOnly) return { ok: false, status: 403, reason: 'read-only mode' };
  if (!hostAllowed(req, port)) return { ok: false, status: 403, reason: 'bad host' };
  if (!isJsonContentType(req)) return { ok: false, status: 400, reason: 'content-type must be application/json' };
  if (!originAllowed(req, port)) return { ok: false, status: 403, reason: 'bad origin' };
  const supplied = tokenFromRequest(req);
  if (!supplied || !constantTimeEqual(supplied, token)) {
    return { ok: false, status: 403, reason: 'bad or missing token' };
  }
  return { ok: true };
}

/**
 * Authorize a read request: Host MUST validate (anti-rebinding, FR-008) and the
 * token is required too (we serve it in the URL, so the UI always has it).
 */
export function authorizeRead(req, { token, port }) {
  if (!hostAllowed(req, port)) return { ok: false, status: 403, reason: 'bad host' };
  const supplied = tokenFromRequest(req);
  if (!supplied || !constantTimeEqual(supplied, token)) {
    return { ok: false, status: 403, reason: 'bad or missing token' };
  }
  return { ok: true };
}
