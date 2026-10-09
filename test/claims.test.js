// Tests for the evaluate-claims skill engine (spec 021).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { promises as fs, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  collectCandidates,
  collectIntent,
  normalizeHeading,
  parseBlocks,
  sectionText,
  slugify,
} from '../skills/evaluate-claims/scripts/lib/markdown.js';
import {
  findReferences,
  goalOptions,
  judgeChange,
  judgeGrounding,
  loadEvidence,
  missingReferences,
  planEvaluation,
} from '../skills/evaluate-claims/scripts/lib/evaluate.js';
import { createClient, requestKey } from '../skills/evaluate-claims/scripts/lib/jev.js';
import { loadRulebook, stampRulebook, staleRules } from '../skills/evaluate-claims/scripts/lib/rulebook.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, 'fixtures', 'claims');
const CLI = path.join(here, '..', 'skills', 'evaluate-claims', 'scripts', 'evaluate-claims.js');

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'evaluate-claims-'));
const noul = (p) => ({ type: 'noul', noul: p });

// --- markdown (FR-001, FR-002, FR-010, FR-011) ----------------------------
test('parseBlocks keeps list continuations, splits nested items and skips code', () => {
  const blocks = parseBlocks(
    ['# T', '', '## Steps', '', '1. First step', '   wraps here.', '   - nested item', '', '```', '- not an item', '```', 'A paragraph', 'on two lines.'].join('\n'),
  );
  const content = blocks.filter((b) => b.type !== 'heading');
  assert.deepEqual(
    content.map((b) => [b.type, b.line, b.text]),
    [
      ['item', 5, 'First step wraps here.'],
      ['item', 7, 'nested item'],
      ['paragraph', 12, 'A paragraph on two lines.'],
    ],
  );
  assert.deepEqual(content[0].headings.map((h) => h.text), ['T', 'Steps']);
});

test('list items inherit the last sentence of a lead-in ending in ":"; pure label lead-ins are dropped', () => {
  const source = [
    '## Context',
    'Today it is a card. Slice 3 builds out §6:',
    '',
    '- a status strip;',
    '- an Endpoints table.',
    '',
    'Decisions (user, 2026-10-08):',
    '- **Delete** gains a confirmation.',
    '',
    '## Branch',
    '- Update the spec at the end:',
    '  - the status line;',
    '- Commit the plan first.',
    '',
    'A closing paragraph.',
    '- unrelated item',
  ].join('\n');
  const candidates = collectCandidates(source, 'plan.md');
  assert.deepEqual(
    candidates.map((c) => [c.id, c.text]),
    [
      ['L2', 'Today it is a card. Slice 3 builds out §6:'],
      ['L4', 'Slice 3 builds out §6: a status strip;'],
      ['L5', 'Slice 3 builds out §6: an Endpoints table.'],
      ['L8', 'Decisions (user, 2026-10-08): **Delete** gains a confirmation.'],
      ['L11', 'Update the spec at the end:'],
      ['L12', 'Update the spec at the end: the status line;'],
      ['L13', 'Commit the plan first.'],
      ['L15', 'A closing paragraph.'],
      ['L16', 'unrelated item'],
    ],
  );
});

test('a short label item with nested items leads its children and is not a candidate itself', () => {
  const source = [
    '## Tests',
    '- **`pages/operations.test.tsx`** (rewritten)',
    '  - The default operation is resubmit.',
    '- **Sidebar** (`x.test.tsx` extended)',
    '  - No badge when nothing is paused.',
    '- A long parent item that explains a real step in a full sentence.',
    '  - nested detail',
    '- Short item without children',
    '- **Modified:**',
    '  - `app.tsx`',
  ].join('\n');
  assert.deepEqual(
    collectCandidates(source, 'plan.md').map((c) => [c.id, c.text]),
    [
      ['L3', '**`pages/operations.test.tsx`** (rewritten): The default operation is resubmit.'],
      ['L5', '**Sidebar** (`x.test.tsx` extended): No badge when nothing is paused.'],
      ['L6', 'A long parent item that explains a real step in a full sentence.'],
      ['L7', 'nested detail'],
      ['L8', 'Short item without children'],
      ['L9', '**Modified:**'],
      ['L10', '**Modified:** `app.tsx`'],
    ],
  );
});

test('collectIntent composes lead-ins like candidates and skips list labels', () => {
  const source = '## Acceptance criteria\n\n**Every** operation asks for a typed confirmation:\n\n- resubmit with the endpoint name;\n- delete by To with the To value.\n';
  assert.deepEqual(collectIntent(source).criteria.map((c) => c.text), [
    '**Every** operation asks for a typed confirmation: resubmit with the endpoint name;',
    '**Every** operation asks for a typed confirmation: delete by To with the To value.',
  ]);
});

test('table body rows carry their header names; the separator and header are not candidates', () => {
  const blocks = parseBlocks(['## Plans', '', '| Plan | Issue |', '|---|---|', '| 1 | Phase split is wrong |'].join('\n'));
  const rows = blocks.filter((b) => b.type === 'row');
  assert.deepEqual(rows.map((r) => [r.line, r.text]), [[5, 'Plan: 1; Issue: Phase split is wrong']]);
});

test('normalizeHeading strips numbering, emphasis and trailing punctuation', () => {
  assert.equal(normalizeHeading('3. Goals'), 'goals');
  assert.equal(normalizeHeading('§4 **Non-goals**:'), 'non-goals');
  assert.equal(normalizeHeading('12.1 Compatibility'), 'compatibility');
});

test('collectIntent maps headings to intent kinds without confusing goals and non-goals', () => {
  const intent = collectIntent(readFileSync(path.join(FIXTURE, 'docs', 'spec.md'), 'utf8'));
  assert.equal(intent.goals.length, 3);
  assert.equal(intent.nonGoals.length, 3);
  assert.equal(intent.criteria.length, 4);
  assert.equal(intent.constraints.length, 1);
  assert.equal(intent.nonGoals[0].text, 'No import from Markdown.');
  assert.equal(intent.fallback, false);
});

test('collectIntent falls back to every item as a goal when no intent heading exists (FR-011)', () => {
  const intent = collectIntent('# Issue\n\nUsers want to export notes.\n\n- As Markdown\n');
  assert.equal(intent.fallback, true);
  assert.deepEqual(intent.goals.map((g) => g.text), ['Users want to export notes.', 'As Markdown']);
});

test('collectCandidates skips intent sections and front-matter tables', () => {
  const source = readFileSync(path.join(FIXTURE, 'docs', 'spec.md'), 'utf8');
  const candidates = collectCandidates(source, 'docs/spec.md');
  assert.deepEqual(candidates.map((c) => c.id), ['L8']); // only the intro paragraph
  assert.deepEqual(candidates[0].source, { path: 'docs/spec.md', line: 8, section: '' });
});

test('sectionText returns a heading section including its subsections, or null', () => {
  const md = '# A\n\n## B\nb\n### B1\nb1\n## C\nc\n';
  assert.equal(sectionText(md, 'b'), '## B\nb\n### B1\nb1');
  assert.equal(sectionText(md, 'missing'), null);
});

test('slugify matches GitHub heading anchors', () => {
  assert.equal(slugify('Build & test'), 'build--test');
  assert.equal(slugify('What not to do'), 'what-not-to-do');
  assert.equal(slugify('3. Goals'), '3-goals');
  assert.equal(slugify('snake_case `code`'), 'snake_case-code');
});

// --- references and evidence (FR-005, FR-041) ------------------------------
test('findReferences keeps path-like backticked tokens and drops namespaces and globs', () => {
  const refs = findReferences(
    'See `src/a/b.cs:12-14`, `Lookups.cs:84`, `components/admin/*`, `Microsoft.Extensions.Logging`, `tools/x/`, `v4.0.0`, `https://x.y/z.md`.',
  );
  assert.deepEqual(refs.map((r) => r.token), ['src/a/b.cs', 'Lookups.cs', 'tools/x/']);
});

test('findReferences ignores routes, git refs and extension-less paths (dogfood false positives)', () => {
  const refs = findReferences('`/Operations` `/Operations/:op` `origin/master` `claude/operations-redesign` `src/NimBus.Core` `docs/plan/x.md`');
  assert.deepEqual(refs.map((r) => r.token), ['docs/plan/x.md']);
});

test('missingReferences resolves exact paths, path suffixes, basenames and directories', () => {
  const files = ['src/App/ClientApp/src/pages/admin.tsx', 'src/Store/Lookups.cs', 'tools/x/run.js'];
  const refs = findReferences('`pages/admin.tsx` `Lookups.cs` `tools/x/` `pages/missing.tsx` `other/`');
  assert.deepEqual(missingReferences(refs, files).map((r) => r.token), ['pages/missing.tsx', 'other/']);
});

test('loadEvidence numbers the requested lines and reports bad ranges', () => {
  const evidence = loadEvidence(FIXTURE, { path: 'server/Storage/SqliteNoteStore.cs', lines: '6-7' });
  assert.equal(evidence.lines, '6-7');
  assert.match(evidence.text, /^6: {5}private const int PageSize = 100;\n7: $/);
  assert.match(loadEvidence(FIXTURE, { path: 'server/Storage/SqliteNoteStore.cs', lines: '900' }).error, /past the end/);
  assert.equal(loadEvidence(FIXTURE, { path: 'nope.cs' }).error, 'file not found');
});

// --- verdicts (FR-045, FR-046) ---------------------------------------------
const INTENT = {
  goals: [{ text: 'Every view has a URL' }],
  nonGoals: [{ text: 'No new APIs', line: 9 }],
  criteria: [],
  constraints: [],
};
const RULES = [{ id: 'incremental-ui', applies_when: 'changes a page', requirement: 'change it incrementally' }];

test('judgeChange flags a rule only when it both applies and is broken', () => {
  const base = { nongoal_0: noul(0.1), goal: { choice: 'goal_1', confidence: 0.9, probabilities: { goal_1: 0.95, none: 0.05 } }, value: { score: 1.8, confidence: 0.8 }, speculative: noul(0.1) };
  assert.equal(judgeChange({ ...base, applies_0: noul(0.89), breaks_0: noul(0.96) }, { rules: RULES, intent: INTENT }).architecture.verdict, 'flag');
  // applies but not broken (exp. c2: 0.94 x 0.18) and broken but not applicable both pass
  assert.equal(judgeChange({ ...base, applies_0: noul(0.94), breaks_0: noul(0.18) }, { rules: RULES, intent: INTENT }).architecture.verdict, 'pass');
  assert.equal(judgeChange({ ...base, applies_0: noul(0.1), breaks_0: noul(0.96) }, { rules: RULES, intent: INTENT }).architecture.verdict, 'pass');
  assert.equal(judgeChange({ ...base, applies_0: noul(0.6), breaks_0: noul(0.6) }, { rules: RULES, intent: INTENT }).architecture.verdict, 'uncertain');
});

test('judgeChange scope, intent and value thresholds', () => {
  const answers = {
    applies_0: noul(0),
    breaks_0: noul(0),
    nongoal_0: noul(0.77),
    goal: { choice: 'none', confidence: 0.7, probabilities: { goal_1: 0.2, none: 0.8 } },
    value: { score: 0.4, confidence: 0.5 },
    speculative: noul(0.75),
  };
  const axes = judgeChange(answers, { rules: RULES, intent: INTENT });
  assert.equal(axes.scope.verdict, 'flag');
  assert.equal(axes.scope.causes[0].nonGoal, 'No new APIs');
  assert.equal(axes.intent.verdict, 'flag');
  assert.deepEqual(axes.value.causes.map((c) => c.problem), ['low value', 'builds for a need nobody stated']);
  const unsure = judgeChange({ ...answers, nongoal_0: noul(0.4), goal: { choice: 'none', confidence: 0.1, probabilities: { goal_1: 0.45, none: 0.55 } } }, { rules: RULES, intent: INTENT });
  assert.equal(unsure.scope.verdict, 'uncertain');
  assert.equal(unsure.intent.verdict, 'uncertain');
});

test('architecture is uncertain only when a rule applies and breaking it is a coin flip', () => {
  const judge = (applies, breaks) => judgeChange({ applies_0: noul(applies), breaks_0: noul(breaks) }, { rules: RULES, intent: { ...INTENT, goals: [], nonGoals: [] } }).architecture.verdict;
  assert.equal(judge(0.91, 0.35), 'pass'); // applies, probably not broken (dogfood: PR-screenshot rule)
  assert.equal(judge(0.77, 0.53), 'uncertain');
  assert.equal(judge(0.4, 0.9), 'pass');
});

test('intent is uncertain only when "none" leads or holds real weight, not when goals share the vote', () => {
  const judge = (choice, pNone, confidence = 0.3) =>
    judgeChange({ goal: { choice, confidence, probabilities: { goal_1: 1 - pNone, none: pNone } } }, { rules: [], intent: INTENT }).intent.verdict;
  assert.equal(judge('goal_1', 0.05), 'pass'); // low confidence spread over real goals
  assert.equal(judge('goal_1', 0.35), 'uncertain');
  assert.equal(judge('none', 0.45), 'uncertain');
  assert.equal(judge('none', 0.73), 'flag');
});

test('a low value score flags only when the Score is confident', () => {
  const judge = (score, confidence) =>
    judgeChange({ goal: { choice: 'goal_1', confidence: 0.9, probabilities: { goal_1: 0.95, none: 0.05 } }, value: { score, confidence }, speculative: noul(0) }, { rules: [], intent: INTENT }).value.verdict;
  assert.equal(judge(0.38, 0.43), 'flag');
  assert.equal(judge(0.78, 0.28), 'pass');
});

test('process claims get only architecture questions (non-goals and goals constrain the product)', () => {
  const plan = planEvaluation({
    claims: [{ id: 'L1', text: 'Commit the plan first.', kind: 'process' }],
    intent: INTENT,
    rules: RULES,
    root: FIXTURE,
    mode: 'plan',
    files: [],
  });
  const claimRequest = plan.requests.find((r) => r.purpose === 'claim');
  assert.deepEqual(Object.keys(claimRequest.questions).sort(), ['applies_0', 'breaks_0']);
  assert.equal(plan.requests.some((r) => r.purpose === 'coverage'), false); // process steps deliver no criteria
});

test('a claim with nothing to ask (process claim, no rulebook) sends no request', () => {
  const plan = planEvaluation({
    claims: [{ id: 'L1', text: 'Commit the plan first.', kind: 'process' }],
    intent: { goals: [], nonGoals: [], criteria: [], constraints: [] },
    rules: [],
    root: FIXTURE,
    mode: 'spec',
    files: [],
  });
  assert.equal(plan.requests.length, 0);
});

test('collectIntent adds selected sections (by number or name) as criteria', () => {
  const source = '# S\n\n## 3. Goals\n- g\n\n## 6. Operations page\n### 6.1 Status strip\n- four tiles\n### 6.2 Endpoints table\n- toggles\n\n## 7. Settings\n- rows\n';
  assert.deepEqual(collectIntent(source, undefined, ['§6']).criteria.map((c) => c.text), ['four tiles', 'toggles']);
  assert.deepEqual(collectIntent(source, undefined, ['Settings', '6.2']).criteria.map((c) => c.text), ['toggles', 'rows']);
  assert.deepEqual(collectIntent(source).criteria, []);
});

test('judgeChange marks axes without inputs as n/a', () => {
  const axes = judgeChange({}, { rules: [], intent: { goals: [], nonGoals: [], criteria: [], constraints: [] } });
  assert.deepEqual(Object.values(axes).map((a) => a.verdict), ['n/a', 'n/a', 'n/a', 'n/a']);
});

test('judgeGrounding: contradiction wins, then support, else unverified', () => {
  const entry = (choice, confidence) => ({ request: { evidence: { path: 'a.cs', lines: '1-2' } }, answers: { relation: { choice, confidence } } });
  assert.equal(judgeGrounding([entry('supports', 0.9), entry('contradicts', 0.85)]).label, 'contradicted');
  assert.equal(judgeGrounding([entry('supports', 0.9), entry('says_nothing', 0.95)]).label, 'verified');
  assert.equal(judgeGrounding([entry('supports', 0.6)]).verdict, 'uncertain');
});

test('goalOptions offers goals, criteria and constraints plus none', () => {
  const options = goalOptions({ goals: [{ text: 'g' }], criteria: [{ text: 'c' }], constraints: [{ text: 'k' }], nonGoals: [] });
  assert.deepEqual(Object.keys(options), ['goal_1', 'criterion_1', 'constraint_1', 'none']);
  assert.equal(goalOptions({ goals: [], criteria: [], constraints: [], nonGoals: [] }), null);
});

test('planEvaluation decides fabricated and evidence-less facts without Jev (SC-003)', () => {
  const claims = [
    { id: 'L1', text: '`server/Gone.cs` already does it.', kind: 'fact' },
    { id: 'L2', text: 'The store pages by 100.', kind: 'fact' },
    { id: 'L3', text: 'Some background.', kind: 'context' },
  ];
  const plan = planEvaluation({ claims, intent: INTENT, rules: RULES, root: FIXTURE, mode: 'spec', files: ['server/Here.cs'] });
  assert.equal(plan.requests.length, 0);
  assert.equal(plan.decided.get('L1').grounding.label, 'fabricated');
  assert.equal(plan.decided.get('L2').grounding.label, 'unverified');
  assert.deepEqual(plan.skipped, [{ id: 'L3', kind: 'context' }]);
});

// --- client (FR-060, FR-062, FR-063) ----------------------------------------
function fakeFetch(responses) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(JSON.parse(init.body));
    const next = responses.shift();
    return {
      ok: next.status === 200,
      status: next.status,
      headers: { get: (name) => next.headers?.[name] ?? null },
      json: async () => next.body,
      text: async () => JSON.stringify(next.body ?? {}),
    };
  };
  return { fetchImpl, calls };
}
const OK = { status: 200, body: { model: 'jev-1.13.0', answers: { q: noul(0.9) }, usage: { input_tokens: 10 } } };

test('client retries 429 and 529 honouring retry-after, then succeeds', async () => {
  const sleeps = [];
  const { fetchImpl, calls } = fakeFetch([{ status: 429, headers: { 'retry-after': '2' } }, { status: 529 }, OK]);
  const client = createClient({ apiKey: 'k', model: 'm', fetchImpl, sleep: async (ms) => sleeps.push(ms) });
  const response = await client.ask({ s: 1 }, { q: { type: 'noul', instructions: 'x' } });
  assert.equal(response.answers.q.noul, 0.9);
  assert.equal(calls.length, 3);
  assert.equal(sleeps[0], 2000);
  assert.equal(client.stats.inputTokens, 10);
});

test('client does not retry a 422 and surfaces the body', async () => {
  const { fetchImpl, calls } = fakeFetch([{ status: 422, body: { detail: 'bad question' } }]);
  const client = createClient({ apiKey: 'k', model: 'm', fetchImpl, sleep: async () => {} });
  await assert.rejects(client.ask({}, {}), /TypeSafe 422: .*bad question/);
  assert.equal(calls.length, 1);
});

test('client caches by request hash, self-ignores its cache dir, and fails offline on a miss', async () => {
  const dir = await tmp();
  const cacheDir = path.join(dir, 'cache');
  const { fetchImpl, calls } = fakeFetch([OK]);
  const live = createClient({ apiKey: 'k', model: 'm', cacheDir, fetchImpl });
  await live.ask({ s: 1 }, { q: { type: 'noul', instructions: 'x' } });
  const again = await live.ask({ s: 1 }, { q: { type: 'noul', instructions: 'x' } });
  assert.equal(again.cached, true);
  assert.equal(calls.length, 1);
  assert.equal(await fs.readFile(path.join(cacheDir, '.gitignore'), 'utf8'), '*\n');
  assert.ok(await fs.stat(path.join(cacheDir, `${requestKey('m', { s: 1 }, { q: { type: 'noul', instructions: 'x' } })}.json`)));
  const offline = createClient({ apiKey: undefined, model: 'm', cacheDir, offline: true });
  assert.equal((await offline.ask({ s: 1 }, { q: { type: 'noul', instructions: 'x' } })).cached, true);
  await assert.rejects(offline.ask({ s: 2 }, {}), /cache miss in --offline mode/);
});

test('client refuses to call without an API key', async () => {
  const client = createClient({ apiKey: '', model: 'm', fetchImpl: async () => assert.fail('must not call') });
  await assert.rejects(client.ask({}, {}), /TYPESAFE_API_KEY is not set/);
});

// --- rulebook (FR-030..FR-032) --------------------------------------------
test('loadRulebook reports every problem at once', async () => {
  const dir = await tmp();
  const file = path.join(dir, 'rulebook.json');
  await fs.writeFile(file, JSON.stringify({ version: 2, rules: [{ id: 'a' }, { id: 'a', applies_when: 'x', requirement: 'y' }] }));
  assert.throws(() => loadRulebook(file), (error) => /version must be 1/.test(error.message) && /rules\[0\]\.applies_when/.test(error.message) && /duplicated/.test(error.message));
});

test('stamp records source hashes in canonical key order and staleRules detects drift', async () => {
  const dir = await tmp();
  await fs.writeFile(path.join(dir, 'AGENTS.md'), '# A\n\n## Rules\n\n- Keep it small.\n\n## Other\n\n- x\n');
  const file = path.join(dir, 'rulebook.json');
  await fs.writeFile(file, JSON.stringify({ version: 1, rules: [{ id: 'small', applies_when: 'w', requirement: 'r', source: 'AGENTS.md#rules' }, { id: 'gone', applies_when: 'w', requirement: 'r', source: 'AGENTS.md#missing' }] }));
  const outcome = stampRulebook(dir, file);
  assert.deepEqual(outcome.map((o) => o.stamped), [true, false]);
  const book = loadRulebook(file);
  assert.deepEqual(Object.keys(book.rules[0]), ['id', 'source', 'sourceHash', 'applies_when', 'requirement']);
  assert.deepEqual(staleRules(dir, book), ['rule "gone": source AGENTS.md#missing not found']);
  await fs.writeFile(path.join(dir, 'AGENTS.md'), '# A\n\n## Rules\n\n- Keep it smaller.\n\n## Other\n\n- changed\n');
  assert.match(staleRules(dir, book)[0], /"small": AGENTS.md#rules changed/);
});

// --- golden fixture, offline (SC-001, SC-002) -----------------------------
test('golden fixture: offline extract reproduces the recorded classification', () => {
  const out = execFileSync(process.execPath, [CLI, 'extract', 'docs/plan.md', '--cache', 'cache', '--offline'], {
    cwd: FIXTURE,
    env: { ...process.env, TYPESAFE_API_KEY: '' },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const extracted = JSON.parse(out).claims;
  const recorded = JSON.parse(readFileSync(path.join(FIXTURE, 'plan.claims.json'), 'utf8')).claims;
  assert.deepEqual(extracted.map((c) => [c.id, c.kind]), recorded.map((c) => [c.id, c.kind]));
});

test('golden fixture: every planted failure is flagged on its axis and good steps are not (SC-001)', async () => {
  const dir = await tmp();
  const json = path.join(dir, 'result.json');
  execFileSync(
    process.execPath,
    [CLI, 'evaluate', 'plan.claims.json', '--intent', 'docs/spec.md', '--cache', 'cache', '--offline', '--json', json, '--out', path.join(dir, 'report.md')],
    { cwd: FIXTURE, env: { ...process.env, TYPESAFE_API_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const result = JSON.parse(await fs.readFile(json, 'utf8'));
  const claim = (id) => result.claims.find((c) => c.id === id);
  assert.equal(result.usage.requests, 0);
  assert.deepEqual(result.warnings, []);

  assert.equal(claim('L7').axes.grounding.label, 'verified');
  assert.equal(claim('L8').axes.grounding.label, 'contradicted');
  assert.equal(claim('L9').axes.grounding.label, 'fabricated');
  assert.equal(claim('L10').axes.grounding.label, 'unverified');

  const brokenRule = (id) => {
    assert.equal(claim(id).axes.architecture.verdict, 'flag', `${id} architecture`);
    return claim(id).axes.architecture.causes.map((c) => c.rule);
  };
  assert.deepEqual(brokenRule('L18'), ['storage-both-stores']);
  assert.deepEqual(brokenRule('L20'), ['incremental-ui']);
  assert.deepEqual(brokenRule('L22'), ['no-plugin-system']);
  assert.deepEqual(brokenRule('L23'), ['api-codegen']);
  assert.equal(claim('L21').axes.scope.verdict, 'flag');
  assert.equal(claim('L21').axes.scope.causes[0].nonGoal, 'No import from Markdown.');

  for (const id of ['L14', 'L16', 'L19', 'L24']) {
    assert.equal(claim(id).axes.architecture.verdict, 'pass', `${id} architecture`);
    assert.notEqual(claim(id).axes.scope.verdict, 'flag', `${id} scope`);
  }

  const notDelivered = result.coverage.filter((c) => c.verdict === 'flag').map((c) => c.line);
  assert.deepEqual(notDelivered, [27]);
  assert.deepEqual(result.skipped, [{ id: 'L3', kind: 'context' }]);
});
