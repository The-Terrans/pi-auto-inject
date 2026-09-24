import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";

const MAX_BYTES = 256 * 1024;
const FILE = /(?<![\w@./])@(?:"([^"\n]+)"|'([^'\n]+)'|([^\s,;!?)}\]"'`]+))/g;

type File = { path: string; content: string; error: boolean };

async function prepare(text: string, cwd: string): Promise<File[]> {
  let remaining = MAX_BYTES;
  const files: File[] = [];

  for (const match of text.matchAll(FILE)) {
    const path = match[1] ?? match[2] ?? match[3];
    const filename = path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : resolve(cwd, path);
    let content: string;
    let error = false;

    try {
      const info = await stat(filename);
      if (!info.isFile()) throw new Error("not a regular file");
      if (info.size > remaining) throw new Error("exceeds 256 KiB request limit");
      const bytes = await readFile(filename);
      if (bytes.length > remaining) throw new Error("exceeds 256 KiB request limit");
      if (bytes.includes(0)) throw new Error("not UTF-8 text");
      const body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      remaining -= bytes.length;
      content = `<file name=${JSON.stringify(path)}>\n${body}\n</file>`;
    } catch (cause) {
      error = true;
      const reason = cause instanceof Error && !('code' in cause) ? cause.message : "cannot read file";
      content = `<file name=${JSON.stringify(path)} error=${JSON.stringify(reason)} />`;
    }

    files.push({ path, content, error });
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
