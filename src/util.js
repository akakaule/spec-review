// Small shared helpers with no external dependencies.

/**
 * Convert heading text into a stable, URL-safe slug (GitHub-ish rules).
 * Deterministic so the same heading always yields the same anchor (FR-011).
 * @param {string} text
 * @returns {string}
 */
export function slugify(text) {
  return String(text)
    .trim()
    .toLowerCase()
    .replace(/[`*_~]/g, '') // strip common inline markdown punctuation
    .replace(/[^\p{L}\p{N}\s-]/gu, '') // drop anything not letter/number/space/hyphen
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Zero-based line number containing the given character offset.
 * @param {string} source
 * @param {number} offset
 * @returns {number}
 */
export function offsetToLine(source, offset) {
  if (offset <= 0) return 0;
  const clamped = Math.min(offset, source.length);
  let line = 0;
  for (let i = 0; i < clamped; i++) {
    if (source.charCodeAt(i) === 10 /* \n */) line++;
  }
  return line;
}

/**
 * Character offset of the start of a zero-based line.
 * @param {string} source
 * @param {number} line
 * @returns {number}
 */
export function lineToOffset(source, line) {
  if (line <= 0) return 0;
  let seen = 0;
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) === 10) {
      seen++;
      if (seen === line) return i + 1;
    }
  }
  return source.length;
}
