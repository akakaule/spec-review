import MarkdownIt from 'markdown-it';
import { slugify } from './util.js';

/**
 * Build a markdown-it instance configured for safe spec rendering:
 *  - html:false escapes any raw HTML/script in the source (sanitization, SC-006/FR-010).
 *  - linkify off-by-default protocols are blocked by markdown-it's validateLink.
 *  - core rules add stable heading anchors (FR-011) and per-block source-line
 *    attributes (FR-012) used to map a browser selection back to source text.
 * @returns {MarkdownIt}
 */
export function createRenderer() {
  const md = new MarkdownIt({
    html: false, // never emit raw HTML — escapes <script> etc. (XSS, SC-006)
    linkify: true,
    breaks: false,
    typographer: false,
  });

  md.core.ruler.push('spec_review_anchors', addHeadingAnchors);
  md.core.ruler.push('spec_review_source_lines', addSourceLines);

  return md;
}

function addHeadingAnchors(state) {
  const counts = new Map();
  const tokens = state.tokens;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type !== 'heading_open') continue;
    const inline = tokens[i + 1];
    const text = inline && inline.type === 'inline' ? inline.content : '';
    let slug = slugify(text) || 'section';
    if (counts.has(slug)) {
      const n = counts.get(slug) + 1;
      counts.set(slug, n);
      slug = `${slug}-${n}`;
    } else {
      counts.set(slug, 0);
    }
    tokens[i].attrSet('id', slug);
  }
}

function addSourceLines(state) {
  for (const token of state.tokens) {
    // Expose the source map on every top-level (level 0) block: opening tokens
    // (nesting 1 — paragraph, heading, list) AND self-contained blocks
    // (nesting 0 — fenced/indented code, hr, html_block), which have no
    // open/close pair and were otherwise skipped (FR-012). Closing tokens
    // (nesting -1) and nested inline/rows/cells (level > 0) are excluded to
    // avoid cluttering the DOM.
    if (token.map && token.level === 0 && token.nesting !== -1) {
      token.attrSet('data-source-start', String(token.map[0]));
      token.attrSet('data-source-end', String(token.map[1]));
    }
  }
}

/**
 * Render markdown source to sanitized HTML.
 * @param {MarkdownIt} md
 * @param {string} source
 * @returns {string}
 */
export function renderMarkdown(md, source) {
  return md.render(source ?? '');
}

/**
 * The first level-1 heading text, used as a spec's display title (FR-006).
 * Falls back to null when no `# ` heading exists.
 * @param {string} source
 * @returns {string|null}
 */
export function extractTitle(source) {
  const lines = String(source ?? '').split(/\r?\n/);
  let inFence = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = /^#\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) return m[1].trim();
  }
  return null;
}
