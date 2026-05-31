import { slugify, offsetToLine } from './util.js';

const CONTEXT = 32; // bounded prefix/suffix length (FR-030)

/**
 * Find every character offset at which `quote` occurs in `source`.
 * @param {string} source
 * @param {string} quote
 * @returns {number[]}
 */
export function findOccurrences(source, quote) {
  const offsets = [];
  if (!quote) return offsets;
  let from = 0;
  for (;;) {
    const idx = source.indexOf(quote, from);
    if (idx === -1) break;
    offsets.push(idx);
    from = idx + 1; // allow overlapping matches
  }
  return offsets;
}

/**
 * Text and slug of the nearest heading at or before `offset`.
 * @param {string} source
 * @param {number} offset
 * @returns {{ text: string, slug: string } | null}
 */
export function nearestHeading(source, offset) {
  const headingRe = /^(#{1,6})\s+(.+?)\s*#*\s*$/gm;
  let best = null;
  let m;
  while ((m = headingRe.exec(source)) !== null) {
    if (m.index > offset) break;
    best = { text: m[2].trim(), slug: slugify(m[2]) };
  }
  return best;
}

/**
 * Build an anchor for a freshly selected passage (FR-030). The selection is
 * located in source, preferring an occurrence near the source line the UI
 * reported for the containing block (`hint.line`), then near `hint.offset`.
 * @param {string} source
 * @param {string} quote exact selected source text
 * @param {{ line?: number, offset?: number }} [hint]
 * @returns {{ heading: string|null, quote: string, prefix: string, suffix: string, offsetHint: number } | null}
 */
export function createAnchor(source, quote, hint = {}) {
  const occurrences = findOccurrences(source, quote);
  if (occurrences.length === 0) return null;

  let chosen = occurrences[0];
  if (occurrences.length > 1) {
    if (typeof hint.offset === 'number') {
      chosen = nearestTo(occurrences, hint.offset);
    } else if (typeof hint.line === 'number') {
      // Pick the occurrence whose source line is closest to the hinted block line.
      chosen = occurrences
        .map((off) => ({ off, dl: Math.abs(offsetToLine(source, off) - hint.line) }))
        .sort((a, b) => a.dl - b.dl)[0].off;
    }
  }

  const heading = nearestHeading(source, chosen);
  return {
    heading: heading ? heading.text : null,
    quote,
    prefix: source.slice(Math.max(0, chosen - CONTEXT), chosen),
    suffix: source.slice(chosen + quote.length, chosen + quote.length + CONTEXT),
    offsetHint: chosen,
  };
}

/**
 * Re-locate an existing anchor in the (possibly edited) current source and
 * report anchoring health (FR-034): `anchored` | `orphaned` | `ambiguous`.
 *
 * Disambiguation order for multiple matches:
 *   1. prefix/suffix context match (strongest), then
 *   2. nearest to offsetHint (advisory).
 * If neither yields a single winner, the comment is `ambiguous` and MUST NOT
 * be attached to any passage (User Story 4).
 *
 * @param {string} source
 * @param {{ quote: string, prefix?: string, suffix?: string, offsetHint?: number }} anchor
 * @returns {{ anchorState: 'anchored'|'orphaned'|'ambiguous', offset: number|null, line: number|null }}
 */
export function reanchor(source, anchor) {
  const quote = anchor?.quote ?? '';
  const occurrences = findOccurrences(source, quote);

  if (occurrences.length === 0) {
    return { anchorState: 'orphaned', offset: null, line: null };
  }
  if (occurrences.length === 1) {
    return located(source, occurrences[0]);
  }

  // Multiple matches — try prefix/suffix context.
  const ctxMatches = occurrences.filter((off) => contextMatches(source, off, quote, anchor));
  if (ctxMatches.length === 1) {
    return located(source, ctxMatches[0]);
  }

  // Still ambiguous after context — try offsetHint as a tie-breaker, but only
  // accept it when one candidate is unambiguously closest.
  const pool = ctxMatches.length > 1 ? ctxMatches : occurrences;
  if (typeof anchor.offsetHint === 'number') {
    const ranked = pool
      .map((off) => ({ off, d: Math.abs(off - anchor.offsetHint) }))
      .sort((a, b) => a.d - b.d);
    if (ranked.length === 1 || ranked[0].d !== ranked[1].d) {
      return located(source, ranked[0].off);
    }
  }

  return { anchorState: 'ambiguous', offset: null, line: null };
}

function located(source, offset) {
  return { anchorState: 'anchored', offset, line: offsetToLine(source, offset) };
}

function contextMatches(source, offset, quote, anchor) {
  const prefix = anchor.prefix ?? '';
  const suffix = anchor.suffix ?? '';
  const actualPrefix = source.slice(Math.max(0, offset - prefix.length), offset);
  const actualSuffix = source.slice(offset + quote.length, offset + quote.length + suffix.length);
  const prefixOk = !prefix || actualPrefix.endsWith(prefix);
  const suffixOk = !suffix || actualSuffix.startsWith(suffix);
  return prefixOk && suffixOk;
}

function nearestTo(offsets, target) {
  return offsets
    .map((off) => ({ off, d: Math.abs(off - target) }))
    .sort((a, b) => a.d - b.d)[0].off;
}
