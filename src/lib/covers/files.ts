import "server-only";

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { recordFetch } from "@/lib/log/api";
import path from "node:path";
import { noteCoverPause, reserveCoverDownload } from "@/lib/catalog/rate-gate";
import { normalizeMetronBudget, pauseLabel } from "@/lib/catalog/rate-limit";
import { emptyBudget, retryAfterFromMessage, retryAfterMs, type BudgetStore, type MetronBudget } from "@/lib/covers/limiter";

const COVER_KEY = /^\d+(?:-[a-f0-9]{8})?$/;
const CATALOG_FILE = "(?:metron|cv)-\\d+(?:-[a-f0-9]{8})?\\.(?:jpg|jpeg|png|webp|gif)";
const USER_FILE = "user-[a-z0-9]{20,32}\\.webp";
const USER_ORIGINAL = "user-[a-z0-9]{20,32}-original\\.(?:jpg|png|webp|heic|heif)";
const PUBLIC_COVER = new RegExp(`^(?:${CATALOG_FILE}|${USER_FILE})$`);
const STORED_COVER = new RegExp(`^(?:${CATALOG_FILE}|${USER_FILE}|${USER_ORIGINAL})$`);
const COMIC_ID = /^[a-z0-9]{20,32}$/;
const ORIGINAL_EXT = /^(?:jpg|png|webp|heic|heif)$/;
export type CoverPrefix = "metron" | "cv";
const EXTENSIONS = ["jpg", "jpeg", "png", "webp", "gif"] as const;
const LOCK_NAME = "backfill.lock";
const BUDGET_NAME = "metron-budget.json";
const STATUS_NAME = "backfill-status.json";
const STALE_LOCK_MS = 2 * 60 * 60 * 1000;
export const COVER_MAX_BYTES = 15 * 1024 * 1024;

export type BackfillStatus = {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  matched: number;
  unmatched: number;
  skipped: number;
  pending: number;
  stoppedReason: string | null;
  message: string | null;
  task?: "covers" | "enrich" | null;
};

export function coversDir(): string {
  return process.env.COVERS_DIR || path.join(process.cwd(), "data", "covers");
}

/** Default cover keeps the issue id. A chosen variant image gets a stable suffix so it does not replace the default file. */
export function coverFileKey(issueId: string, imageUrl: string, primaryUrl: string | null): string {
  if (!/^\d+$/.test(issueId)) throw new Error("Issue id must be digits.");
  if (!primaryUrl || imageUrl === primaryUrl) return issueId;
  return `${issueId}-${createHash("sha1").update(imageUrl).digest("hex").slice(0, 8)}`;
}

export function coverFilename(issueKey: string, ext: string, prefix: CoverPrefix = "metron"): string {
  if (!COVER_KEY.test(issueKey)) throw new Error("Cover id must be digits.");
  const clean = ext.toLowerCase().replace(/^\./, "");
  if (!EXTENSIONS.includes(clean as (typeof EXTENSIONS)[number])) throw new Error("Unsupported cover type.");
  return `${prefix}-${issueKey}.${clean === "jpeg" ? "jpg" : clean}`;
}

export function userCoverFilename(comicId: string): string {
  if (!COMIC_ID.test(comicId)) throw new Error("Could not store the cover.");
  return `user-${comicId}.webp`;
}

export function userOriginalFilename(comicId: string, ext: string): string {
  if (!COMIC_ID.test(comicId)) throw new Error("Could not store the cover.");
  const clean = ext.toLowerCase().replace(/^\./, "");
  if (!ORIGINAL_EXT.test(clean)) throw new Error("Unsupported cover type.");
  return `user-${comicId}-original.${clean}`;
}

export function coverContentType(filename: string): string | null {
  if (!PUBLIC_COVER.test(filename)) return null;
  if (filename.endsWith(".png")) return "image/png";
  if (filename.endsWith(".webp")) return "image/webp";
  if (filename.endsWith(".gif")) return "image/gif";
  return "image/jpeg";
}

export function coverFilePath(dir: string, filename: string): string | null {
  if (!STORED_COVER.test(filename)) return null;
  const root = path.resolve(dir);
  const resolved = path.resolve(root, filename);
  if (resolved !== path.join(root, filename)) return null;
  return resolved;
}

export function fileBudgetStore(dir = coversDir()): BudgetStore {
  const file = path.join(dir, BUDGET_NAME);
  return {
    read(): MetronBudget {
      try {
        return normalizeMetronBudget(JSON.parse(readFileSync(file, "utf8")));
      } catch {
        return emptyBudget();
      }
    },
    write(budget: MetronBudget) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, JSON.stringify(budget));
    },
  };
}

export function readBackfillStatus(dir = coversDir()): BackfillStatus | null {
  try {
    return JSON.parse(readFileSync(path.join(dir, STATUS_NAME), "utf8")) as BackfillStatus;
  } catch {
    return null;
  }
}

export function writeBackfillStatus(status: BackfillStatus, dir = coversDir()): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, STATUS_NAME), JSON.stringify(status));
}

export function acquireBackfillLock(dir = coversDir()): boolean {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, LOCK_NAME);
  const payload = `${process.pid}\n${Date.now()}\n`;
  try {
    writeFileSync(file, payload, { flag: "wx" });
    return true;
  } catch {
    try {
      const stat = statSync(file);
      if (Date.now() - stat.mtimeMs <= STALE_LOCK_MS) return false;
      unlinkSync(file);
      writeFileSync(file, payload, { flag: "wx" });
      return true;
    } catch {
      return false;
    }
  }
}

export function backfillLockHeld(dir = coversDir()): boolean {
  try {
    const stat = statSync(path.join(dir, LOCK_NAME));
    return Date.now() - stat.mtimeMs <= STALE_LOCK_MS;
  } catch {
    return false;
  }
}

export function releaseBackfillLock(dir = coversDir()): void {
  try {
    unlinkSync(path.join(dir, LOCK_NAME));
  } catch {
    // The lock is already gone.
  }
}

export function existingCoverFile(dir: string, issueKey: string, prefix: CoverPrefix = "metron"): string | null {
  if (!COVER_KEY.test(issueKey)) return null;
  for (const ext of ["jpg", "png", "webp", "gif"] as const) {
    const filename = `${prefix}-${issueKey}.${ext}`;
    try {
      if (statSync(path.join(dir, filename)).size > 0) return filename;
    } catch {
      // Try the next extension.
    }
  }
  return null;
}

function extensionFor(contentType: string, imageUrl: string): string | null {
  const type = contentType.toLowerCase();
  if (type.includes("png")) return "png";
  if (type.includes("webp")) return "webp";
  if (type.includes("gif")) return "gif";
  if (type.includes("jpeg") || type.includes("jpg")) return "jpg";
  try {
    const pathname = new URL(imageUrl).pathname.toLowerCase();
    if (pathname.endsWith(".png")) return "png";
    if (pathname.endsWith(".webp")) return "webp";
    if (pathname.endsWith(".gif")) return "gif";
    if (pathname.endsWith(".jpg") || pathname.endsWith(".jpeg")) return "jpg";
  } catch {
    return null;
  }
  return null;
}

export async function downloadCover(
  imageUrl: string,
  issueKey: string,
  dir = coversDir(),
  options?: { force?: boolean; prefix?: CoverPrefix },
): Promise<string> {
  const prefix = options?.prefix ?? "metron";
  if (!options?.force) {
    const existing = existingCoverFile(dir, issueKey, prefix);
    if (existing) return existing;
  }
  let parsed: URL;
  try {
    parsed = new URL(imageUrl);
  } catch {
    throw new Error("Cover image URL is invalid.");
  }
  if (parsed.protocol === "http:") parsed.protocol = "https:";
  if (parsed.protocol !== "https:") throw new Error("Cover image URL is not https.");

  await reserveCoverDownload();
  const started = Date.now();
  let response: Response;
  try {
    response = await fetch(parsed, { signal: AbortSignal.timeout(20_000), redirect: "follow" });
  } catch (error) {
    await recordFetch({
      source: "covers/backfill",
      url: parsed.toString(),
      startedAt: started,
      status: null,
      error: error instanceof Error ? error.message : "Request failed.",
    });
    throw error;
  }
  await recordFetch({ source: "covers/backfill", url: parsed.toString(), startedAt: started, status: response.status });
  if (response.status === 429 || response.status === 420) {
    const body = await response.text().catch(() => "");
    const delay = retryAfterMs(response.headers, Date.now()) ?? retryAfterFromMessage(body) ?? 60_000;
    const resumeAt = Date.now() + delay;
    await noteCoverPause(resumeAt);
    throw new Error(pauseLabel("Cover download", resumeAt));
  }
  if (!response.ok) throw new Error(`Cover image returned ${response.status}.`);
  const ext = extensionFor(response.headers.get("content-type") ?? "", parsed.toString());
  if (!ext) throw new Error("Cover image is not a jpeg, png, webp, or gif.");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0 || bytes.length > COVER_MAX_BYTES) throw new Error("Cover image is empty or too large.");

  const filename = coverFilename(issueKey, ext, prefix);
  const destination = coverFilePath(dir, filename);
  if (!destination) throw new Error("Could not store the cover.");
  await mkdir(dir, { recursive: true });
  const temporary = `${destination}.partial`;
  await writeFile(temporary, bytes);
  await rename(temporary, destination);
  return filename;
}

export async function readCoverBytes(dir: string, filename: string): Promise<Buffer | null> {
  const resolved = coverFilePath(dir, filename);
  if (!resolved) return null;
  try {
    return await readFile(resolved);
  } catch {
    return null;
  }
}

export async function writeUserCoverFiles(args: {
  comicId: string;
  original: Buffer;
  webp: Buffer;
  ext: string;
  dir?: string;
}): Promise<{ coverFile: string; originalFile: string }> {
  const dir = args.dir ?? coversDir();
  const coverFile = userCoverFilename(args.comicId);
  const originalFile = userOriginalFilename(args.comicId, args.ext);
  const coverPath = coverFilePath(dir, coverFile);
  const originalPath = coverFilePath(dir, originalFile);
  if (!coverPath || !originalPath) throw new Error("Could not store the cover.");
  await mkdir(dir, { recursive: true });
  await writeAtomic(originalPath, args.original);
  await writeAtomic(coverPath, args.webp);
  for (const ext of ["jpg", "png", "webp", "heic", "heif"] as const) {
    if (`user-${args.comicId}-original.${ext}` === originalFile) continue;
    const stale = coverFilePath(dir, `user-${args.comicId}-original.${ext}`);
    if (!stale) continue;
    await unlink(stale).catch(() => undefined);
  }
  return { coverFile, originalFile };
}

async function writeAtomic(destination: string, bytes: Buffer): Promise<void> {
  const temporary = `${destination}.partial`;
  await writeFile(temporary, bytes);
  await rename(temporary, destination);
}

export function coverExists(dir: string, filename: string): boolean {
  const resolved = coverFilePath(dir, filename);
  if (!resolved) return false;
  try {
    return statSync(resolved).size > 0;
  } catch {
    return false;
  }
}
