import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import extension from "../extensions/index.ts";

async function setup(run) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-auto-inject-"));
  const handlers = {};
  const renderers = {};
  const sent = [];
  extension({
    on(name, fn) { handlers[name] = fn; },
    registerMessageRenderer(name, fn) { renderers[name] = fn; },
    sendMessage(message, options) { sent.push({ message, options }); },
  });
  try {
    await run({
      cwd,
      input: (text, source = "interactive", streamingBehavior) => handlers.input({ text, source, streamingBehavior }, { cwd }),
      start: () => handlers.before_agent_start(),
      context: (messages) => handlers.context({ messages }),
      sent,
      render: (message, expanded) => renderers["auto-inject"](
        { content: message.content, details: message.details },
        { expanded, outputPad: 0 },
        { fg: (_color, text) => text, bg: (_color, text) => text },
      ).render(80).join("\n"),
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

test("keeps prompt clean and puts multiple files in a separate model-visible message", async () => {
  await setup(async ({ cwd, input, start, render }) => {
    await writeFile(join(cwd, "one.txt"), "first");
    await writeFile(join(cwd, "two words.txt"), "second\nline");
    const result = await input('Compare @one.txt, @"two words.txt"! Email me@host.com.');
    assert.deepEqual(result, { action: "continue" });
    const { message } = start();
    assert.equal(message.customType, "auto-inject");
    assert.equal(message.display, true);
    assert.equal(message.content, '<file name="one.txt">\nfirst\n</file>\n<file name="two words.txt">\nsecond\nline\n</file>');
    assert.match(render(message, false), /read one\.txt \(\+1 files\)/);
    assert.equal(render(message, false).split("\n").length, 3);
    assert.equal(render(message, false).includes("first"), false);
    assert.match(render(message, true), /first/);
    assert.equal(start(), undefined);
  });
});

test("line ranges select inclusive lines and keep references unchanged", async () => {
  await setup(async ({ cwd, input, start, render }) => {
    await writeFile(join(cwd, "package.json"), "one\ntwo\nthree\nfour");
    await writeFile(join(cwd, "two words.txt"), "first\nsecond\nthird");
    assert.deepEqual(await input('Compare @package.json:2-3 and @"two words.txt":2-2'), { action: "continue" });
    const { message } = start();
    assert.equal(message.content, '<file name="package.json:2-3">\ntwo\nthree\n\n</file>\n<file name="two words.txt:2-2">\nsecond\n\n</file>');
    assert.match(render(message, false), /read package\.json:2-3/);
    assert.doesNotMatch(message.content, /first|four/);
  });
});

test("single-line references inject just that line, including quoted paths", async () => {
  await setup(async ({ cwd, input, start, render }) => {
    await mkdir(join(cwd, "extensions"));
    await writeFile(join(cwd, "extensions", "index.ts"), Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n"));
    await writeFile(join(cwd, "two words.txt"), "first\nsecond\nthird");
    assert.deepEqual(await input('Check @extensions/index.ts:9 and @"two words.txt":2'), { action: "continue" });
    const { message } = start();
    assert.equal(message.content, '<file name="extensions/index.ts:9">\nline 9\n\n</file>\n<file name="two words.txt:2">\nsecond\n\n</file>');
    assert.match(render(message, false), /read extensions\/index\.ts:9/);
  });
});

test("ranges work on large files but still enforce selected-byte limit", async () => {
  await setup(async ({ cwd, input, start }) => {
    await writeFile(join(cwd, "huge.txt"), `${"x".repeat(256 * 1024 + 1)}\nselected\n${"y".repeat(256 * 1024 + 1)}`);
    assert.deepEqual(await input("@huge.txt:2-2 @huge.txt:1-1"), { action: "continue" });
    const { message } = start();
    assert.match(message.content, /<file name="huge\.txt:2-2">\nselected\n\n<\/file>/);
    assert.match(message.content, /name="huge\.txt:1-1" error="exceeds 256 KiB request limit"/);
  });
});

test("invalid or out-of-bounds ranges show errors", async () => {
  await setup(async ({ cwd, input, start }) => {
    await writeFile(join(cwd, "one.txt"), "first\nsecond");
    assert.deepEqual(await input("@one.txt:0 @one.txt:0-1 @one.txt:2-1 @one.txt:9007199254740993-9007199254740994 @one.txt:4 @one.txt:4-5"), { action: "continue" });
    const { message } = start();
    assert.match(message.content, /name="one\.txt:0" error="invalid line range"/);
    assert.match(message.content, /name="one\.txt:0-1" error="invalid line range"/);
    assert.match(message.content, /name="one\.txt:2-1" error="invalid line range"/);
    assert.match(message.content, /name="one\.txt:9007199254740993-9007199254740994" error="invalid line range"/);
    assert.match(message.content, /name="one\.txt:4" error="range starts after end of file"/);
    assert.match(message.content, /name="one\.txt:4-5" error="range starts after end of file"/);
  });
});

test("absolute and missing paths show separate read and error results", async () => {
  await setup(async ({ cwd, input, start, render }) => {
    const path = join(cwd, "absolute.txt");
    await writeFile(path, "absolute");
    const result = await input(`Read @${path} and @missing.txt`);
    assert.deepEqual(result, { action: "continue" });
    const { message } = start();
    assert.match(message.content, /<file name="\/.*absolute\.txt">\nabsolute\n<\/file>/);
    assert.match(message.content, /<file name="missing\.txt" error="cannot read file" \/>/);
    assert.match(render(message, false), /read .*absolute\.txt/);
  });
});

test("directory references produce an error, not recursive contents", async () => {
  await setup(async ({ cwd, input, start }) => {
    await mkdir(join(cwd, "folder"));
    await writeFile(join(cwd, "folder", "secret.txt"), "not injected");
    assert.deepEqual(await input("Read @folder"), { action: "continue" });
    const { message } = start();
    assert.equal(message.content, '<file name="folder" error="not a regular file" />');
    assert.equal(message.content.includes("not injected"), false);
  });
});

test("rejects binary and oversized files without filling prompt", async () => {
  await setup(async ({ cwd, input, start }) => {
    await writeFile(join(cwd, "binary"), Buffer.from([0, 255]));
    await writeFile(join(cwd, "big"), "x".repeat(256 * 1024 + 1));
    assert.deepEqual(await input("@binary @big"), { action: "continue" });
    const { message } = start();
    assert.match(message.content, /name="binary" error="not UTF-8 text"/);
    assert.match(message.content, /name="big" error="exceeds 256 KiB request limit"/);
  });
});

test("queued follow-ups and steering keep @ unchanged, without another model call", async () => {
  await setup(async ({ cwd, input, start, context, sent }) => {
    await writeFile(join(cwd, "one.txt"), "first\nsecond");
    for (const behavior of ["steer", "followUp"]) {
      assert.deepEqual(await input("Check @one.txt:2", "interactive", behavior), { action: "continue" });
      assert.equal(start(), undefined);
    }
    assert.equal(sent.length, 2);
    for (const { message, options } of sent) {
      assert.deepEqual(options, { triggerTurn: false });
      assert.match(message.content, /second/);
      assert.doesNotMatch(message.content, /first/);
    }
    const queued = sent.map(({ message }) => ({ ...message, role: "custom" }));
    const current = { role: "user", content: "Check @one.txt:2" };
    assert.deepEqual(context([current, ...queued]).messages, [current]);
    const followUp = { role: "user", content: [{ type: "text", text: "Check @one.txt:2" }] };
    assert.deepEqual(context([current, ...queued, followUp]).messages, [current, queued[0], followUp]);
    const steering = { role: "user", content: "Check @one.txt:2" };
    assert.equal(context([current, ...queued, followUp, steering]), undefined);
  });
});

test("messages without file references and extension-authored messages remain unchanged", async () => {
  await setup(async ({ cwd, input, start }) => {
    await writeFile(join(cwd, "one.txt"), "first");
    assert.deepEqual(await input("@one.txt"), { action: "continue" });
    assert.deepEqual(await input("Email me@host.com"), { action: "continue" });
    assert.deepEqual(await input("@one.txt", "extension"), { action: "continue" });
    assert.equal(start(), undefined);
  });
});
