# spec-review

A small, **repo-agnostic** spec-review loop. Three parts ship together:

1. **The review tool (web)** — a localhost HTML page that renders a markdown spec, lets a
   reviewer attach comments to highlighted passages, and persists them to a stable JSON
   sidecar next to the spec. Distributed on **npm**: run `npx spec-review docs/specs` in any repo.
2. **The `apply-review` agent skill** — a [Claude Code](https://docs.claude.com/en/docs/claude-code)
   skill that reads those sidecars, edits the spec to address each `open` comment, and marks it
   `resolved`/`wontfix`. Distributed as a **Claude Code plugin** (`.claude-plugin/` + `skills/`):
   install once and run `/apply-review` in any repo. See [skills/apply-review/SKILL.md](skills/apply-review/SKILL.md).
3. **The `evaluate-claims` agent skill** — scores every claim in a spec or plan with
   [TypeSafe's Jev](https://docs.typesafe.ai/introduction) model, checking each one against:
   - the repo's architecture rules;
   - the spec's goals and non-goals;
   - code evidence.

   It also checks that a plan covers every acceptance criterion. It ships in the same plugin:
   `/evaluate-claims`. See [Evaluate claims](#evaluate-claims-jev) below.

The tool and `apply-review` work against **any folder in any git repo** with zero per-project
configuration. `evaluate-claims` adds an optional rulebook per repo.

> Implements [spec 019 — Spec Review Tool](docs/specs/019-spec-review-tool/spec.md) (tool),
> [spec 020 — Apply Review](docs/specs/020-apply-review/spec.md) (skill) and
> [spec 021 — Evaluate Claims](docs/specs/021-evaluate-claims/spec.md) (skill).

## Install the agent skill (Claude Code plugin)

```
/plugin marketplace add akakaule/spec-review
/plugin install spec-review@spec-review
```

Then `/apply-review [path]` applies open review comments to your specs. The skill calls
`npx spec-review` only if you ask it to open the web UI — the two halves compose but have no
hard dependency on each other. `/evaluate-claims <plan.md> [spec.md]` scores a plan or spec
(needs `TYPESAFE_API_KEY`).

## Quick start

```bash
# from any repo
npx spec-review docs/specs

# or globally
npm i -g spec-review
spec-review docs/specs
```

The CLI starts a server on `127.0.0.1`, prints a URL containing a per-run token, and
opens your browser. The sidebar lists every discovered spec; click one to read it,
select a passage to comment, and your feedback is saved next to the spec.

## CLI

```
spec-review [path] [options]
```

| Argument / flag | Default | Meaning |
| --- | --- | --- |
| `path` | `./docs/specs` if it exists, else `.` | Folder to scan. |
| `--glob <pattern>` | `**/spec.md` | Which markdown files are specs. |
| `--port <n>` | an open port | Port to listen on. |
| `--no-open` | (off) | Don't auto-launch the browser. |
| `--read-only` | (off) | Render specs but disallow writing comments. |
| `-h`, `--help` | | Show help. |

## How it works

- **Rendering.** Markdown is rendered server-side to **sanitized** HTML with
  `markdown-it` (`html:false`, so embedded `<script>`/raw HTML is escaped, never
  executed). Headings get stable slugs; top-level blocks carry `data-source-*`
  line attributes used to map a browser selection back to source text.
- **Anchored comments.** A comment stores the selected `quote`, the nearest
  `heading`, bounded `prefix`/`suffix` context, and an advisory `offsetHint`. On
  every reopen the tool **re-anchors** by matching the quote and disambiguating
  with prefix/suffix/offset. The result is recorded as `anchorState`:
  `anchored` | `orphaned` | `ambiguous` — a non-anchored comment is surfaced
  separately and **never** attached to an unrelated passage.
- **Live reload.** File changes to a spec or its sidecar push an update to the UI
  (Server-Sent Events).

## Security model

"localhost-only" is a **reachability** control, not the write-authorization control:
any page in your browser can reach `http://127.0.0.1:<port>`. So writes require **all** of:

1. **Per-run token** — minted on startup, embedded in the served URL, sent as
   `X-Spec-Review-Token` (or `Authorization: Bearer`). Never persisted.
2. **Origin/Referer** matches the served origin.
3. **Host** is `127.0.0.1:<port>` / `localhost:<port>` (closes DNS-rebinding).
4. **Content-Type** is `application/json` (blocks simple cross-site form posts).

Reads also validate Host and require the token. No permissive CORS headers are set.

## The sidecar (`<name>.review.json`)

Each reviewed markdown file gets a sidecar next to it, named by replacing the `.md`
extension with `.review.json` (`spec.md` → `spec.review.json`). This keeps sidecars
unique when a directory holds several reviewed files under a broad `--glob`.

```jsonc
{
  "version": 1,            // schema version (evolves additively)
  "rev": 7,                // monotonic data revision (optimistic concurrency)
  "spec": "spec.md",       // the markdown file this sidecar pairs with
  "comments": [
    {
      "id": "c_ab12cd",                 // immutable, never changes
      "anchor": {
        "heading": "FR-033",
        "quote": "MUST dead-letter via IMessageContext.DeadLetter",
        "prefix": "…up to 32 chars before…",
        "suffix": "…up to 32 chars after…",
        "offsetHint": 1240
      },
      "body": "This is ambiguous — does it also abandon?",
      "author": "alvin",
      "status": "open",                 // open | resolved | wontfix
      "anchorState": "anchored",        // anchored | orphaned | ambiguous (tool-maintained)
      "createdAt": "2026-05-29T10:00:00Z",
      "updatedAt": "2026-05-29T10:00:00Z",
      "thread": [ { "author": "alvin", "body": "…", "createdAt": "…" } ],
      "resolution": null                // { by, note, at } when resolved/wontfix
    }
  ]
}
```

The file is **atomically** written (temp + rename) with stable key ordering, so it
diffs cleanly and is git-mergeable. **Commit it** for shared, reviewable-in-PR
feedback, or gitignore it for ephemeral local review — the default is committable.

## Agent-apply contract

A separate agent run (out of band) closes the loop. This is implemented by the
[`apply-review` skill](skills/apply-review/SKILL.md) (spec 020) — invoke it with
`/apply-review [path]`. Given `spec.md` + its `spec.review.json`, the agent MUST:

1. Read all comments with `status: "open"`.
2. For each, **recompute** the anchor against the *current* `spec.md` via `anchor.quote`,
   disambiguated by `prefix`/`suffix`/`offsetHint`. `anchorState` is advisory only — the live
   recompute decides editability.
3. Edit `spec.md` to address the comment.
4. Set `status` to `"resolved"` (or `"wontfix"`) and populate `resolution: { by, note, at }`.
5. Leave `id`, `anchor`, `anchorState`, `body`, `author`, `createdAt`, and `thread`
   unchanged. `anchorState` is **tool-maintained** — the agent reads it but never writes it.

If the anchor is not uniquely locatable (the `quote` is missing, moved, or now duplicated), the
agent MUST NOT edit a guessed passage — it leaves the comment `open` and reports it for the human
to re-place. If the anchor is located but the correct edit is undeterminable, it marks the comment
`wontfix` with a reason. **It never writes `thread`.**

If the agent writes the sidecar directly on disk, it MUST preserve all fields it does
not own and **increment `rev`** so a running tool's concurrency check stays coherent.

### Worked example

Before — `spec.review.json`:

```json
{ "version": 1, "rev": 3, "spec": "spec.md", "comments": [
  { "id": "c_ab12cd", "anchor": { "heading": "FR-033", "quote": "MUST dead-letter the message", "prefix": "The tool ", "suffix": " safely.", "offsetHint": 1240 },
    "body": "Does it also abandon?", "author": "alvin", "status": "open", "anchorState": "anchored",
    "createdAt": "2026-05-29T10:00:00Z", "updatedAt": "2026-05-29T10:00:00Z", "thread": [], "resolution": null } ] }
```

The agent finds `MUST dead-letter the message` in `spec.md`, rewrites it to
`MUST dead-letter the message (without abandoning it)`, then writes the sidecar with
`rev` bumped and the comment resolved:

```json
{ "version": 1, "rev": 4, "spec": "spec.md", "comments": [
  { "id": "c_ab12cd", "anchor": { "heading": "FR-033", "quote": "MUST dead-letter the message", "prefix": "The tool ", "suffix": " safely.", "offsetHint": 1240 },
    "body": "Does it also abandon?", "author": "alvin", "status": "resolved", "anchorState": "anchored",
    "createdAt": "2026-05-29T10:00:00Z", "updatedAt": "2026-05-29T11:00:00Z", "thread": [],
    "resolution": { "by": "agent", "note": "Clarified: dead-letters without abandoning.", "at": "2026-05-29T11:00:00Z" } } ] }
```

## Evaluate claims (Jev)

`/evaluate-claims` reviews a spec or plan claim by claim. TypeSafe's **Jev** is a fast, calibrated
classifier that returns typed answers with probabilities and cannot generate text. The skill asks
it one narrow question per pair and lets code decide:

- (claim, architecture rule): does the rule apply, and does the claim break it?
- (claim, non-goal): does the claim do what the non-goal rules out?
- (claim, goals): which goal does it serve, and how much does it matter?
- (fact, code excerpt): does the code support it, contradict it, or say nothing?
- (acceptance criterion, plan): which step delivers it?

The agent does the generative work: it splits compound claims, finds code evidence, verifies what
Jev was unsure of, and writes the rulebook. A 50-claim plan costs about one cent and takes a few
seconds.

```bash
export TYPESAFE_API_KEY=…                       # https://console.typesafe.ai/keys
E=skills/evaluate-claims/scripts/evaluate-claims.js
node $E extract docs/plan/x.md --out /tmp/claims.json        # candidates, classified by Jev
# (the skill edits claims.json: splits claims, adds code evidence to facts)
node $E evaluate /tmp/claims.json --intent docs/spec/y/spec.md --section 6 --out /tmp/report.md --json /tmp/result.json
node $E stamp                                   # record rule source hashes in .jev/rulebook.json
```

Per-repo files:

- **`.jev/rulebook.json`** — your architecture rules, normalized to
  `{ id, source, sourceHash, applies_when, requirement }`. The skill can generate it from
  `AGENTS.md`, `CLAUDE.md` and your ADRs. Review it and commit it.
- **`.jev/config.json`** — optional: `model`, `rulebook`, `cacheDir`, `concurrency`, `intentAliases`.
- **`.jev/cache/`** — response cache keyed by request hash; it ignores itself.

The engine is dependency-free Node (≥ 20). It is advisory: it exits 0 with or without flags. It
sends claim text, spec items and code excerpts to TypeSafe's API.

## Development

```bash
npm install      # one dependency: markdown-it
npm test         # node:test suite (unit + server integration + evaluate-claims, offline)
npm start -- .   # run against this repo
```

The `evaluate-claims` golden fixture (`test/fixtures/claims/`) replays recorded Jev responses from
`test/fixtures/claims/cache/`, so `npm test` needs no API key. After you change a question or
threshold in `skills/evaluate-claims/scripts/lib/questions.js`, re-record the fixture:

```bash
cd test/fixtures/claims && rm -rf cache
node ../../../skills/evaluate-claims/scripts/evaluate-claims.js extract docs/plan.md --cache cache > /dev/null
node ../../../skills/evaluate-claims/scripts/evaluate-claims.js evaluate plan.claims.json --intent docs/spec.md --cache cache
rm cache/.gitignore && cd ../../.. && npm test
```

## Known limitations (v1)

- **Sub-block inline anchoring.** Selecting *part* of a rendered sentence works when
  the selected text matches the source verbatim. Heavily formatted inline spans
  (e.g. selecting across `**bold**`) may not map back to source and are reported as
  unable to anchor — select plainer prose in that case.
- Single reviewer per running instance; no multi-user/real-time collaboration.
- No VCS-host (GitHub/GitLab) PR-comment integration.
