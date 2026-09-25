import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";

const MAX_BYTES = 256 * 1024;
const FILE = /(?<![\w@./])@(?:"([^"\n]+)"|'([^'\n]+)'|([^\s,;!?)}\]"'`]+))(?::(\d+)(?:-(\d+))?)?/g;

type File = { path: string; content: string; error: boolean };

async function readRange(filename: string, start: number, end: number, limit: number): Promise<Buffer> {
  const parts: Buffer[] = [];
  let total = 0;
  let line = 1;
  for await (const chunk of createReadStream(filename)) {
    for (let from = 0; from < chunk.length;) {
      const newline = chunk.indexOf(10, from);
      const to = newline < 0 ? chunk.length : newline + 1;
      if (line >= start) {
        const part = chunk.subarray(from, to);
        total += part.length;
        if (total > limit) throw new Error("exceeds 256 KiB request limit");
        parts.push(part);
      }
      if (newline < 0) break;
      line++;
      if (line > end) return Buffer.concat(parts, total);
      from = to;
    }
  }
  if (line < start) throw new Error("range starts after end of file");
  return Buffer.concat(parts, total);
}

async function prepare(text: string, cwd: string): Promise<File[]> {
  let remaining = MAX_BYTES;
  const files: File[] = [];
  const seen = new Set<string>();
  const markdown: { body: string; filename: string }[] = [];

  async function add(match: RegExpMatchArray, base: string, nested: boolean): Promise<void> {
    const suffix = match[3]?.match(/:(\d+)(?:-(\d+))?$/);
    const path = match[1] ?? match[2] ?? (suffix ? match[3].slice(0, -suffix[0].length) : match[3]);
    const startText = match[4] ?? suffix?.[1];
    const endText = match[5] ?? suffix?.[2];
    const range = startText === undefined ? undefined : [Number(startText), Number(endText ?? startText)] as const;
    const label = range ? `${path}:${startText}${endText === undefined ? "" : `-${endText}`}` : path;
    const filename = path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : resolve(base, path);
    const key = JSON.stringify([filename, startText, endText]);
    if (seen.has(key)) return;
    seen.add(key);
    let content: string;
    let body: string | undefined;
    let error = false;

    try {
      if (range && (!Number.isSafeInteger(range[0]) || !Number.isSafeInteger(range[1]) || range[0] < 1 || range[1] < range[0])) {
        throw new Error("invalid line range");
      }
      const info = await stat(filename);
      if (!info.isFile()) throw new Error("not a regular file");
      if (!range && info.size > remaining) throw new Error("exceeds 256 KiB request limit");
      const bytes = range ? await readRange(filename, range[0], range[1], remaining) : await readFile(filename);
      if (bytes.length > remaining) throw new Error("exceeds 256 KiB request limit");
      if (bytes.includes(0)) throw new Error("not UTF-8 text");
      body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      remaining -= bytes.length;
      content = `<file name=${JSON.stringify(label)}>\n${body}\n</file>`;
    } catch (cause) {
      error = true;
      const reason = cause instanceof Error && !('code' in cause) ? cause.message : "cannot read file";
      content = `<file name=${JSON.stringify(label)} error=${JSON.stringify(reason)} />`;
    }

    files.push({ path: label, content, error });
    if (!nested && body !== undefined && filename.toLowerCase().endsWith(".md")) {
      markdown.push({ body, filename });
    }
  }

  for (const match of text.matchAll(FILE)) await add(match, cwd, false);
  for (const { body, filename } of markdown) {
    for (const child of body.matchAll(FILE)) await add(child, dirname(filename), true);
  }
  return files;
}

function fileMessage(files: File[], queuedText?: string) {
  return {
    customType: "auto-inject",
    content: files.map((file) => file.content).join("\n"),
    display: true,
    details: { files: files.map(({ path, error }) => ({ path, error })), queuedText },
  };
}

export default function (pi: ExtensionAPI) {
  let pending: File[] = [];

  pi.registerMessageRenderer("auto-inject", (message, { expanded, outputPad }, theme) => {
    const files = (message.details as { files: Pick<File, "path" | "error">[] }).files;
    const title = `read ${files[0].path}${files.length > 1 ? ` (+${files.length - 1} files)` : ""}`;
    const color = files.some((file) => file.error) ? "toolErrorBg" : "toolSuccessBg";
    const box = new Box(outputPad, 1, (line) => theme.bg(color, line));
    const body = typeof message.content === "string" ? message.content : "";
    box.addChild(new Text(theme.fg("toolTitle", title) + (expanded ? `\n${body}` : ""), 0, 0));
    return box;
  });

  pi.on("input", async (event, ctx) => {
    pending = [];
    if (event.source === "extension" || !event.text.includes("@")) return { action: "continue" };
    const files = await prepare(event.text, ctx.cwd);
    if (event.streamingBehavior) {
      if (files.length) pi.sendMessage(fileMessage(files, event.text), { triggerTurn: false });
    } else {
      pending = files;
    }
    return { action: "continue" };
  });

  pi.on("before_agent_start", () => {
    if (pending.length === 0) return;
    const files = pending;
    pending = [];
    return { message: fileMessage(files) };
  });

  // Queued inputs skip before_agent_start. Hold their read results out of the current turn
  // until their matching user message arrives, without queueing a second model call.
  pi.on("context", (event) => {
    const waiting = new Map<string, { reads: number[]; users: number[] }>();
    event.messages.forEach((message, index) => {
      if (message.role === "custom" && message.customType === "auto-inject") {
        const text = (message.details as { queuedText?: string } | undefined)?.queuedText;
        if (text !== undefined) {
          const group = waiting.get(text) ?? { reads: [], users: [] };
          group.reads.push(index);
          waiting.set(text, group);
        }
      } else if (message.role === "user") {
        const text = typeof message.content === "string"
          ? message.content
          : message.content.map((block) => block.type === "text" ? block.text : "").join("");
        waiting.get(text)?.users.push(index);
      }
    });
    const hidden = new Set<number>();
    for (const { reads, users } of waiting.values()) {
      reads.forEach((index, order) => {
        if (users[order] === undefined || users[order] < index) hidden.add(index);
      });
    }
    if (hidden.size) return { messages: event.messages.filter((_, index) => !hidden.has(index)) };
  });
}
