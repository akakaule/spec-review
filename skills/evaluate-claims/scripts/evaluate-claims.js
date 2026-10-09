#!/usr/bin/env node
// evaluate-claims: score the claims in a spec or plan with TypeSafe Jev (spec 021).
// Dependency-free (Node >= 20) so the skill directory works when copied on its own (NFR-001).

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, dirname, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { collectCandidates, collectIntent, DEFAULT_INTENT_ALIASES } from './lib/markdown.js';
import { createClient } from './lib/jev.js';
import { classifyCandidates, estimateTokens, listRepoFiles, planEvaluation, runEvaluation } from './lib/evaluate.js';
import { loadRulebook, stampRulebook, staleRules } from './lib/rulebook.js';
import { renderReport } from './lib/report.js';
import { DEFAULT_MODEL } from './lib/questions.js';

const USAGE = `Usage:
  evaluate-claims extract <doc.md> [--out claims.json] [--no-classify]
  evaluate-claims evaluate <claims.json> [--intent spec.md] [--section §6 ...] [--mode plan|spec]
                           [--rulebook file] [--out report.md] [--json result.json] [--dry-run]
  evaluate-claims stamp [--rulebook file]

Common: --root <dir> (default: cwd)  --config <file> (default: <root>/.jev/config.json)
        --model <id>  --cache <dir> | --no-cache  --offline  --concurrency <n>
Reads the API key from TYPESAFE_API_KEY.`;

class UsageError extends Error {}

const OPTIONS = {
  out: { type: 'string' },
  json: { type: 'string' },
  intent: { type: 'string' },
  section: { type: 'string', multiple: true },
  mode: { type: 'string' },
  rulebook: { type: 'string' },
  root: { type: 'string' },
  config: { type: 'string' },
  model: { type: 'string' },
  cache: { type: 'string' },
  'no-cache': { type: 'boolean' },
  offline: { type: 'boolean' },
  concurrency: { type: 'string' },
  'no-classify': { type: 'boolean' },
  'dry-run': { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
};

const toPosix = (p) => p.replace(/\\/g, '/');

function loadSettings(values) {
  const root = resolve(values.root ?? process.cwd());
  const configPath = resolve(root, values.config ?? '.jev/config.json');
  const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : {};
  const concurrency = Number(values.concurrency ?? config.concurrency ?? 8);
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new UsageError('--concurrency must be a positive integer');
  return {
    root,
    model: values.model ?? config.model ?? DEFAULT_MODEL,
    rulebook: resolve(root, values.rulebook ?? config.rulebook ?? '.jev/rulebook.json'),
    cacheDir: values['no-cache'] ? null : resolve(root, values.cache ?? config.cacheDir ?? '.jev/cache'),
    offline: Boolean(values.offline),
    concurrency,
    aliases: { ...DEFAULT_INTENT_ALIASES, ...(config.intentAliases ?? {}) },
  };
}

function client(settings) {
  return createClient({ model: settings.model, cacheDir: settings.cacheDir, offline: settings.offline, concurrency: settings.concurrency });
}

function write(path, text) {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(path, text);
}

async function extract(file, values, settings) {
  const path = resolve(settings.root, file);
  if (!existsSync(path)) throw new UsageError(`no such document: ${file}`);
  const document = toPosix(relative(settings.root, path));
  const candidates = collectCandidates(readFileSync(path, 'utf8'), document, settings.aliases);
  if (!values['no-classify']) await classifyCandidates(client(settings), candidates, basename(path));
  const output = `${JSON.stringify({ version: 1, document, claims: candidates }, null, 2)}\n`;
  if (values.out) write(values.out, output);
  else process.stdout.write(output);
  const counts = candidates.reduce((acc, c) => ({ ...acc, [c.kind ?? 'unclassified']: (acc[c.kind ?? 'unclassified'] ?? 0) + 1 }), {});
  console.error(`${candidates.length} candidates from ${document}: ${Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(', ')}`);
}

async function evaluate(file, values, settings) {
  if (!existsSync(file)) throw new UsageError(`no such claims file: ${file}`);
  const claimsFile = JSON.parse(readFileSync(file, 'utf8'));
  if (claimsFile.version !== 1 || !Array.isArray(claimsFile.claims)) throw new UsageError(`${file} is not a version 1 claims file`);
  const intentPath = values.intent ? resolve(settings.root, values.intent) : resolve(settings.root, claimsFile.document);
  if (!existsSync(intentPath)) throw new UsageError(`no such intent document: ${toPosix(relative(settings.root, intentPath))}`);
  const document = claimsFile.document;
  const intentRel = toPosix(relative(settings.root, intentPath));
  const mode = values.mode ?? (intentRel === document ? 'spec' : 'plan');
  if (!['plan', 'spec'].includes(mode)) throw new UsageError('--mode must be plan or spec');

  const sections = values.section ?? [];
  const intent = collectIntent(readFileSync(intentPath, 'utf8'), settings.aliases, sections);
  const book = existsSync(settings.rulebook) ? loadRulebook(settings.rulebook) : null;
  const rules = book?.rules ?? [];
  const plan = planEvaluation({
    claims: claimsFile.claims,
    intent,
    rules,
    root: settings.root,
    mode,
    files: listRepoFiles(settings.root),
  });
  const warnings = [...(book ? staleRules(settings.root, book) : [`no rulebook at ${toPosix(relative(settings.root, settings.rulebook))}`]), ...plan.warnings];

  if (values['dry-run']) {
    const tokens = plan.requests.reduce((sum, r) => sum + estimateTokens(r), 0);
    const questions = plan.requests.reduce((sum, r) => sum + Object.keys(r.questions).length, 0);
    const byPurpose = plan.requests.reduce((acc, r) => ({ ...acc, [r.purpose]: (acc[r.purpose] ?? 0) + 1 }), {});
    console.log(`${plan.requests.length} requests (${Object.entries(byPurpose).map(([k, n]) => `${n} ${k}`).join(', ') || 'none'}), ${questions} questions, ~${tokens} input tokens; ${plan.decided.size} claims decided without Jev, ${plan.skipped.length} skipped.`);
    for (const w of warnings) console.log(`warning: ${w}`);
    return;
  }

  const jev = client(settings);
  const { claims, coverage } = await runEvaluation({ claims: claimsFile.claims, intent, rules, plan, client: jev });
  const result = {
    version: 1,
    document,
    mode,
    intent: {
      path: intentRel,
      sections,
      goals: intent.goals.length,
      nonGoals: intent.nonGoals.length,
      criteria: intent.criteria.length,
      constraints: intent.constraints.length,
      fallback: intent.fallback,
    },
    rulebook: book ? { path: toPosix(relative(settings.root, settings.rulebook)), rules: rules.length } : null,
    models: [...jev.stats.models],
    usage: { requests: jev.stats.requests, cacheHits: jev.stats.cacheHits, inputTokens: jev.stats.inputTokens },
    warnings,
    claims,
    coverage,
    skipped: plan.skipped,
  };
  const report = renderReport(result);
  if (values.json) write(values.json, `${JSON.stringify(result, null, 2)}\n`);
  if (values.out) {
    write(values.out, report);
    console.log(report.slice(report.lastIndexOf('## Summary') + '## Summary'.length).trim());
  } else process.stdout.write(report);
}

function stamp(settings) {
  if (!existsSync(settings.rulebook)) throw new UsageError(`no rulebook at ${settings.rulebook}`);
  for (const r of stampRulebook(settings.root, settings.rulebook)) {
    console.log(`${r.stamped ? 'stamped' : 'NOT FOUND'}  ${r.id}  ${r.source ?? '(no source)'}`);
  }
}

async function main(argv) {
  const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  const [command, target] = positionals;
  if (values.help || !command) {
    console.log(USAGE);
    return;
  }
  const settings = loadSettings(values);
  if (command === 'extract' && target) return extract(target, values, settings);
  if (command === 'evaluate' && target) return evaluate(target, values, settings);
  if (command === 'stamp') return stamp(settings);
  throw new UsageError(`unknown command or missing argument: ${positionals.join(' ')}`);
}

main(process.argv.slice(2)).catch((error) => {
  console.error(`evaluate-claims: ${error.message}`);
  if (error instanceof UsageError || error.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') {
    console.error(USAGE);
    process.exitCode = 2;
  } else process.exitCode = 1;
});
