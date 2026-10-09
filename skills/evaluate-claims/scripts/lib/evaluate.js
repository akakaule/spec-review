// Claim evaluation: plan the Jev requests, run them, and turn answers into verdicts (spec 021 FR-040..FR-046).

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  claimQuestions,
  coverageQuestions,
  groundingQuestion,
  kindQuestion,
  MAX_CHOICE_OPTIONS,
  SEVERITY,
  THRESHOLDS,
} from './questions.js';

const RANK = { 'n/a': 0, pass: 1, uncertain: 2, flag: 3 };
const SEVERITY_RANK = { advisory: 1, 'should-fix': 2, blocking: 3 };
const CLASSIFY_BATCH = 40;
const COVERAGE_BATCH = 25;
const MAX_EVIDENCE_LINES = 400;

// File extensions a backticked token must carry to count as a file reference (FR-041).
const FILE_EXTENSIONS = new Set(
  ('cs csproj slnx sln props targets razor cshtml js mjs cjs ts tsx jsx mts cts json jsonc yaml yml toml md mdx ' +
    'py go rs java kt swift rb php c h cpp hpp sql bicep tf ps1 psm1 sh bash html css scss xml config ini txt lock')
    .split(' '),
);

/** Classify candidates with one Choice each, batched per section (FR-003). Mutates and returns them. */
export async function classifyCandidates(client, candidates, documentName) {
  const bySection = new Map();
  for (const candidate of candidates) {
    const key = candidate.source.section;
    if (!bySection.has(key)) bySection.set(key, []);
    bySection.get(key).push(candidate);
  }
  const batches = [];
  for (const [section, items] of bySection) {
    for (let i = 0; i < items.length; i += CLASSIFY_BATCH) batches.push({ section, items: items.slice(i, i + CLASSIFY_BATCH) });
  }
  await Promise.all(
    batches.map(async ({ section, items }) => {
      const questions = Object.fromEntries(items.map((c, i) => [`kind_${i}`, kindQuestion(c.text)]));
      const state = { document: documentName, section };
      const { answers } = await client.ask(state, questions);
      items.forEach((candidate, i) => {
        candidate.kind = answers[`kind_${i}`].choice;
        candidate.kindConfidence = round(answers[`kind_${i}`].confidence);
      });
    }),
  );
  return candidates;
}

/**
 * Backticked tokens in a claim that are file references (FR-041): a known file extension, or a
 * directory written with a trailing `/`. Routes (`/Operations`), git refs (`origin/master`) and
 * other extension-less paths are not references, so they can never make a claim `fabricated`.
 */
export function findReferences(text) {
  const refs = [];
  for (const [, raw] of text.matchAll(/`([^`\n]+)`/g)) {
    const token = raw.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/:\d+(-\d+)?(,\s*\d+(-\d+)?)*$/, '');
    if (!token || token.startsWith('/') || /[\s*<>{}$?:]/.test(token)) continue;
    const ext = token.includes('.') ? token.slice(token.lastIndexOf('.') + 1).toLowerCase() : '';
    const isFile = FILE_EXTENSIONS.has(ext) && !token.endsWith('/');
    const isDirectory = token.endsWith('/') && /^[\w.@/-]+$/.test(token);
    if (isFile || isDirectory) refs.push({ token, isFile });
  }
  return refs;
}

/**
 * Files under `root` that git tracks or would track (untracked but not ignored), '/'-separated and
 * relative to `root`; null when `root` is not inside a git work tree.
 */
export function listRepoFiles(root) {
  try {
    return execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
      cwd: root,
      maxBuffer: 256 * 1024 * 1024,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split('\0')
      .filter(Boolean);
  } catch {
    return null;
  }
}

/** References that resolve to no tracked file or directory (FR-041). */
export function missingReferences(refs, files) {
  return refs.filter(({ token, isFile }) => {
    const stripped = token.replace(/\/$/, '');
    return !files.some(
      (f) =>
        f === stripped ||
        f.endsWith(`/${stripped}`) ||
        (!isFile && (f.startsWith(`${stripped}/`) || f.includes(`/${stripped}/`))),
    );
  });
}

/** Load an evidence excerpt, numbering its lines (FR-005). Returns `{ path, lines, text }` or `{ error }`. */
export function loadEvidence(root, evidence) {
  if (evidence.text) return { path: evidence.path, lines: evidence.lines ?? null, text: evidence.text };
  const file = resolve(root, evidence.path ?? '');
  if (!evidence.path || !existsSync(file)) return { path: evidence.path, error: 'file not found' };
  const all = readFileSync(file, 'utf8').replace(/\r\n?/g, '\n').split('\n');
  const match = String(evidence.lines ?? '').match(/^(\d+)(?:-(\d+))?$/);
  const from = match ? Number(match[1]) : 1;
  const to = Math.min(match ? Number(match[2] ?? match[1]) : all.length, from + MAX_EVIDENCE_LINES - 1, all.length);
  if (from > all.length) return { path: evidence.path, error: `line ${from} is past the end (${all.length} lines)` };
  const text = all.slice(from - 1, to).map((line, i) => `${from + i}: ${line}`).join('\n');
  return { path: evidence.path, lines: `${from}-${to}`, text };
}

/** Choice options for the intent question: goals, criteria and constraints, plus `none` (FR-040). */
export function goalOptions(intent, warnings = []) {
  const items = [
    ...intent.goals.map((g, i) => [`goal_${i + 1}`, g.text]),
    ...intent.criteria.map((c, i) => [`criterion_${i + 1}`, c.text]),
    ...intent.constraints.map((c, i) => [`constraint_${i + 1}`, c.text]),
  ];
  if (!items.length) return null;
  if (items.length > MAX_CHOICE_OPTIONS) {
    warnings.push(`intent has ${items.length} goal/criterion/constraint items; only the first ${MAX_CHOICE_OPTIONS} are offered as options`);
    items.length = MAX_CHOICE_OPTIONS;
  }
  return Object.fromEntries([...items, ['none', 'The claim serves none of these goals']]);
}

/**
 * Plan every request without calling Jev (FR-040..FR-043, FR-064 `--dry-run`). Returns
 * `{ requests, decided, skipped, warnings }`: `requests` carry `{ id, purpose, state, questions }`;
 * `decided` holds verdicts reached without Jev (fabricated references, missing evidence).
 */
export function planEvaluation({ claims, intent, rules, root, mode, files }) {
  const warnings = [];
  const requests = [];
  const decided = new Map();
  const skipped = [];
  const options = goalOptions(intent, warnings);
  const goals = options ? Object.entries(options).filter(([k]) => k !== 'none').map(([, v]) => v) : [];
  const nonGoals = intent.nonGoals.map((n) => n.text);
  const changeQuestions = claimQuestions({ goalOptions: options, nonGoals, rules });
  // Process claims (branches, commits, verification) can break architecture rules, but goals and
  // non-goals constrain the product, not how the work is done.
  const processQuestions = claimQuestions({ goalOptions: null, nonGoals: [], rules });
  if (files === null) warnings.push('not a git work tree: file references in fact claims were not checked');

  for (const claim of claims) {
    const kind = claim.kind ?? 'change';
    if (kind === 'context') {
      skipped.push({ id: claim.id, kind });
      continue;
    }
    if (kind === 'fact') {
      const missing = files ? missingReferences(findReferences(claim.text), files) : [];
      if (missing.length) {
        decided.set(claim.id, { grounding: axis('flag', missing.map((m) => ({ reference: m.token, problem: 'not in the repository' })), 'fabricated') });
        continue;
      }
      const evidence = (claim.evidence ?? []).map((e) => loadEvidence(root, e));
      const usable = evidence.filter((e) => !e.error);
      const broken = evidence.filter((e) => e.error).map((e) => ({ evidence: e.path, problem: e.error }));
      if (!usable.length) {
        decided.set(claim.id, { grounding: axis('uncertain', broken.length ? broken : [{ problem: 'no evidence supplied' }], 'unverified') });
        continue;
      }
      usable.forEach((e, n) =>
        requests.push({
          id: claim.id,
          purpose: 'grounding',
          evidence: { path: e.path, lines: e.lines },
          broken: n === 0 ? broken : [],
          state: { claim: claim.text, evidence: { path: e.path, lines: e.lines, text: e.text } },
          questions: { relation: groundingQuestion() },
        }),
      );
      continue;
    }
    const isProcess = kind === 'process';
    const questions = isProcess ? processQuestions : changeQuestions;
    if (!Object.keys(questions).length) continue; // nothing to ask: every axis is n/a
    requests.push({
      id: claim.id,
      purpose: 'claim',
      state: isProcess
        ? { claim: claim.text, section: claim.source?.section ?? '' }
        : { claim: claim.text, section: claim.source?.section ?? '', goals },
      questions,
    });
  }

  if (mode === 'plan') {
    const criteria = intent.criteria.length ? intent.criteria : intent.goals;
    const steps = claims.filter((c) => ['change', 'requirement', null, undefined].includes(c.kind));
    if (criteria.length && steps.length) {
      const stepIds = steps.length <= MAX_CHOICE_OPTIONS ? steps.map((s) => s.id) : null;
      if (!stepIds) warnings.push(`plan has ${steps.length} steps; coverage reports whether a criterion is delivered but not by which step`);
      const plan = steps.map((s) => `${s.id}| ${s.text}`).join('\n');
      for (let start = 0; start < criteria.length; start += COVERAGE_BATCH) {
        const chunk = criteria.slice(start, start + COVERAGE_BATCH);
        requests.push({
          id: `coverage@${start}`,
          purpose: 'coverage',
          criteria: chunk.map((c, i) => ({ index: start + i, ...c })),
          state: { plan },
          questions: Object.assign({}, ...chunk.map((c, i) => coverageQuestions(i, c.text, stepIds))),
        });
      }
    }
  }
  return { requests, decided, skipped, warnings };
}

/** Run a plan through `client` and assemble the result (FR-045/FR-046/FR-064). */
export async function runEvaluation({ claims, intent, rules, plan, client }) {
  const responses = await Promise.all(plan.requests.map((r) => client.ask(r.state, r.questions)));
  const byClaim = new Map();
  const coverage = [];
  plan.requests.forEach((request, i) => {
    const { answers } = responses[i];
    if (request.purpose === 'coverage') {
      coverage.push(...judgeCoverage(request, answers, claims));
      return;
    }
    if (!byClaim.has(request.id)) byClaim.set(request.id, []);
    byClaim.get(request.id).push({ request, answers });
  });

  const results = [];
  for (const claim of claims) {
    const kind = claim.kind ?? 'change';
    if (kind === 'context') continue;
    const entries = byClaim.get(claim.id) ?? [];
    let axes;
    let answers;
    if (plan.decided.has(claim.id)) {
      axes = plan.decided.get(claim.id);
    } else if (kind === 'fact') {
      axes = { grounding: judgeGrounding(entries) };
      answers = entries.map((e) => ({ evidence: e.request.evidence, relation: e.answers.relation }));
    } else {
      answers = entries[0]?.answers ?? {};
      axes = judgeChange(answers, { rules, intent });
    }
    const verdict = Object.values(axes).reduce((worst, a) => (RANK[a.verdict] > RANK[worst] ? a.verdict : worst), 'n/a');
    const severity = Object.entries(axes)
      .filter(([, a]) => a.verdict === 'flag')
      .map(([name]) => SEVERITY[name])
      .reduce((worst, s) => (!worst || SEVERITY_RANK[s] > SEVERITY_RANK[worst] ? s : worst), null);
    results.push({ id: claim.id, text: claim.text, kind, source: claim.source, verdict, severity, axes, answers });
  }
  return { claims: results, coverage };
}

function axis(verdict, causes = [], label = undefined) {
  return label ? { verdict, label, causes } : { verdict, causes };
}

const round = (n) => Math.round(n * 100) / 100;

/** Architecture, Scope, Intent and Value verdicts of one change/requirement claim (FR-045). */
export function judgeChange(answers, { rules, intent }) {
  const t = THRESHOLDS;
  const result = {};

  if (rules.length) {
    const flagged = [];
    const unsure = [];
    rules.forEach((rule, j) => {
      const applies = answers[`applies_${j}`]?.noul ?? 0;
      const breaks = answers[`breaks_${j}`]?.noul ?? 0;
      const cause = { rule: rule.id, applies: round(applies), breaks: round(breaks), requirement: rule.requirement };
      if (applies >= t.architecture.applies && breaks >= t.architecture.breaks) flagged.push(cause);
      else if (applies >= t.architecture.applies && breaks >= t.architecture.uncertainBreaks) unsure.push(cause);
    });
    result.architecture = flagged.length ? axis('flag', flagged) : unsure.length ? axis('uncertain', unsure) : axis('pass');
  } else result.architecture = axis('n/a');

  if (intent.nonGoals.length) {
    const flagged = [];
    const unsure = [];
    intent.nonGoals.forEach((nonGoal, k) => {
      const p = answers[`nongoal_${k}`]?.noul ?? 0;
      const cause = { nonGoal: nonGoal.text, line: nonGoal.line, p: round(p) };
      if (p >= t.scope.flag) flagged.push(cause);
      else if (p >= t.scope.uncertain) unsure.push(cause);
    });
    result.scope = flagged.length ? axis('flag', flagged) : unsure.length ? axis('uncertain', unsure) : axis('pass');
  } else result.scope = axis('n/a');

  const goal = answers.goal;
  if (goal) {
    const options = goalOptions(intent);
    const pNone = goal.probabilities?.none ?? 0;
    const best = { option: goal.choice, text: options[goal.choice], p: round(goal.probabilities?.[goal.choice] ?? 0), confidence: round(goal.confidence) };
    if (goal.choice === 'none' && pNone >= t.intent.noneFlag) result.intent = axis('flag', [{ problem: 'serves none of the goals', p: round(pNone) }]);
    else if (goal.choice === 'none' || pNone >= t.intent.noneUncertain) result.intent = axis('uncertain', [{ problem: 'may serve no goal', pNone: round(pNone), ...best }]);
    else result.intent = axis('pass', [best]);

    const value = answers.value;
    const speculative = answers.speculative?.noul ?? 0;
    const causes = [];
    if (value && value.score < t.value.lowScore && value.confidence >= t.value.minConfidence) {
      causes.push({ problem: 'low value', score: round(value.score), confidence: round(value.confidence) });
    }
    if (speculative >= t.value.speculative) causes.push({ problem: 'builds for a need nobody stated', p: round(speculative) });
    result.value = causes.length ? axis('flag', causes) : axis('pass', value ? [{ score: round(value.score) }] : []);
  } else {
    result.intent = axis('n/a');
    result.value = axis('n/a');
  }
  return result;
}

/** Grounding verdict of a fact claim from its per-excerpt answers (FR-042/FR-045). */
export function judgeGrounding(entries) {
  const min = THRESHOLDS.grounding.confidence;
  const relations = entries.map(({ request, answers }) => ({
    evidence: `${request.evidence.path}${request.evidence.lines ? `:${request.evidence.lines}` : ''}`,
    relation: answers.relation.choice,
    confidence: round(answers.relation.confidence),
  }));
  const broken = entries.flatMap((e) => e.request.broken ?? []);
  const contradicted = relations.filter((r) => r.relation === 'contradicts' && r.confidence >= min);
  if (contradicted.length) return axis('flag', contradicted, 'contradicted');
  const supported = relations.filter((r) => r.relation === 'supports' && r.confidence >= min);
  if (supported.length) return axis('pass', supported, 'verified');
  return axis('uncertain', [...relations, ...broken], 'unverified');
}

function judgeCoverage(request, answers, claims) {
  const t = THRESHOLDS.coverage;
  return request.criteria.map((criterion, i) => {
    const covered = answers[`covered_${i}`]?.noul ?? 0;
    const where = answers[`where_${i}`];
    const step = where ? claims.find((c) => c.id === where.choice) : null;
    const verdict = covered < t.missing ? 'flag' : covered < t.uncertain ? 'uncertain' : 'pass';
    return {
      criterion: criterion.text,
      line: criterion.line,
      verdict,
      severity: verdict === 'flag' ? SEVERITY.coverage : null,
      covered: round(covered),
      step: step ? { id: step.id, text: step.text, p: round(where.probabilities[where.choice]) } : null,
    };
  });
}

/** Rough input-token estimate of a request (characters / 4), for `--dry-run`. */
export function estimateTokens(request) {
  return Math.ceil(JSON.stringify({ state: request.state, questions: request.questions }).length / 4);
}
