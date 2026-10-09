// The per-repo rulebook: normalized architecture rules with source hashes (spec 021 FR-030..FR-032).

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sectionText } from './markdown.js';

/** Load and validate a rulebook file (FR-030). Throws with every problem found. */
export function loadRulebook(path) {
  const book = JSON.parse(readFileSync(path, 'utf8'));
  const problems = [];
  if (book.version !== 1) problems.push(`version must be 1, got ${JSON.stringify(book.version)}`);
  if (!Array.isArray(book.rules)) problems.push('rules must be an array');
  const ids = new Set();
  for (const [i, rule] of (book.rules ?? []).entries()) {
    for (const field of ['id', 'applies_when', 'requirement']) {
      if (typeof rule[field] !== 'string' || !rule[field].trim()) problems.push(`rules[${i}].${field} is required`);
    }
    if (ids.has(rule.id)) problems.push(`rules[${i}].id "${rule.id}" is duplicated`);
    ids.add(rule.id);
  }
  if (problems.length) throw new Error(`invalid rulebook ${path}:\n  ${problems.join('\n  ')}`);
  return book;
}

/** SHA-256 of a rule's source section, or null when the file or heading is missing (FR-031). */
export function sourceHash(root, source) {
  if (!source) return null;
  const [file, slug = ''] = source.split('#');
  const path = resolve(root, file);
  if (!existsSync(path)) return null;
  const text = sectionText(readFileSync(path, 'utf8'), slug);
  if (text === null) return null;
  const normalized = text.split('\n').map((line) => line.trimEnd()).join('\n').trim();
  return `sha256:${createHash('sha256').update(normalized).digest('hex')}`;
}

/** Rules whose source is missing or changed since `stamp` (FR-032), as warning strings. */
export function staleRules(root, book) {
  const warnings = [];
  for (const rule of book.rules) {
    if (!rule.source) continue;
    const hash = sourceHash(root, rule.source);
    if (!hash) warnings.push(`rule "${rule.id}": source ${rule.source} not found`);
    else if (rule.sourceHash && rule.sourceHash !== hash) warnings.push(`rule "${rule.id}": ${rule.source} changed since the rulebook was stamped`);
    else if (!rule.sourceHash) warnings.push(`rule "${rule.id}": not stamped (run \`stamp\`)`);
  }
  return warnings;
}

/** Set every rule's `sourceHash` and rewrite the file (FR-031). Returns the per-rule outcome. */
export function stampRulebook(root, path) {
  const book = loadRulebook(path);
  const outcome = [];
  book.rules = book.rules.map(({ id, source, sourceHash: previous, applies_when, requirement, ...rest }) => {
    const hash = sourceHash(root, source);
    outcome.push({ id, source: source ?? null, stamped: Boolean(hash) });
    // Canonical key order (FR-030) so stamping produces minimal diffs.
    return { id, source, sourceHash: hash ?? previous, applies_when, requirement, ...rest };
  });
  writeFileSync(path, `${JSON.stringify(book, null, 2)}\n`);
  return outcome;
}
