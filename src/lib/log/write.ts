import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { redactString, redactValue } from "@/lib/log/redact";
import { retentionCutoff } from "@/lib/log/query";
import { isLogLevel, isLogSource, type LogInput } from "@/lib/log/types";
import { getPreferences } from "@/lib/settings/service";

const MAX_MESSAGE = 2000;
const MAX_DETAILS = 8000;
const PRUNE_INTERVAL_MS = 60_000;

let lastPrune = 0;
let pruning = false;

export function loggingEnabled(): boolean {
  return process.env.VITEST !== "true" && process.env.LONGBOX_LOG !== "off";
}

export async function writeLog(input: LogInput): Promise<void> {
  if (!loggingEnabled()) return;
  if (!isLogLevel(input.level) || !isLogSource(input.source)) return;
  const message = redactString(input.message).replace(/\s+/g, " ").trim().slice(0, MAX_MESSAGE);
  if (!message) return;
  try {
    await prisma.appLog.create({
      data: {
        level: input.level,
        source: input.source,
        message,
        details: detailsValue(input.details),
      },
    });
  } catch {
    return;
  }
  await pruneLogs(false);
}

export async function pruneLogs(force = false): Promise<number> {
  if (!loggingEnabled() || pruning) return 0;
  const now = Date.now();
  if (!force && now - lastPrune < PRUNE_INTERVAL_MS) return 0;
  pruning = true;
  lastPrune = now;
  try {
    const days = (await getPreferences()).logs.retentionDays;
    const result = await prisma.appLog.deleteMany({
      where: { createdAt: { lt: retentionCutoff(new Date(), days) } },
    });
    if (result.count > 0) {
      await prisma.appLog.create({
        data: {
          level: "debug",
          source: "system",
          message: `Pruned ${result.count} log events older than ${days} days.`,
          details: { retentionDays: days, pruned: result.count },
        },
      });
    }
    return result.count;
  } catch {
    return 0;
  } finally {
    pruning = false;
  }
}

export async function clearLogs(): Promise<void> {
  await prisma.appLog.deleteMany();
  await writeLog({ level: "info", source: "system", message: "Logs cleared." });
}

function detailsValue(value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  if (value == null) return Prisma.JsonNull;
  const redacted = redactValue(value);
  if (redacted == null) return Prisma.JsonNull;
  let json: string;
  try {
    json = JSON.stringify(redacted);
  } catch {
    return { truncated: true };
  }
  if (!json || json === "null") return Prisma.JsonNull;
  if (json.length <= MAX_DETAILS) return JSON.parse(json) as Prisma.InputJsonValue;
  return { truncated: true, preview: json.slice(0, 4000) };
}
