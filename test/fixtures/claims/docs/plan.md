# Plan: Export notes to Markdown (Spec 007)

This plan implements [Spec 007](spec.md). Export was the most requested feature in the 2026 user survey.

## What the code does today

- `server/Notes/NoteRenderer.cs` already converts note blocks to HTML, one block type per method.
- The SQLite store loads every note of a notebook in a single query, so export can call `ListNotes` once.
- `server/Notes/MarkdownWriter.cs` already writes Markdown for the copy-to-clipboard feature.
- The sync protocol ignores endpoints it does not know, so older clients are unaffected by new ones.

## Steps

1. Add a `MarkdownRenderer` next to `NoteRenderer` that converts note blocks to Markdown and copies each
   image file next to the exported `.md` file.
2. Add `POST /notes/{id}/export` and `POST /notebooks/{id}/export` to `api/openapi.yaml` and regenerate
   the client.
3. Add `ExportAll()` to the SQLite store; the Postgres store can follow in a later release.
4. Add an "Export as Markdown" item to the note menu, hidden when the user cannot read the note.
5. Rewrite the notebook page from scratch in the new component style so the export button fits.
6. Add a Markdown import command so users can round-trip their notes.
7. Add a plugin API so third parties can add more export formats later.
8. Patch `web/src/api-client.ts` by hand to add the export call until the generator is updated.
9. Stream notebook exports into the zip so 1,000 notes finish in under 10 seconds, and add a benchmark test.

## Rollout

Ship behind the `export` feature flag for one release, then remove the flag.
