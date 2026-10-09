# Feature Specification: Evaluate Claims (Jev-scored spec and plan review)

**Status:** Phases 1–2 implemented (engine, `plan` and `spec` modes, grounding, skill). `findings` mode and
calibration (§Delivery) are open.
**Date:** 2026-10-09
**Origin:** proposed for NimBus (context-and-oss/NimBus, branch `claude/jev-claim-evaluation-plugin-90b634`)
and moved here because the engine is repo-agnostic.

## Problem

Specs and plans are full of claims: proposed changes, decisions, and assertions about how the code
works today. A second LLM reviews them. That review is slow and costly, and it spot-checks: no
reviewer checks every claim against every architecture rule, goal and non-goal. Nor does it give
the same answer twice.

TypeSafe's **Jev** is a "System One" model. It takes a `state` and a map of typed questions:

- a **Noul** returns the probability, from 0 to 1, that a statement is true;
- a **Choice** returns one option, plus a probability per option and a confidence;
- a **Score** rates the state on an ordered rubric.

Jev answers in about 0.4 s and charges $0.042 per million input tokens. That makes an exhaustive
check of every (claim, rule), (claim, goal) and (claim, non-goal) pair cheap: a 50-claim plan costs
about one cent. The agent then spends its effort only on the claims Jev could not settle.

## Scope

- An **engine**: a dependency-free Node script. It extracts candidate claims from a markdown
  document, classifies them, asks Jev atomic questions per claim, applies thresholds and writes a
  report.
- An **`evaluate-claims` skill** that drives the engine. It also does the generative work Jev
  cannot do: splitting compound claims, gathering code evidence, verifying the uncertain items and
  generating a repo's rulebook.
- A **per-repo rulebook and config** under `.jev/` in the evaluated repo.

Out of scope for now: `findings` mode (triaging `/review-change` findings), CI gating, and
self-calibration (§Delivery).

## Design constraints from Jev

These come from the [jev-1.13 jaggedness notes](https://docs.typesafe.ai/model-jaggedness/jev-1.13)
and from the experiments below.

| Jev limit | Design response |
|---|---|
| Jev generates no text. | Code finds candidate claims and Jev only classifies them. A flag explains itself by naming the rule, goal or evidence line that fired. |
| Jev reads literally; negation and indirection hurt it. | Rules are normalized into `applies_when` / `requirement` pairs, phrased positively (FR-030). Each rule, non-goal, criterion and candidate travels inside its own question as structured instructions, never as an index into a long array in the state (FR-040). |
| Irrelevant state lowers accuracy; the limit is 32k tokens for the state plus the longest question. | One request per claim, with a small state. Coverage uses one request per plan. |
| A compound question hides several judgments. | One question per pair. Code combines the answers (FR-040). |
| A Choice leans toward its first option. | Option order is fixed in `questions.js`. Shuffle checks are part of calibration. |
| An alias can move to a new model. | The default model is pinned to `jev-1.13.0` (FR-061). |

## Experiments that shaped the design (2026-10-09, `jev-1.13.0`)

Seven claims about NimBus Spec 038 were checked against NimBus's `AGENTS.md`. Four of the claims
were planted failures.

- **Compound questions missed a non-goal.** A claim adding a new API endpoint came back as
  "advances a goal" at 0.84. The spec's non-goals say "no new APIs".
- **One Choice per raw `AGENTS.md` bullet gave false positives.** The question was "does the claim
  comply with rule *j*". A claim to rewrite a form "broke" three prohibitions it has nothing to do
  with ("Don't build event sourcing", …) at 0.95 or higher.
- **The normalized rulebook fixed both.** With two nouls per rule (applies, breaks), every planted
  architecture or scope failure was flagged and nothing else was:
  - rewrite rule: 0.85;
  - generated-client rule: 0.78;
  - non-goal: 0.77.
- **Grounding a claim against a code excerpt was 3/3 correct** at 0.98 or higher, using the
  citation-check pattern (supports, contradicts, says nothing).
- **Value is the weakest axis.** A speculative claim was not flagged, but its intent confidence
  was low (0.29). So value routes claims to review and never blocks.

### Dogfood: NimBus Spec 038 slice 3 plan (99 candidates, 23-rule rulebook)

The first run on a real, approved plan raised 12 advisory flags and 37 uncertain claims. None
were real problems. The causes, and the fixes now in the engine:

| Noise source | Fix |
|---|---|
| List fragments ("- a status strip;") lose their lead-in. | Items carry the last sentence of a `:` lead-in. Short label items lead their children and are dropped (FR-001). |
| Branch, commit, file-list and verification steps were judged against product goals. | New `process` kind: architecture questions only (FR-003, FR-040). |
| "No clear goal" fired whenever a claim served several goals. | Intent turns uncertain only when `none` leads or reaches 0.3. |
| Low-value flags fired at Score confidence near 0. | A low value score needs confidence ≥ 0.4. |
| "applies 0.91 × breaks 0.35" counted as uncertain. | Architecture is uncertain only when the rule applies and `breaks` ≥ 0.5. |
| A plan that builds out spec §6 was checked against the spec's abstract Goals only. | `--section 6` adds §6's items as criteria (FR-012). |

Four violations planted into the real plan then showed a **halo effect**. A claim that clearly
broke one rule also "broke" unrelated ones: a form rewrite broke `event-sourcing-use-case`
at 0.91, and a new endpoint was missed. The cause was indirection: the questions pointed into a
23-element `rules[j]` array. Moving each rule into its own question as structured instructions
fixed it. After all fixes:

- **Planted violations:** 4/4 flagged, each with exactly the right rule or non-goal.
- **Real claims:** 0 flags on the 89 real claims.
- **Uncertain:** 4 non-fact uncertain claims. The remaining uncertain claims are facts without
  evidence, which is the agent's job to supply.
- **Coverage:** found one real gap. Spec §6.3's "Progress uses the existing `OperationProgress`;
  the result links to the Audit Log" has no matching plan step.
- **Limitation:** detailed spec tables cover poorly against summary plan steps. Coverage stays
  advisory.

## User Scenarios

### US1 — Evaluate a plan against its spec (P1)

A maintainer runs `/evaluate-claims docs/plan/x.md docs/spec/y/spec.md`. The skill extracts the
plan's claims and evaluates each change claim against the spec's goals and non-goals and the repo
rulebook. It also checks that every acceptance criterion in the spec is delivered by some plan step.

1. A plan step that hand-edits a generated file is flagged under Architecture. The flag names the
   rule.
2. A plan step that builds something the spec's non-goals rule out is flagged under Scope.
3. An acceptance criterion that no plan step delivers is flagged under Coverage.

### US2 — Ground a spec's factual claims (P1)

Factual claims ("X already does Y") are checked in two steps. Code first confirms that every
referenced file exists. Jev then compares the claim with code excerpts the agent supplies.

1. A fact that cites a file not in the repo is reported as `fabricated`, without a Jev call.
2. A fact whose excerpt contradicts it is reported as `contradicted`.

### US3 — Uncertain claims go to the agent (P2)

Claims Jev is unsure about are listed separately. The skill verifies each one against the code or
spec and records its own conclusion. It never overwrites Jev's numbers.

### US4 — Reproducible runs (P2)

Every response is cached by a hash of the request. With `--offline`, a rerun makes no network
calls and gives an identical report.

## Requirements

### Inputs

- FR-001: `extract` MUST split a markdown document into candidate claims. A candidate is:
  - each list item (bullet or numbered), with its continuation lines but not its nested items;
  - each table body row;
  - each paragraph.

  Each candidate records `id` (`L<line>`), `text`, `kind`, and `source { path, line, section }`.
  Fenced code, headings and front-matter tables are not candidates.

  A list item's text starts with the last sentence of its lead-in when that lead-in ends in `:`.
  The lead-in is the paragraph just before the list, or the item's parent item. So "- a status
  strip;" under "Slice 3 builds out §6:" becomes "Slice 3 builds out §6: a status strip;".

  These are labels, not candidates:
  - a one-sentence paragraph ending in `:` that introduces a list;
  - a short parent item without sentence punctuation (8 words or fewer, e.g.
    "**`x.test.tsx`** (new)"). It leads its children instead.
- FR-002: `extract` MUST skip sections whose heading names an intent section (FR-010), so the
  intent text is never evaluated as a claim.
- FR-003: Unless `--no-classify` is given, `extract` MUST classify each candidate with one Jev
  Choice per candidate, batched per section. The kinds are:
  - `change`: proposes something to build, change, remove or decide in the product;
  - `fact`: asserts how existing code, tools or platforms behave;
  - `requirement`: a condition the result must meet, or a test that checks one;
  - `process`: how the work is organised or checked (branches, commits, PRs, file lists,
    verification);
  - `context`: background, status or navigation.

  Each claim records the classification confidence.
- FR-004: The claims file is JSON: `{ version: 1, document, claims: [...] }`. The agent MAY edit it
  before `evaluate`: split compound claims, correct a kind, or add `evidence`.
- FR-005: A `fact` claim's `evidence` is a list of `{ path, lines: "a-b" }`, with an optional
  `text`. When `text` is absent, the engine MUST read the lines itself and prefix each line with
  its number.
- FR-010: Intent sections are found by normalized heading text: lowercase, with numbering
  (`3.`, `§3`, `12.1`) and trailing punctuation removed, then compared exactly against aliases:
  - goals: `goals`, `objectives`;
  - non-goals: `non-goals`, `non goals`, `out of scope`;
  - criteria: `acceptance criteria`, `success criteria`, `requirements`, `functional requirements`;
  - constraints: `compatibility`, `constraints`.

  Config MAY replace the aliases. Each list item, table row or paragraph in such a section
  (subsections included) is one item, composed with its lead-in as in FR-001.
- FR-011: When the intent document has no recognized sections, every item in it MUST be treated as
  a goal, and the report MUST say so.
- FR-012: `--section <ref>` (repeatable) MUST add the items under a matching heading to the
  criteria. A heading matches by number (`6`, `§6`, `6.2`) or by its normalized name. This is how
  a plan that builds out one part of a spec is held to that part.

### Rulebook

- FR-030: The rulebook is `.jev/rulebook.json`:
  `{ version: 1, rules: [{ id, source, sourceHash, applies_when, requirement }] }`.
  - `applies_when` names the situation.
  - `requirement` states what must be done, phrased positively with one obligation per rule.
- FR-031: `stamp` MUST set each rule's `sourceHash` to the SHA-256 of its source section. The
  source is `path#heading-slug`, or a whole file when there is no `#`.
- FR-032: `evaluate` MUST warn about every rule whose source is missing or whose hash no longer
  matches.

### Questions and verdicts

- FR-040: For each `change`, `requirement` or `process` claim, `evaluate` MUST send one request.
  - **State:** `{ claim, section, goals }`.
  - **Per-item data** (the rule, non-goal or criterion) MUST travel inside the question as
    structured instructions, never as an index into a long array.
  - **Process claims** get only the Architecture questions.
  - **Architecture:** per rule, two nouls: does the rule apply, and does the claim break the
    requirement.
  - **Scope:** per non-goal, one noul: does the claim do what the non-goal rules out.
  - **Intent:** one Choice over goals, criteria and constraints, plus `none`.
  - **Value:** one 3-level Score, plus one noul asking whether the claim builds for a need nobody
    has stated.
- FR-041: Before any Jev call, every `fact` claim MUST pass a deterministic reference check. Each
  backticked token with a known file extension (`a/b.ext`, `b.ext`, `b.ext:12`), or a directory
  written with a trailing `/`, MUST exist among the repository's tracked and untracked-but-not-
  ignored files: the exact path or a path suffix, otherwise any file with that basename. Routes
  (`/Operations`), git refs (`origin/master`) and other extension-less tokens are not
  references. A token that does not resolve makes the claim `fabricated`.
- FR-042: A `fact` claim with evidence gets one Choice per excerpt: supports, contradicts, or says
  nothing.
- FR-043: In plan mode, each criterion gets two questions in one request. The state holds the
  plan's change and requirement claims as `L<line>| text` lines:
  - a noul: does any step deliver the criterion;
  - a Choice over step ids: which step delivers it. The Choice is skipped when there are more than
    254 steps.
- FR-044: Every question text and every threshold MUST live in `scripts/lib/questions.js`.
- FR-045: Each claim gets a verdict per axis: `pass`, `flag` or `uncertain`. The claim's overall
  verdict is the worst axis verdict. A flag MUST name its cause: the rule id, the non-goal text,
  the evidence path and lines, or the missing reference.
- FR-046: Severity is fixed per axis:
  - Grounding `contradicted` or `fabricated`: `blocking`.
  - Architecture or Scope flag: `should-fix`.
  - Intent, Value or Coverage flag: `advisory`.

### Runtime

- FR-060: The engine MUST read the API key from `TYPESAFE_API_KEY` only, and MUST never write it
  anywhere.
- FR-061: The model defaults to `jev-1.13.0`. `.jev/config.json` (`model`) or `--model` MAY
  override it.
- FR-062: Requests MUST be retried with exponential back-off and jitter on 429, 529, 5xx and
  network errors, honouring `retry-after`, for up to 5 attempts. Concurrency is capped (default 8).
- FR-063: Responses MUST be cached in a cache directory (default `.jev/cache`), keyed by the
  SHA-256 of `{model, state, questions}`. With `--offline`, a cache miss is an error.
- FR-064: `evaluate` MUST write a Markdown report and a JSON result. The JSON holds every answer
  and verdict. `--dry-run` MUST print the planned requests and estimated tokens without calling
  Jev.

### Skill

- FR-070: The skill `evaluate-claims` MUST be user-invocable. It takes a document, an optional
  intent document and a mode.
- FR-071: The skill MUST NOT edit the evaluated documents, commit or push. Its outputs are the
  report, and a rulebook only when the user asked to generate one.
- FR-072: When `.jev/rulebook.json` is missing, the skill MUST offer to generate it from the repo's
  agent and contributor docs (FR-030 form). It MUST stamp the rulebook and ask the user to review
  it before relying on it.
- FR-073: The skill MUST verify every `uncertain` claim and report its own conclusion separately
  from Jev's verdict.

### Non-functional

- NFR-001: The skill directory is self-contained: no npm dependencies, Node ≥ 20 only. It works
  when the skill directory is copied on its own.
- NFR-002: The engine is advisory: it exits 0 whether or not there are flags. It exits non-zero
  only on usage or runtime errors.

## Success Criteria

- SC-001: On the golden fixture (`test/fixtures/claims/`), every planted failure is flagged on its
  axis, and no claim marked good is flagged on Architecture or Scope.
- SC-002: Given the recorded cache, `evaluate --offline` reproduces the golden verdicts with no
  network access.
- SC-003: A fact citing a non-existent file is `fabricated` without a Jev call.

## Delivery

1. **Engine and plan mode.** Rulebook, Architecture, Scope, Intent, Value, Coverage, CLI and
   golden tests. *Done.*
2. **Grounding and skill.** Reference checks, evidence, skill orchestration and uncertain routing.
   *Done.*
3. **`findings` mode.** Triage `/review-change` or `*-review.md` findings: is each one grounded,
   in scope, and worth fixing.
4. **Calibration.** Build a 40–60-claim golden set from real reviews (NimBus `docs/plan/*-review.md`),
   measure precision and recall per axis, tune the thresholds and run option-shuffle checks.

## Assumptions

- Documents are English markdown. Jev is most accurate in English.
- Spec, plan and code excerpts are sent to TypeSafe. TypeSafe does not train on requests. Zero
  data retention is enterprise-only, so decide before using the engine on confidential repos.
