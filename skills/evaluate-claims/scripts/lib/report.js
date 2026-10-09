// Markdown report of an evaluation result (spec 021 FR-045/FR-046/FR-064).

const AXES = ['grounding', 'architecture', 'scope', 'intent', 'value'];
const SEVERITY_ORDER = { blocking: 0, 'should-fix': 1, advisory: 2 };

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const quote = (text, max = 160) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

function describeCause(axisName, axis, cause) {
  if (cause.rule) return `breaks \`${cause.rule}\` (applies ${cause.applies}, breaks ${cause.breaks}): ${cause.requirement}`;
  if (cause.nonGoal !== undefined) return `does what a non-goal rules out (${cause.p}): "${quote(cause.nonGoal, 120)}"${cause.line ? ` (line ${cause.line})` : ''}`;
  if (cause.reference) return `\`${cause.reference}\` is ${cause.problem}`;
  if (cause.relation) return `${cause.evidence} ${cause.relation.replace('_', ' ')} the claim (${cause.confidence})`;
  if (cause.evidence) return `evidence ${cause.evidence}: ${cause.problem}`;
  if (cause.problem === 'may serve no goal') return `may serve no goal (none ${cause.pNone}; best "${quote(cause.text ?? cause.option, 100)}" at ${cause.p})`;
  if (cause.problem === 'low value') return `low value: score ${cause.score} of 2 (confidence ${cause.confidence})`;
  if (cause.problem) return `${cause.problem}${cause.p !== undefined ? ` (${cause.p})` : ''}`;
  return JSON.stringify(cause);
}

// One line for the claim, then one per cause on every flagged or uncertain axis.
function claimLines(claim) {
  const location = claim.source?.path ? `${claim.source.path}:${claim.source.line}` : claim.id;
  const lines = [`- **${claim.id}** (${claim.kind}, \`${location}\`) "${quote(claim.text)}"`];
  for (const name of AXES) {
    const axis = claim.axes[name];
    if (!axis || (axis.verdict !== 'flag' && axis.verdict !== 'uncertain')) continue;
    const label = `${axis.label ? ` ${axis.label}` : ''}${axis.verdict === 'uncertain' && claim.verdict === 'flag' ? ' (uncertain)' : ''}`;
    for (const cause of axis.causes.length ? axis.causes : [{}]) {
      lines.push(`  - ${name}${label}: ${axis.causes.length ? describeCause(name, axis, cause) : axis.verdict}`);
    }
  }
  return lines;
}

/** Render the result as Markdown in the shape of `/review-change` reports. */
export function renderReport(result) {
  const out = [];
  const flagged = result.claims.filter((c) => c.verdict === 'flag');
  const uncertain = result.claims.filter((c) => c.verdict === 'uncertain');
  const passed = result.claims.filter((c) => c.verdict === 'pass');
  const missing = result.coverage.filter((c) => c.verdict === 'flag');
  const unclear = result.coverage.filter((c) => c.verdict === 'uncertain');

  out.push(`# Claim evaluation: ${result.document}`, '');
  const i = result.intent;
  out.push(
    `**Mode:** ${result.mode}. **Intent:** ${i.path}${i.sections?.length ? ` + ${i.sections.join(', ')} as criteria` : ''} (${plural(i.goals, 'goal')}, ${plural(i.nonGoals, 'non-goal')}, ` +
      `${plural(i.criteria, 'criterion', 'criteria')}, ${plural(i.constraints, 'constraint')}` +
      `${i.fallback ? '; no intent headings found, every item treated as a goal' : ''}).`,
  );
  out.push(`**Rulebook:** ${result.rulebook ? `${result.rulebook.path} (${plural(result.rulebook.rules, 'rule')})` : 'none; the Architecture axis was skipped'}.`);
  out.push(
    `**Jev:** ${result.models.join(', ') || 'no calls'}; ${plural(result.usage.requests, 'request')}, ${result.usage.cacheHits} cached, ` +
      `${result.usage.inputTokens} input tokens. ${plural(result.claims.length, 'claim')} evaluated, ` +
      `${plural(result.skipped.length, 'context item')} skipped.`,
  );
  if (result.warnings.length) {
    out.push('', '**Warnings:**');
    for (const w of result.warnings) out.push(`- ${w}`);
  }

  out.push('', `## Flags (${flagged.length})`, '');
  if (!flagged.length) out.push('None.');
  for (const claim of [...flagged].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])) {
    out.push(...claimLines(claim).map((l, n) => (n === 0 ? l.replace('- **', `- **[${claim.severity}]** **`) : l)));
  }

  out.push('', `## Uncertain: verify these (${uncertain.length})`, '');
  if (!uncertain.length) out.push('None.');
  for (const claim of uncertain) out.push(...claimLines(claim));

  if (result.mode === 'plan') {
    out.push('', `## Coverage (${result.coverage.length - missing.length - unclear.length}/${result.coverage.length} criteria delivered)`, '');
    if (!result.coverage.length) out.push('No criteria or goals to cover.');
    for (const c of missing) out.push(`- **[advisory]** not delivered by any step (${c.covered}): "${quote(c.criterion)}" (intent line ${c.line})`);
    for (const c of unclear) out.push(`- unclear (${c.covered}): "${quote(c.criterion)}"${c.step ? `; closest step ${c.step.id}` : ''} (intent line ${c.line})`);
    if (!missing.length && !unclear.length && result.coverage.length) out.push('Every criterion is delivered by at least one step.');
  }

  out.push('', `## Passed (${passed.length})`, '');
  out.push(passed.length ? passed.map((c) => c.id).join(', ') : 'None.');

  const blocking = flagged.filter((c) => c.severity === 'blocking').length;
  const shouldFix = flagged.filter((c) => c.severity === 'should-fix').length;
  out.push(
    '',
    '## Summary',
    '',
    `${flagged.length} flagged (${blocking} blocking, ${shouldFix} should-fix, ${flagged.length - blocking - shouldFix} advisory), ` +
      `${uncertain.length} uncertain, ${passed.length} passed` +
      (result.mode === 'plan' ? `; ${plural(missing.length, 'criterion', 'criteria')} not delivered.` : '.'),
  );
  return `${out.join('\n')}\n`;
}
