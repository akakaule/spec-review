# Spec 007: Export notes to Markdown

| | |
|---|---|
| **Status** | Approved |
| **Owner** | Notebook team |

Users keep asking for a way to get their notes out of Notebook. This spec adds a Markdown export.

## Goals

- A user can export one note as a Markdown file from the note's menu.
- A user can export a whole notebook as a zip of Markdown files.
- Exported files keep headings, lists, links and images.

## Non-goals

- No import from Markdown.
- No new storage backends.
- No changes to the sync protocol.

## Acceptance criteria

- Exporting a note with an image produces the `.md` file and the image file next to it.
- Exporting a notebook with 1,000 notes completes in under 10 seconds.
- The export menu item is hidden for notes the user cannot read.
- Exported files are named after the note title, with characters that are unsafe in file names replaced.

## Compatibility

- Older clients that do not know the export endpoints keep working.
