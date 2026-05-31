---
name: apply-review
description: Apply anchored spec-review feedback to the spec. Use when the user runs "/apply-review", asks to "apply review comments", "resolve spec review comments", "apply the review", or "address review feedback" on a markdown spec that has a `*.review.json` sidecar (produced by the spec-review tool, spec 019). The skill reads every `open` comment from each sidecar, edits the paired `spec.md` to address it, and marks the comment `resolved` (or `wontfix`) with a resolution trail — file-direct, no server required.
user-invocable: true
---

# apply-review — apply anchored review feedback to a spec

This skill is the **agent half** of the spec-review loop. The [spec-review tool](../../README.md)
(spec 019) lets a reviewer attach anchored comments to a markdown spec and persists them in a
`*.review.json` **sidecar** next to the spec. This skill reads those comments, edits the spec to
address each one, and writes the comment back as `resolved`/`wontfix` with a resolution note.

It implements [spec 020](../../docs/specs/020-apply-review/spec.md). It is **file-direct**: it
operates on the files with Glob/Read/Grep/Edit/Write. The 019 server does **not** need to be
running; when it is, the `rev` bump (below) keeps its live UI coherent.

**Never commit or push.** Edits are left in the working tree for the human to review and commit.

## Invocation and target resolution (FR-001)

`/apply-review [path]` — `path` is optional; default target is `./docs/specs`.

Resolve the target, then collect the sidecars to process:

| Target | Sidecars to process |
|---|---|
| a **folder** (incl. a spec directory) | every `**/*.review.json` under it (use Glob) |
| a **`.md` file** (e.g. `docs/specs/foo/spec.md`) | its sibling sidecar only — replace the trailing `.md` with `.review.json` in the same directory |
| a **`.review.json` file** | that one sidecar |

If no sidecars are found, report **"nothing to apply"** and change no files.

## The sidecar shape

```jsonc
{
  "version": 1,
  "rev": 7,                       // monotonic; bump by exactly 1 per write (FR-007)
  "spec": "spec.md",              // the markdown file this sidecar pairs with
  "comments": [
    {
      "id": "c_ab12cd",           // immutable
      "anchor": { "heading": "FR-033", "quote": "…", "prefix": "…", "suffix": "…", "offsetHint": 1240 },
      "body": "the reviewer's request",
      "author": "alvin",
      "status": "open",           // open | resolved | wontfix  ← only `open` is work
      "anchorState": "anchored",  // anchored | orphaned | ambiguous  ← ADVISORY only; never write it
      "createdAt": "…", "updatedAt": "…",
      "thread": [ … ],            // reviewer-owned; NEVER write it
      "resolution": null          // { by, note, at } when resolved/wontfix
    }
  ]
}
```

## Procedure

Run this for each sidecar in the target.

### 1. Pair and validate (FR-002)

- Read the sidecar.
- Compute the paired markdown filename: the sidecar's name with `.review.json` replaced by `.md`,
  in the **same directory** (`spec.review.json` → `spec.md`).
- **Cross-check that filename against the sidecar's `spec` field. If they disagree, do NOT edit
  anything for this sidecar** — report the mismatch and skip it, continue with the others
  (safe-by-default: the field may name a different or moved file).
- If the paired markdown does not exist (orphaned sidecar): report it, skip, edit nothing.
- If the sidecar JSON is malformed: report a clear error for that file and continue with the
  others — never partially write it.
- On agreement, Read the markdown.

### 2. Select work (FR-003)

Work = every comment with `status == "open"`. Skip `resolved`/`wontfix` (already done).

`anchorState` is **advisory only**. A stored `orphaned`/`ambiguous` is a hint that step 3 will
likely fail; a stored `anchored` does **not** by itself authorize an edit. The authority on
editability is the live recompute in step 3.

### 3. Recompute the anchor against the *current* markdown (FR-004)

Do not trust the stored anchor position — recompute it, mirroring `reanchor()` in
`src/anchor.js`:

1. **Find every occurrence** of `anchor.quote` in the current markdown (an exact, literal
   substring match — the quote may contain CRLF and punctuation). Use Grep with a distinctive
   literal fragment of the quote (escape regex metacharacters), then Read around each hit to
   confirm the full quote and count true occurrences.
2. **0 occurrences → orphaned.** Skip: leave `status:"open"`, leave `anchorState` unchanged,
   report it for the human to re-place. Do **not** edit.
3. **Exactly 1 → unique match.** Proceed to step 4 at that passage.
4. **More than 1 → disambiguate by context:** keep only occurrences whose immediately-preceding
   text ends with `anchor.prefix` **and** whose immediately-following text starts with
   `anchor.suffix`. If exactly one survives → proceed. If still more than one, use
   `anchor.offsetHint` as a tie-break **only** when a single candidate is unambiguously closest;
   otherwise it is **ambiguous** → skip + report (same as orphaned: leave open, don't edit).

Never attach a comment to a passage you are not sure of. A wrong edit is worse than a deferred one.

### 4. Edit the markdown (FR-004)

Edit the located passage to address the comment's `body`. If you genuinely cannot determine the
correct edit (the request is unclear or underspecified), do **not** guess — handle it as a
`wontfix` in step 5b.

### 5. Record the outcome in the sidecar — surgically

Always **re-Read the sidecar immediately before editing it** (FR-007a), then make targeted Edits.
Use the **Edit** tool (exact string replacement) so every byte you don't touch — other comments,
key order, indentation, the trailing newline — stays identical (this is how FR-006/FR-008/SC-002/
SC-006 are met without re-serializing the file).

**5a. Resolved** (you made the edit): for that comment, Edit
- `"status": "open"` → `"status": "resolved"`, and
- `"resolution": null` → `"resolution": { "by": "claude", "note": "<what you changed>", "at": "<now>" }`, and
- its `"updatedAt"` to the current timestamp.

**5b. Wontfix** (anchor located but edit undeterminable, FR-011): same edits but
`"status": "wontfix"` and a `note` explaining why you declined.

**5c. Skipped** (orphaned/ambiguous anchor, step 3): write **nothing** to the sidecar for this
comment — it stays `open` and is reported only in the summary. Never write `thread` or
`anchorState`.

`by` is always `"claude"`. `at`/`updatedAt` are the **current ISO-8601 UTC timestamp** (e.g.
`2026-05-31T14:00:00Z`).

### 6. Bump `rev` once per sidecar (FR-007 / FR-007a)

After all comment edits for a sidecar, Edit its top-level `"rev": N` → `"rev": N+1` (one bump per
sidecar regardless of how many comments changed). Bump only if at least one comment changed.

If this `rev` Edit fails because the value no longer matches (a reviewer or another agent wrote
while you were working), **re-Read the sidecar and retry** against the new `rev`. Your per-comment
Edits target their own surrounding bytes, so a concurrent change to *other* comments never
conflicts — this is the optimistic-concurrency, merge-by-id behavior. Never overwrite the whole
sidecar with a stale in-memory copy.

### 7. Report (FR-010)

Print a per-spec summary and an overall total:
- counts of **resolved** and **wontfix**,
- the **skipped** comments (orphaned/ambiguous or spec-field-mismatch) with their `id` and
  `quote` and the reason,
- the changed spec paths.

If nothing was applicable, say "nothing to apply".

## What you MUST NOT do

- **Do not guess.** Non-unique or missing anchor → skip and report, never edit a nearby passage.
- **Do not write `thread` or `anchorState`** — both are reviewer/tool-owned (FR-006).
- **Do not change** `id`, `anchor`, `body`, `author`, or `createdAt` of any comment.
- **Do not commit or push** (FR-009).
- **Do not re-serialize** the whole sidecar by hand — use surgical Edits so formatting is exact.

## Idempotency (NFR-003)

A re-run with no new feedback must be a no-op: all previously-applied comments are now
`resolved`/`wontfix` (skipped in step 2), and the only `open` comments left are the ones whose
anchors are not uniquely locatable (skipped in step 3). So a second `/apply-review` changes no
files and resolves nothing.

## Serialization reference (FR-008)

You normally only flip a few values with Edit, but if you must write a value from scratch, match
the tool's serializer exactly (`serializeStore`/`orderComment` in `src/store.js`):
UTF-8, 2-space indent, single trailing newline, and these key orders:

- top level: `version`, `rev`, `spec`, `comments`
- comment: `id`, `anchor`, `body`, `author`, `status`, `anchorState`, `createdAt`, `updatedAt`, `thread`, `resolution`
- `anchor`: `heading`, `quote`, `prefix`, `suffix`, `offsetHint`
- `resolution`: `{ by, note, at }`, or `null` when `status == "open"`

These sidecars and specs use **CRLF** line endings — match the actual file bytes when editing.

## Worked example

Before (`spec.review.json`, one open comment):

```json
{ "version": 1, "rev": 3, "spec": "spec.md", "comments": [
  { "id": "c_ab12cd", "anchor": { "heading": "FR-033", "quote": "MUST dead-letter the message", "prefix": "The tool ", "suffix": " safely.", "offsetHint": 1240 },
    "body": "Does it also abandon?", "author": "alvin", "status": "open", "anchorState": "anchored",
    "createdAt": "2026-05-29T10:00:00Z", "updatedAt": "2026-05-29T10:00:00Z", "thread": [], "resolution": null } ] }
```

Steps: find `MUST dead-letter the message` (unique) in `spec.md` → Edit it to
`MUST dead-letter the message (without abandoning it)`. Then re-Read the sidecar and surgically
Edit the comment to `status:"resolved"` + `resolution`, update `updatedAt`, and bump `rev` 3 → 4:

```json
{ "version": 1, "rev": 4, "spec": "spec.md", "comments": [
  { "id": "c_ab12cd", "anchor": { "heading": "FR-033", "quote": "MUST dead-letter the message", "prefix": "The tool ", "suffix": " safely.", "offsetHint": 1240 },
    "body": "Does it also abandon?", "author": "alvin", "status": "resolved", "anchorState": "anchored",
    "createdAt": "2026-05-29T10:00:00Z", "updatedAt": "2026-05-31T14:00:00Z", "thread": [],
    "resolution": { "by": "claude", "note": "Clarified: dead-letters without abandoning.", "at": "2026-05-31T14:00:00Z" } } ] }
```

Everything except `status`, `resolution`, `updatedAt`, and the file's `rev` is byte-unchanged.
