import { mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { recordFetch } from "@/lib/log/api";
import path from "node:path";
import { emptyBudget, type BudgetStore, type MetronBudget } from "@/lib/covers/limiter";

const COVER_NAME = /^metron-\d+\.(?:jpg|jpeg|png|webp|gif)$/;
const EXTENSIONS = ["jpg", "jpeg", "png", "webp", "gif"] as const;
const LOCK_NAME = "backfill.lock";
const BUDGET_NAME = "metron-budget.json";
const STATUS_NAME = "backfill-status.json";
const STALE_LOCK_MS = 2 * 60 * 60 * 1000;
const MAX_BYTES = 15 * 1024 * 1024;

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
};

export function coversDir(): string {
  return process.env.COVERS_DIR || path.join(process.cwd(), "data", "covers");
}

export function coverFilename(metronIssueId: string, ext: string): string {
  if (!/^\d+$/.test(metronIssueId)) throw new Error("Metron issue id must be digits.");
  const clean = ext.toLowerCase().replace(/^\./, "");
  if (!EXTENSIONS.includes(clean as (typeof EXTENSIONS)[number])) throw new Error("Unsupported cover type.");
  return `metron-${metronIssueId}.${clean === "jpeg" ? "jpg" : clean}`;
}

export function coverContentType(filename: string): string | null {
  if (!COVER_NAME.test(filename)) return null;
  if (filename.endsWith(".png")) return "image/png";
  if (filename.endsWith(".webp")) return "image/webp";
  if (filename.endsWith(".gif")) return "image/gif";
  return "image/jpeg";
}

export function coverFilePath(dir: string, filename: string): string | null {
  if (!COVER_NAME.test(filename)) return null;
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
        const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<MetronBudget>;
        return {
          day: typeof parsed.day === "string" ? parsed.day : "",
          count: typeof parsed.count === "number" && parsed.count > 0 ? parsed.count : 0,
          lastRequestAt: typeof parsed.lastRequestAt === "number" ? parsed.lastRequestAt : null,
        };
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

export function existingCoverFile(dir: string, metronIssueId: string): string | null {
  if (!/^\d+$/.test(metronIssueId)) return null;
  for (const ext of ["jpg", "png", "webp", "gif"] as const) {
    const filename = `metron-${metronIssueId}.${ext}`;
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

export async function downloadCover(imageUrl: string, metronIssueId: string, dir = coversDir()): Promise<string> {
  const existing = existingCoverFile(dir, metronIssueId);
  if (existing) return existing;
  let parsed: URL;
  try {
    parsed = new URL(imageUrl);
  } catch {
    throw new Error("Cover image URL is invalid.");
  }
  if (parsed.protocol === "http:") parsed.protocol = "https:";
  if (parsed.protocol !== "https:") throw new Error("Cover image URL is not https.");

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
  if (!response.ok) throw new Error(`Cover image returned ${response.status}.`);
  const ext = extensionFor(response.headers.get("content-type") ?? "", parsed.toString());
  if (!ext) throw new Error("Cover image is not a jpeg, png, webp, or gif.");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0 || bytes.length > MAX_BYTES) throw new Error("Cover image is empty or too large.");

  const filename = coverFilename(metronIssueId, ext);
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

export function coverExists(dir: string, filename: string): boolean {
  const resolved = coverFilePath(dir, filename);
  if (!resolved) return false;
  try {
    return statSync(resolved).size > 0;
  } catch {
    return false;
  }
}
