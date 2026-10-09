// Minimal TypeSafe System One client: retries, a concurrency cap and a request-hash cache.
// Uses the global fetch so the skill needs no npm dependency (spec 021 NFR-001).

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';

export const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const RETRYABLE = (status) => status === 429 || status === 529 || status >= 500;

/** SHA-256 cache key of a request (FR-063). */
export function requestKey(model, state, questions) {
  return createHash('sha256').update(JSON.stringify({ model, state, questions })).digest('hex');
}

function createLimiter(limit) {
  let active = 0;
  const waiting = [];
  return async (task) => {
    if (active >= limit) await new Promise((resolve) => waiting.push(resolve));
    active++;
    try {
      return await task();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}

/**
 * Create a client (FR-060..FR-063). Options: `apiKey` (defaults to TYPESAFE_API_KEY), `model`,
 * `cacheDir` (null disables caching), `offline` (cache only), `concurrency`, `maxAttempts`, and
 * `fetchImpl`/`sleep` seams for tests. `ask(state, questions)` resolves to the response body plus
 * `cached`; `stats` counts requests, cache hits and input tokens.
 */
export function createClient({
  apiKey = process.env.TYPESAFE_API_KEY,
  model,
  cacheDir = null,
  offline = false,
  concurrency = 8,
  maxAttempts = 5,
  fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const limit = createLimiter(concurrency);
  const stats = { requests: 0, cacheHits: 0, inputTokens: 0, models: new Set() };
  if (cacheDir && !offline) {
    mkdirSync(cacheDir, { recursive: true });
    const ignore = join(cacheDir, '.gitignore');
    if (!existsSync(ignore)) writeFileSync(ignore, '*\n');
  }

  async function post(body) {
    if (!apiKey) throw new Error('TYPESAFE_API_KEY is not set (create a key at https://console.typesafe.ai/keys)');
    for (let attempt = 1; ; attempt++) {
      let response;
      try {
        response = await fetchImpl(ENDPOINT, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      } catch (error) {
        if (attempt >= maxAttempts) throw new Error(`TypeSafe request failed: ${error.message}`);
        await sleep(backoff(attempt));
        continue;
      }
      if (response.ok) return response.json();
      const text = await response.text();
      if (!RETRYABLE(response.status) || attempt >= maxAttempts) {
        throw new Error(`TypeSafe ${response.status}: ${text.slice(0, 500)}`);
      }
      const retryAfter = Number(response.headers?.get?.('retry-after'));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 60) * 1000 : backoff(attempt));
    }
  }

  async function ask(state, questions) {
    const key = requestKey(model, state, questions);
    const file = cacheDir ? join(cacheDir, `${key}.json`) : null;
    if (file && existsSync(file)) {
      stats.cacheHits++;
      const cached = JSON.parse(readFileSync(file, 'utf8'));
      stats.models.add(cached.model);
      return { ...cached, cached: true };
    }
    if (offline) throw new Error(`cache miss in --offline mode (request ${key.slice(0, 12)})`);
    const body = await limit(() => post({ model, state, questions }));
    stats.requests++;
    stats.inputTokens += body.usage?.input_tokens ?? 0;
    stats.models.add(body.model);
    if (file) {
      const temp = `${file}.${process.pid}.tmp`;
      writeFileSync(temp, `${JSON.stringify(body, null, 2)}\n`);
      renameSync(temp, file);
    }
    return { ...body, cached: false };
  }

  return { ask, stats, model };
}

function backoff(attempt) {
  return Math.min(500 * 2 ** (attempt - 1), 20_000) + Math.floor(Math.random() * 250);
}
