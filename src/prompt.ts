// Turns what the user typed and attached into OpenCode prompt files.
//
// `@path` and `@path#L3-9` in the text become file attachments whose
// `mention` points at that span, so the model sees which words refer to
// which file. OpenCode rejects the whole prompt when one attachment cannot be
// read, so paths that do not exist stay plain text. Pure apart from the
// injected `exists`, so it is unit-tested.

import { accessSync, constants, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import type { PromptFile } from "./server/api";
import type { Attachment } from "../shared/protocol";

export interface Mention {
  start: number;
  end: number;
  text: string;
  path: string;
  range?: { start: number; end: number };
}

// "@" at the start or after whitespace/an opening bracket; trailing sentence
// punctuation is not part of the path.
// "\ " is an escaped space inside a path, as the composer inserts them.
const MENTION = /(^|[\s([{"'`])@((?:\\ |[^\s@#()[\]{}"'`\\])+?)(?:#L(\d+)(?:-L?(\d+))?)?(?=$|[\s,;:!?)\]}"'`]|\.(?:\s|$))/g;

export function findMentions(text: string): Mention[] {
  const out: Mention[] = [];
  for (const m of text.matchAll(MENTION)) {
    const start = m.index! + m[1].length;
    const token = m[0].slice(m[1].length);
    const a = m[3] ? Number(m[3]) : undefined;
    const b = m[4] ? Number(m[4]) : a;
    out.push({
      start,
      end: start + token.length,
      text: token,
      path: m[2].replace(/\\ /g, " "),
      ...(a ? { range: { start: Math.min(a, b!), end: Math.max(a, b!) } } : {}),
    });
  }
  return out;
}

/** OpenCode refuses files over this, before applying a line range. */
export const MAX_ATTACHMENT = 20 * 1024 * 1024;

/**
 * Whether OpenCode can attach this path: a directory (it lists it) or a
 * readable regular file under the size cap. Anything else would make the
 * server reject the whole prompt.
 */
export function attachable(abs: string): boolean {
  try {
    const st = statSync(abs);
    if (!st.isDirectory() && !(st.isFile() && st.size <= MAX_ATTACHMENT)) return false;
    accessSync(abs, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export function fileUri(abs: string, range?: { start: number; end: number }): string {
  const u = pathToFileURL(abs).toString();
  return range ? `${u}?start=${range.start}&end=${range.end}` : u;
}

export function displayName(rel: string, range?: { start: number; end: number }): string {
  return range ? `${rel}#L${range.start}${range.end !== range.start ? `-${range.end}` : ""}` : rel;
}

export interface BuildInput {
  text: string;
  root: string;
  attachments?: Attachment[];
  /** The active editor, attached when the user left its chip on. */
  active?: { path: string; range?: { start: number; end: number } };
  exists(abs: string): boolean;
}

export function buildPromptFiles(input: BuildInput): PromptFile[] {
  const files: PromptFile[] = [];
  const seen = new Set<string>();
  const abs = (p: string) => (isAbsolute(p) ? p : join(input.root, p));
  const relName = (a: string) => {
    const r = relative(input.root, a);
    return r && !r.startsWith("..") && !isAbsolute(r) ? r : a;
  };
  const add = (path: string, range: { start: number; end: number } | undefined, mention?: PromptFile["mention"]) => {
    const a = abs(path);
    const uri = fileUri(a, range);
    if (seen.has(uri) || !input.exists(a)) return;
    seen.add(uri);
    files.push({ uri, name: displayName(relName(a), range), ...(mention ? { mention } : {}) });
  };
  for (const m of findMentions(input.text)) add(m.path, m.range, { start: m.start, end: m.end, text: m.text });
  for (const a of input.attachments ?? []) {
    if (a.kind === "file") add(a.path, a.range);
    else if (/^data:image\/[\w.+-]+;base64,/.test(a.dataUrl)) files.push({ uri: a.dataUrl, name: a.name });
  }
  if (input.active) add(input.active.path, input.active.range);
  return files;
}
