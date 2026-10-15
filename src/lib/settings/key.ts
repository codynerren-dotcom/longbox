import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseSecretKey } from "@/lib/settings/crypto";

export function secretKeyPath(dataDir = process.env.LONGBOX_DATA_DIR || process.env.COVERS_DIR || path.join(process.cwd(), "data", "covers")): string {
  return path.join(dataDir, "longbox-secret.key");
}

export function ensureSecretKey(options?: {
  envValue?: string | null;
  filePath?: string;
  read?: (filePath: string) => string | null;
  write?: (filePath: string, contents: string) => void;
  random?: (size: number) => Buffer;
}): Buffer {
  const envValue = (options?.envValue ?? process.env.LONGBOX_SECRET_KEY ?? "").trim();
  if (envValue) return parseSecretKey(envValue);

  const filePath = options?.filePath ?? secretKeyPath();
  const read = options?.read ?? readKeyFile;
  const write = options?.write ?? writeKeyFile;
  const random = options?.random ?? randomBytes;
  const existing = read(filePath)?.trim();
  if (existing) return parseSecretKey(existing);

  const generated = random(32).toString("base64");
  write(filePath, `${generated}\n`);
  return parseSecretKey(generated);
}

function readKeyFile(filePath: string): string | null {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function writeKeyFile(filePath: string, contents: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents, { mode: 0o600 });
}
