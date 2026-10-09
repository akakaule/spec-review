// Markdown → blocks with source lines and heading paths, intent sections, and claim candidates.
// Deliberately a small line scanner, not a full CommonMark parser: the skill directory must stay
// dependency-free (spec 021 NFR-001), and specs/plans use a narrow subset of markdown.

/** Default heading aliases per intent kind (spec 021 FR-010). */
export const DEFAULT_INTENT_ALIASES = {
  goals: ['goals', 'objectives'],
  nonGoals: ['non-goals', 'non goals', 'out of scope'],
  criteria: ['acceptance criteria', 'success criteria', 'requirements', 'functional requirements'],
  constraints: ['compatibility', 'constraints'],
};

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE = /^\s*(```|~~~)/;
const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;

/**
 * GitHub's heading anchor (spec 021 FR-031): lowercase, punctuation dropped, each space a hyphen
 * (so "Build & test" → "build--test"). Not `src/util.js` slugify, which collapses runs of spaces;
 * kept local so the skill stays self-contained.
 */
export function slugify(text) {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

/** Heading text normalized for alias matching: no numbering, emphasis or trailing punctuation (FR-010). */
export function normalizeHeading(text) {
  return text
    .replace(/[*_`]/g, '')
    .toLowerCase()
    .replace(/^(§\s*)?\d+(\.\d+)*\.?\s+/, '')
    .replace(/[\s:.]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const collapse = (s) => s.replace(/\s+/g, ' ').trim();
const lastSentence = (text) => text.split(/(?<=[.!?])\s+(?=\S)/).pop();
// Ends in ":", ignoring trailing emphasis: "Decisions:" and "**Modified:**" both introduce a list.
const endsWithColon = (text) => /:[*_`]*$/.test(text);
// A short phrase without sentence punctuation, e.g. "**Sidebar** (`x.test.tsx` extended)".
const isLabel = (text) => !/[.!?;:][*_`]*$/.test(text) && text.split(/\s+/).length <= 8;
// Candidate or intent text of a block: its lead-in sentence, then its own text.
const withLead = (block) => (block.lead ? `${block.lead} ${block.text}` : block.text);
const splitRow = (line) =>
  line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => collapse(c));

/**
 * Split markdown into blocks: `heading`, `item` (list item), `row` (table body row) and
 * `paragraph`. Each block carries its 1-based `line`, `text`, and `headings` (the stack of
 * enclosing headings, outermost first). Fenced code and horizontal rules produce no blocks.
 *
 * A list item whose lead-in ends in ":" (the paragraph just before its list, or its parent item)
 * carries that lead-in's last sentence as `lead`, so fragments like "- a status strip;" stay
 * readable on their own. A one-sentence paragraph that only introduces a list is marked `label`.
 */
export function parseBlocks(source) {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  const headings = [];
  let fence = null;
  let current = null; // open item or paragraph
  let table = null; // { header, line }
  let list = null; // { lead, introducer, parents: [{ indent, block }] } while a list is open

  const close = () => {
    if (current) {
      current.text = collapse(current.text); // finalized in place: list.parents holds this object
      blocks.push(current);
    }
    current = null;
  };
  const endList = () => {
    list = null;
  };
  const startItem = (lineNo, indent, text) => {
    close();
    if (!list) {
      const previous = blocks[blocks.length - 1];
      const introducer = previous?.type === 'paragraph' && endsWithColon(previous.text) ? previous : null;
      if (introducer && lastSentence(introducer.text) === introducer.text) introducer.label = true;
      list = { lead: introducer ? lastSentence(introducer.text) : null, parents: [] };
    }
    while (list.parents.length && list.parents[list.parents.length - 1].indent >= indent) list.parents.pop();
    const parent = list.parents[list.parents.length - 1];
    let lead = list.lead;
    if (parent) {
      lead = endsWithColon(parent.text) ? lastSentence(parent.text) : null;
      if (!lead && isLabel(parent.text)) {
        parent.label = true; // "- **`x.test.tsx`** (new)" introducing nested items
        lead = `${parent.text}:`;
      }
    }
    current = { type: 'item', line: lineNo, indent, text, headings: snapshot() };
    if (lead) current.lead = lead;
    list.parents.push(current);
  };
  const snapshot = () => headings.map((h) => ({ ...h }));

  lines.forEach((line, index) => {
    const lineNo = index + 1;
    if (fence) {
      if (line.trim().startsWith(fence)) fence = null;
      return;
    }
    const fenceMatch = line.match(FENCE);
    if (fenceMatch) {
      close();
      table = null;
      fence = fenceMatch[1];
      return;
    }
    if (!line.trim()) {
      close();
      table = null;
      return;
    }
    const heading = line.match(HEADING);
    if (heading) {
      close();
      table = null;
      endList();
      const level = heading[1].length;
      while (headings.length && headings[headings.length - 1].level >= level) headings.pop();
      headings.push({ level, text: heading[2], line: lineNo });
      blocks.push({ type: 'heading', line: lineNo, level, text: heading[2], headings: snapshot() });
      return;
    }
    if (RULE.test(line)) {
      close();
      return;
    }
    if (TABLE_ROW.test(line)) {
      close();
      endList();
      if (!table) {
        table = { header: splitRow(line) };
        return;
      }
      if (TABLE_SEPARATOR.test(line)) return;
      const cells = splitRow(line);
      const text = cells
        .map((cell, i) => (table.header[i] ? `${table.header[i]}: ${cell}` : cell))
        .filter((part) => part.replace(/^[^:]*:\s*/, '').length > 0)
        .join('; ');
      blocks.push({ type: 'row', line: lineNo, text, headings: snapshot() });
      return;
    }
    table = null;
    const item = line.match(LIST_ITEM);
    if (item) {
      startItem(lineNo, item[1].length, item[3]);
      return;
    }
    const text = line.trim().replace(/^>\s?/, '');
    if (current) {
      current.text += ` ${text}`; // continuation or lazy continuation of an item/paragraph
      return;
    }
    endList();
    current = { type: 'paragraph', line: lineNo, text, headings: snapshot() };
  });
  close();
  return blocks.map(({ indent, ...block }) => block);
}

/** Map a block's enclosing headings to an intent kind, nearest heading first (FR-010). */
export function intentKindOf(block, aliases = DEFAULT_INTENT_ALIASES) {
  for (let i = block.headings.length - 1; i >= 0; i--) {
    const normalized = normalizeHeading(block.headings[i].text);
    for (const [kind, names] of Object.entries(aliases)) {
      if (names.includes(normalized)) return kind;
    }
  }
  return null;
}

/** "Parent > Child" path of a block's headings, without the document title (level 1). */
export function sectionPath(block) {
  return block.headings
    .filter((h) => h.level > 1)
    .map((h) => h.text)
    .join(' > ');
}

// "§6", "6", "6.2" or a heading name, normalized for matching against headings (FR-012).
function matchesSection(heading, ref) {
  const wanted = normalizeHeading(ref.replace(/^§\s*/, ''));
  const number = heading.text.replace(/[*_`]/g, '').trim().match(/^(?:§\s*)?(\d+(?:\.\d+)*)\.?(?:\s|$)/)?.[1];
  return normalizeHeading(heading.text) === wanted || number === wanted.replace(/\.$/, '');
}

/**
 * Collect intent items from a document (FR-010..FR-012). Returns
 * `{ goals, nonGoals, criteria, constraints, fallback }`; each item is `{ text, line, section }`.
 * Items under a heading named in `sections` (e.g. `§6` for a plan that builds out §6) are added
 * as criteria. With no recognized section, every content block becomes a goal and `fallback` is true.
 */
export function collectIntent(source, aliases = DEFAULT_INTENT_ALIASES, sections = []) {
  const intent = { goals: [], nonGoals: [], criteria: [], constraints: [], fallback: false };
  const blocks = parseBlocks(source).filter((b) => b.type !== 'heading' && !b.label);
  for (const block of blocks) {
    const kind = intentKindOf(block, aliases) ?? (block.headings.some((h) => sections.some((ref) => matchesSection(h, ref))) ? 'criteria' : null);
    if (kind) intent[kind].push({ text: withLead(block), line: block.line, section: sectionPath(block) });
  }
  if (!intent.goals.length && !intent.nonGoals.length && !intent.criteria.length && !intent.constraints.length) {
    intent.fallback = true;
    intent.goals = blocks.map((b) => ({ text: withLead(b), line: b.line, section: sectionPath(b) }));
  }
  return intent;
}

/**
 * Candidate claims of a document (FR-001/FR-002): list items (prefixed with their lead-in), table
 * body rows and paragraphs, excluding intent sections, list-introducing labels, and tables before
 * the first level-2 heading (front matter).
 */
export function collectCandidates(source, path, aliases = DEFAULT_INTENT_ALIASES) {
  return parseBlocks(source)
    .filter((b) => b.type !== 'heading' && !b.label)
    .filter((b) => !(b.type === 'row' && !b.headings.some((h) => h.level >= 2)))
    .filter((b) => !intentKindOf(b, aliases))
    .filter((b) => /[\p{L}\p{N}]/u.test(b.text))
    .map((b) => ({
      id: `L${b.line}`,
      text: withLead(b),
      kind: null,
      source: { path, line: b.line, section: sectionPath(b) },
    }));
}

/**
 * The text of the section a `#slug` anchor names (heading line through the line before the next
 * heading of the same or a higher level), or the whole source when `slug` is empty (FR-031).
 * Returns null when no heading has that slug.
 */
export function sectionText(source, slug) {
  const normalized = source.replace(/\r\n?/g, '\n');
  if (!slug) return normalized;
  const lines = normalized.split('\n');
  let start = -1;
  let level = 0;
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (fence) {
      if (line.trim().startsWith(fence)) fence = null;
      continue;
    }
    const fenceMatch = line.match(FENCE);
    if (fenceMatch) {
      fence = fenceMatch[1];
      continue;
    }
    const heading = line.match(HEADING);
    if (!heading) continue;
    if (start >= 0 && heading[1].length <= level) return lines.slice(start, i).join('\n');
    if (start < 0 && slugify(heading[2]) === slug) {
      start = i;
      level = heading[1].length;
    }
  }
  return start >= 0 ? lines.slice(start).join('\n') : null;
}
