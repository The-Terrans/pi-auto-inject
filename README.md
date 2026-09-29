# pi-auto-inject

Type `@path` in a Pi prompt. File contents reach the model without a model-initiated `read` call.

## Try it

1. Install: `pi install npm:pi-auto-inject`
2. Start Pi in your project: `pi`
3. Send: `Summarize @README.md`

Your prompt keeps `@README.md`. The contents appear in a separate, read-like message, collapsed to three lines until expanded. This is a custom message, **not** a real `read` tool call.

## Choose what to include

- `@src/index.ts` — entire UTF-8 file.
- `@src/index.ts:9` — line 9 only (lines start at 1).
- `@src/index.ts:9-13` — lines 9 through 13, inclusive.
- `@"notes/meeting notes.md":9` — quote paths with spaces; ranges still work.
- `@src` — names of regular files directly inside `src`, **not** their contents. Skips subdirectories and symlinks.

Prompt paths resolve from Pi's working directory. Absolute paths and `~/` paths also work.

## Markdown and AGENTS.md

- A referenced `.md` file can contain `@` references. Those paths resolve relative to that Markdown file.
- Pi's automatically loaded `AGENTS.md` and `AGENTS.override.md` files expand their `@` references **once per session**, on the first prompt after they load. Paths resolve relative to each context file. Later prompts do not auto-inject them again; resumed sessions keep their earlier injection. The extension uses Pi's loaded text; it does not reread those context files.
- Expansion stops after **one level**: references inside additionally included files are not followed. With a line range, only selected Markdown lines are scanned.
- Duplicate references from the first prompt and loaded context files inject only once.
- Queued steering and follow-ups keep their `@` references; only references typed in the queued prompt are injected when it runs.

## Limits and privacy

- Each request has a shared **256 KiB limit** for file contents, selected lines, Markdown references, and directory listings.
- Missing, binary, oversized, or invalid references produce error markers rather than partial contents. Images are unsupported. Empty directories and line ranges on directories also produce errors.
- **Referenced contents can include secrets**, including files linked from Markdown or AGENTS files. Directory filenames also go to the model. Do not reference private files you do not want sent.

## Develop locally

```sh
pnpm install
pnpm test
pnpm dev
```

`pnpm dev` loads the extension only in that Pi process. To install this checkout persistently, run `pi install ./`.
