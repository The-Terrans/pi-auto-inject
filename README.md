# pi-auto-inject

Pi extension project for automatically injecting contents of files referenced with `@path` into user requests, instead of leaving references for the model to read later.

Use `@path` anywhere in a prompt to send UTF-8 file contents to the model as a separate, read-like message:

```text
Summarize @src/index.ts:10-13 and @"notes/meeting notes.md"
```

Prompt stays unchanged, including `@` references. File contents appear in a separate read-like message, three lines tall when collapsed; expand to see contents. This is a custom message, not an actual `read` tool call. Queued steering and follow-ups also keep `@` references unchanged; their file contents become visible to the model only when their queued prompt runs.

Use `@extensions/index.ts:9` for one line or `@package.json:10-13` for inclusive, 1-based line range; quoted paths also accept suffix (`@"my file.txt":9`). Both forms read only selected lines, even from large files. Prompt paths resolve from Pi's working directory; absolute paths and `~/` paths work too. When a referenced `.md` file is read, its `@` references (including ranges) are injected as additional files, relative to that Markdown file's directory. This is **one level only**: references inside those additional files are not followed. Only injected Markdown text is scanned, so `@` references in selected-out lines are ignored. `@dir` sends only names of immediate regular files in name order (for example, `dir/a.txt`); it does not read their contents. Subdirectories and symlinks are skipped. Empty directories and line ranges on directories produce error markers. Missing, binary, and oversized files also produce error markers. Total injected text, including directory listings and Markdown references, is limited to 256 KiB per request. Images are not supported. Directory filenames and explicitly referenced file contents, including secrets linked from Markdown, are sent to the model.

## Development

```sh
pnpm install
pnpm test
pnpm dev
```

`pnpm dev` loads the extension for that Pi process only. Use `pi install ./` for a persistent local install.
