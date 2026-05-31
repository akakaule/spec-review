# spec-review — Claude Code Instructions

## What this repo is

A **repo-agnostic spec-review loop** with two halves that ship together but install through
different channels:

1. **The review tool (web)** — a localhost Node server that renders a markdown spec, lets a
   reviewer highlight passages and attach comments, and persists them to a stable
   `*.review.json` sidecar **next to the spec**. It never edits the spec. Implements
   **spec 019** (`docs/specs/019-spec-review-tool/spec.md`). Distributed on **npm**:
   `npx spec-review docs/specs`.
2. **The `apply-review` agent skill** — a Claude Code skill (`skills/apply-review/SKILL.md`)
   that reads those sidecars, edits the spec to address each `open` comment, and marks it
   `resolved`/`wontfix` with a resolution note. Implements **spec 020**
   (`docs/specs/020-apply-review/spec.md`). Distributed as a **Claude Code plugin**
   (`.claude-plugin/`): `/plugin marketplace add akakaule/spec-review` → `/apply-review`.

The two compose (the skill can shell out to `npx spec-review`) but have **no hard code
dependency** on each other.

> History: extracted from the NimBus repo (where specs 019/020 originated) on 2026-05-31 so it
> can ship independently. Initial commit `7a929fb`, default branch `main`.

## Build / run / test

```bash
npm install          # one runtime dep: markdown-it
npm test             # node:test suite — currently 33 tests, all passing
npm start -- .       # run the web tool against this repo (or any path)
node bin/spec-review.js docs/specs   # same thing, explicit
```

- **Runtime:** Node `>=20`, **ESM** (`"type": "module"` — use `import`, not `require`).
- **Test framework:** the built-in `node:test` runner (`node --test`), asserts via `node:assert`.
  Tests live in `test/unit.test.js` (pure modules) and `test/server.test.js` (http integration).
- **Single dependency:** `markdown-it`. Keep it that way unless there's a strong reason — the
  "zero-config, drop-in" promise depends on a tiny dependency footprint.

## Layout

```
bin/spec-review.js          # CLI entry (arg parsing delegates to src/cli.js)
src/
  cli.js                    # arg/flag parsing, wires up the server
  server.js                 # http server, routes, SSE file-watch live-reload
  security.js               # write/read authorization: per-run token, Host, Origin, Content-Type
  discovery.js              # glob specs (**/spec.md) + pair/orphan sidecars
  render.js                 # markdown-it: sanitized HTML, heading anchors, per-block source lines
  anchor.js                 # createAnchor() + reanchor() (quote/prefix/suffix/offsetHint matching)
  store.js                  # sidecar read / serializeStore (stable key order) / atomic write / applyOperation / rev
  author.js                 # comment authoring helpers
  util.js                   # slugify, offset<->line conversions
public/                     # browser UI (app.js, index.html, styles.css) — no build step, served as-is
skills/apply-review/SKILL.md   # the agent skill (also the plugin's skill component)
.claude-plugin/
  plugin.json               # plugin manifest
  marketplace.json          # single-repo marketplace so the plugin installs from this repo
docs/specs/019.. 020..      # the design specs (source of the FR-xxx references in code/skill)
```

## Conventions

- **Specs are the contract.** Code and the skill cite requirement IDs (`FR-001`, `SC-006`,
  `NFR-005`, …) from `docs/specs/`. When you change behavior, keep the cited spec in sync —
  these are living docs, and the `apply-review` skill itself encodes spec 020.
- **Sidecar format is load-bearing.** `serializeStore`/`orderComment` in `src/store.js` define
  the exact JSON shape: 2-space indent, trailing newline, fixed key order
  (`version, rev, spec, comments`; comment `id, anchor, body, author, status, anchorState,
  createdAt, updatedAt, thread, resolution`). Sidecars are written **atomically** (temp + rename)
  and carry a monotonic `rev` for optimistic concurrency (409 on stale write). Don't reformat by
  hand; round-trip through `serializeStore`. The skill mirrors this rule literally (SKILL.md FR-008).
- **Anchoring lives in `src/anchor.js`.** `reanchor()` re-locates a comment's `quote` in the
  current source and reports `anchored | orphaned | ambiguous` (0 matches → orphaned, 1 → anchored,
  >1 → disambiguate by prefix/suffix then offsetHint, else ambiguous). The skill re-implements the
  same algorithm in prose — keep them aligned.
- **Security model is deliberate** (`src/security.js`): localhost-only is *reachability*, not auth.
  Writes require all of: per-run token, matching Origin/Referer, `127.0.0.1`/`localhost` Host,
  `application/json` Content-Type. Rendering is sanitized (`markdown-it` `html:false`). Don't
  weaken these — there are SC-006/SC-008 tests guarding them.
- **JSDoc** on exported functions, referencing the relevant FR. Match the existing terse style.

## Known limitations / pending work

- **npm: not yet published.** The package is publish-ready (`name: spec-review`, `bin`, `files`)
  but `npm publish` hasn't been run. `npx spec-review` works only after publish (or via a local link).
- **Indented code blocks** (4-space `code_block` tokens) still don't get `data-source-*` attributes:
  markdown-it's default `code_block` renderer drops token attrs. Fenced code blocks (```` ``` ````)
  *do* now carry them (on the `<code>` element) — see `src/render.js` `addSourceLines` and the
  regression test "fenced code blocks source-line attributes". Indented code is rare in specs; fix
  by overriding the `code_block` render rule if it ever matters.
- **Sub-block inline anchoring** (selecting across `**bold**`/inline spans) may not map back to
  source and is reported as unanchorable — select plainer prose. Single reviewer per instance;
  no GitHub/GitLab PR-comment integration. (See README "Known limitations".)
- **Continuous apply is deferred** (spec 020 "Continuous monitoring"): `/loop`, `/schedule`, and a
  tool-driven `--watch-apply` are designed but not built. The on-demand `/apply-review` is the
  shipped trigger.

## Dogfooding

This repo *is* a spec repo: run `npm start -- docs/specs` to review `019`/`020`, then `/apply-review
docs/specs` to apply any comments. There are no `*.review.json` sidecars committed yet, so a fresh
`/apply-review` reports "nothing to apply" until someone reviews.

## Git

- Default branch `main`. `node_modules/`, `*.log`, `smoke*.mjs` are gitignored.
- Push over **https** with the `gh` credential helper (the repo was created under the `akakaule`
  GitHub account): if a plain `git push` stalls on a credential prompt, push with
  `git -c credential.helper='!f(){ test "$1" = get && echo username=x-access-token && echo "password=$(gh auth token)"; };f' push`.
