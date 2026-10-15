import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Names that reserve a persisted window before an outbound request.
 * Add a new integration's reserve function here in the same change that calls it.
 */
export const RATE_GATES = [
  "acquire",
  "gcdPause",
  "reserveGcdRequest",
  "reserveComicVineRequest",
  "reserveCoverDownload",
  "reserveImageDownload",
  "reserveEbayRequest",
] as const;

const GATE = new RegExp(`\\b(?:${RATE_GATES.join("|")})\\s*\\(`);

/** The one helper that performs fetch after its caller has already reserved. */
const TRANSPORT = "loggedFetch";

export type SourceFile = { path: string; source: string };

export type UngatedFetch = { path: string; line: number; text: string };

type Range = { name: string | null; start: number; end: number };

function blankComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " ")).replace(/(^|[^:\\])\/\/.*$/gm, "$1");
}

function matchingBrace(source: string, open: number): number {
  let depth = 0;
  let quote: "'" | '"' | "`" | null = null;
  for (let i = open; i < source.length; i += 1) {
    const char = source[i] ?? "";
    if (quote) {
      if (char === "\\") {
        i += 1;
        continue;
      }
      if (quote === "`" && char === "$" && source[i + 1] === "{") {
        depth += 1;
        i += 1;
        quote = null;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return source.length - 1;
}

function bodyOpen(source: string, paren: number): number {
  let parenDepth = 0;
  let quote: "'" | '"' | "`" | null = null;
  for (let i = paren; i < source.length; i += 1) {
    const char = source[i] ?? "";
    if (quote) {
      if (char === "\\") {
        i += 1;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(") parenDepth += 1;
    else if (char === ")") {
      parenDepth -= 1;
      if (parenDepth === 0) {
        const brace = source.indexOf("{", i);
        return brace;
      }
    }
  }
  return -1;
}

function functionRanges(source: string): Range[] {
  const ranges: Range[] = [];
  const declared = /\b(?:async\s+)?function\s*\*?\s*([A-Za-z0-9_]+)?\s*\(/g;
  for (const match of source.matchAll(declared)) {
    const paren = match.index + match[0].length - 1;
    const open = bodyOpen(source, paren);
    if (open < 0) continue;
    ranges.push({ name: match[1] ?? null, start: open, end: matchingBrace(source, open) });
  }
  const arrows = /=>\s*\{/g;
  for (const match of source.matchAll(arrows)) {
    const open = match.index + match[0].lastIndexOf("{");
    ranges.push({ name: null, start: open, end: matchingBrace(source, open) });
  }
  return ranges;
}

function innermost(ranges: Range[], index: number): Range | null {
  let best: Range | null = null;
  for (const range of ranges) {
    if (index <= range.start || index >= range.end) continue;
    if (!best || range.start >= best.start) best = range;
  }
  return best;
}

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

function sameOrigin(source: string, openParen: number): boolean {
  let i = openParen + 1;
  while (i < source.length && /\s/.test(source[i] ?? "")) i += 1;
  const quote = source[i];
  if (quote !== "'" && quote !== '"' && quote !== "`") return false;
  i += 1;
  let head = "";
  while (i < source.length) {
    const char = source[i] ?? "";
    if (char === "\\") {
      head += source[i + 1] ?? "";
      i += 2;
      continue;
    }
    if (quote === "`" && char === "$") break;
    if (char === quote) break;
    head += char;
    i += 1;
  }
  return head.startsWith("/") && !head.startsWith("//") || head.startsWith("./") || head.startsWith("../");
}

function callsOf(source: string, pattern: RegExp): Array<{ index: number; paren: number; text: string }> {
  const found: Array<{ index: number; paren: number; text: string }> = [];
  for (const match of source.matchAll(pattern)) {
    const paren = match.index + match[0].length - 1;
    const line = source.slice(match.index, source.indexOf("\n", match.index));
    found.push({ index: match.index, paren, text: line.trim() });
  }
  return found;
}

/** External fetch() and loggedFetch() calls that never reserved a window. */
export function ungatedExternalFetches(files: SourceFile[]): UngatedFetch[] {
  const hits: UngatedFetch[] = [];
  const fetchCall = /(?:^|[^\w$])(?:[A-Za-z0-9_$.]+\.)?fetch(?:Impl)?\s*\(/g;
  const loggedCall = /(?:^|[^\w$])loggedFetch\s*\(/g;
  for (const file of files) {
    const source = blankComments(file.source);
    const ranges = functionRanges(source);
    const consider = [
      ...callsOf(source, fetchCall).map((call) => ({ ...call, transport: false })),
      ...callsOf(source, loggedCall).map((call) => ({ ...call, transport: true })),
    ];
    for (const call of consider) {
      if (/\bfunction\s*$/.test(source.slice(Math.max(0, call.index - 40), call.index))) continue;
      if (!call.transport && sameOrigin(source, call.paren)) continue;
      const scope = innermost(ranges, call.index);
      if (!call.transport && scope?.name === TRANSPORT) continue;
      const before = source.slice(scope?.start ?? 0, call.index);
      if (GATE.test(before)) continue;
      hits.push({ path: file.path, line: lineOf(source, call.index), text: call.text });
    }
  }
  return hits;
}

export function readSourceTree(root: string): SourceFile[] {
  const files: SourceFile[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) {
        if (name === "node_modules" || name === ".next") continue;
        walk(full);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(name)) continue;
      files.push({ path: path.relative(root, full).split(path.sep).join("/"), source: readFileSync(full, "utf8") });
    }
  };
  walk(path.join(root, "src"));
  return files;
}
