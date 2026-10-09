---
name: evaluate-claims
description: Score every claim in a spec or plan with TypeSafe's Jev model. Checks each claim against the repo's architecture rules, the spec's goals and non-goals, and code evidence, and checks that a plan covers every acceptance criterion. Use when the user runs "/evaluate-claims", or asks to "evaluate the claims", "check this plan against the spec", "check the plan against our architecture", or "verify the facts in this spec". Needs TYPESAFE_API_KEY.
argument-hint: "<spec-or-plan.md> [intent-spec.md | #issue] [plan|spec]"
user-invocable: true
disable-model-invocation: true
allowed-tools: Bash(node ${CLAUDE_SKILL_DIR}/scripts/evaluate-claims.js *)
---

# evaluate-claims: Jev-scored review of a spec or plan

This skill implements [spec 021](../../docs/specs/021-evaluate-claims/spec.md). The work is split
three ways:

- **The engine** (`scripts/evaluate-claims.js`) asks TypeSafe's **Jev**, a fast, calibrated
  classifier, one narrow question per (claim, rule), (claim, goal) and (claim, non-goal) pair, then
  turns the probabilities into verdicts.
- **You** do what Jev cannot: generate text. You split compound claims, find code evidence, verify
  what Jev was unsure of, and write the rulebook.
- **The thresholds** in code decide.

The run is **read-only**: never edit the evaluated documents, commit or push (FR-071). The outputs
are a report, and a rulebook when the user asks for one.

The engine is `node ${CLAUDE_SKILL_DIR}/scripts/evaluate-claims.js`, below `$ENGINE`. In agents
without `${CLAUDE_SKILL_DIR}`, it is `scripts/evaluate-claims.js` next to this file. Run it from
the repository root. It needs Node 20 or later and no npm install.

## 0. Preconditions

- Check that `TYPESAFE_API_KEY` is set without printing it:
  `node -e "process.exit(process.env.TYPESAFE_API_KEY ? 0 : 1)"`.
  - If it is missing, ask the user to set it in their environment. Keys are at
    https://console.typesafe.ai/keys.
  - Never write the key to a file, echo it, or put it in a command line.
- Tell the user, once, that claims, spec items and code excerpts are sent to TypeSafe's API.

## 1. Resolve the inputs

Arguments: a target document (required), then an optional intent source and an optional mode.

- **Mode.**
  - `plan`: the target is a plan and the intent is its spec. Adds a coverage check.
  - `spec`: the target is a spec, judged against its own goals and non-goals, or against a linked
    issue.
  - Default: `plan` when the intent differs from the target, otherwise `spec`.
- **Intent for a plan.** Use the argument if given. Otherwise look for the spec the plan names: a
  markdown link to a `spec.md`, "Spec NNN" matched against `docs/spec*/NNN-*/spec.md`, or a path in
  the plan's header. If there are several candidates or none, ask the user once.
- **Intent from an issue.** For `#123`, save `gh issue view 123 --json title,body` as markdown in a
  temp file (title as `#`, body below it) and pass that file.
- The engine finds intent by heading:
  - goals: `Goals`, `Objectives`;
  - non-goals: `Non-goals`, `Out of scope`;
  - criteria: `Acceptance criteria`, `Success criteria`, `Requirements`;
  - constraints: `Compatibility`, `Constraints`.

  Numbering such as `## 3. Goals` is ignored. A repo whose headings differ can add
  `intentAliases` to `.jev/config.json`, e.g. `{"intentAliases": {"goals": ["aims"]}}`.
- **The part of the spec a plan builds (FR-012).** Many plans build one part of a spec, e.g.
  "Slice 3 builds out Spec 038 §6". Pass `--section 6` (repeatable; a number or a heading name).
  - Each item under that heading becomes a criterion. Claims are then judged against it, and
    coverage checks that the plan delivers it.
  - Prefer sections that list requirements. Detailed tables and per-field specs cover poorly
    against plan steps that summarize them. Read their coverage results as prompts, not
    findings.

## 2. The rulebook (FR-030..FR-032, FR-072)

The Architecture axis needs `.jev/rulebook.json`.

**If it is missing,** offer to generate it. Without one, the run still evaluates intent, scope,
value, grounding and coverage. To generate it:

1. Read the repo's agent and contributor docs: `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`, ADRs,
   and docs they point to that govern design.
2. Write one rule per obligation:

   ```json
   { "version": 1, "rules": [
     { "id": "api-codegen", "source": "AGENTS.md#conventions",
       "applies_when": "The claim changes the HTTP API or the web API client",
       "requirement": "Change api/openapi.yaml and regenerate the client; leave web/src/api-client.ts to the generator" } ] }
   ```

Jev reads literally, so these phrasing rules matter. Tests showed that raw "Don't …" bullets give
false positives:

- `applies_when` describes the **situation** ("The claim adds or changes a storage method"), not
  the rule.
- `requirement` says what **to do**, positively, with the concrete names: files, commands, types.
  Turn "Don't rewrite the WebApp" into "Change existing pages incrementally instead of rewriting
  them from scratch".
- Give each rule exactly one obligation. Split rules that use "and also".
- Leave out rules a compiler, linter or CI already enforces, and pure style or commit-message
  rules. Plans rarely make claims about those.
- Prefer rules that a single claim can visibly break. Leave out obligations met somewhere else
  in the work, such as "include a screenshot in the PR". The dogfood run showed such rules turn
  every UI claim "uncertain", because one claim neither does nor breaks them.
- Set `source` to `path#heading-slug`: the GitHub anchor of the section the rule came from.

Then:

1. Run `$ENGINE stamp` to record the source hashes.
2. Show the rulebook to the user and **wait for them to review it** before using it.
3. Suggest committing `.jev/rulebook.json`. The response cache under `.jev/cache/` ignores itself.

**If the run warns that rules are stale** (their source changed), tell the user which ones. Offer
to update them, then run `stamp` again.

## 3. Extract the claims (FR-001..FR-005)

```bash
$ENGINE extract <target.md> --out <tmp>/claims.json
```

Use a temp directory outside the repo. The engine turns every list item, table row and paragraph
into a candidate, outside the intent sections.

- **Lead-ins.** A list item starts with its `:` lead-in, so a fragment such as "a status strip;"
  arrives as "Slice 3 builds out §6: a status strip;".
- **Classification.** Jev classifies each candidate as one of:
  - `change`: a product proposal or decision;
  - `fact`: an assertion about the code today;
  - `requirement`: a condition the product must meet, or a test that checks one;
  - `process`: branches, commits, PRs, file lists and verification steps. These are checked
    against the rulebook only.
  - `context`: background. It is skipped.

**Edit `claims.json` as the reviewer:**

- **Split compound claims.** A claim with two independent assertions or steps becomes two entries
  with ids `L<line>a` and `L<line>b`. Keep `source`.
- **Correct obvious kind mistakes.** Most matter: a fact labelled `change`, or a real step labelled
  `context`.
- **Add evidence to each `fact`.**
  - Find the code it talks about (Grep, Read), then add `"evidence": [{"path": "src/…/File.cs", "lines": "120-160"}]`.
  - Use up to three excerpts, each 80 lines or fewer, containing what the claim is about. Jev's
    accuracy drops with unrelated text.
  - Use real file lines, never your own summary.
  - If you cannot find any code for a fact, leave `evidence` out. The fact is then reported as
    `unverified`.
  - Do not delete facts you think are wrong. The point is to measure them.

## 4. Evaluate (FR-040..FR-046, FR-064)

```bash
$ENGINE evaluate <tmp>/claims.json --intent <spec.md> [--section 6] --out <tmp>/report.md --json <tmp>/result.json
```

- Add `--dry-run` first on large documents. It prints the request count and an estimated token
  total; Jev costs about $0.04 per million input tokens.
- Before calling Jev, the engine resolves every backticked file path in a `fact` against the
  repo's files. A path that does not resolve makes the fact `fabricated`.
- Responses are cached by request hash, so a rerun of unchanged claims is free and identical.

Each claim gets a verdict per axis: `pass`, `flag` or `uncertain`. Flags carry a severity:

| Axis | Flags when | Severity |
|---|---|---|
| Grounding | evidence contradicts the fact, or a cited file does not exist | blocking |
| Architecture | a rule applies (≥ 0.5) and the claim breaks it (≥ 0.7) | should-fix |
| Scope | the claim does what a non-goal rules out (≥ 0.6) | should-fix |
| Intent / Value | it serves no goal, is low value, or builds for an unstated need | advisory |
| Coverage (plan) | no plan step delivers an acceptance criterion | advisory |

## 5. Verify the uncertain claims (FR-073)

For every claim under **Uncertain**, and every unclear coverage item:

1. Check it yourself against the code and the spec.
2. Conclude one of:
   - **confirmed problem**;
   - **not a problem** (say why);
   - **still unclear** (say what would settle it).
3. Cite `path:line` evidence.

Also look at each **flag**. If one is plainly a misfire, for example a rule applied to a claim it
does not govern, mark it **disputed** with your reason. Never drop it or change Jev's numbers. A
disputed flag usually means a rule's `applies_when` is too broad: suggest a better wording.

## 6. Report

Show the user:

- the report path and its Summary line;
- the flags, grouped by severity;
- an **Agent verification** section with your conclusions from step 5, kept apart from Jev's
  verdicts.

Close by offering next steps; do not take them unasked. The next steps are:

- fixing the flagged items in the document;
- tightening rules that misfired;
- re-running after edits.

A re-run only pays for claims whose text changed.

## Not covered yet

- **`findings` mode:** triaging `/review-change` or `*-review.md` findings.
- **Threshold calibration** against labelled reviews (spec 021 §Delivery).

All questions and thresholds are in `scripts/lib/questions.js`. If you change one, re-record the
golden fixture (`test/fixtures/claims`) live and compare the verdicts.
