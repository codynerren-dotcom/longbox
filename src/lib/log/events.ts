import type { ImportSummary } from "@/lib/clz/persist";
import type { BackfillSummary } from "@/lib/covers/backfill";
import { writeLog } from "@/lib/log/write";

const WARNING_CAP = 40;

export async function logImportStarted(filename: string): Promise<void> {
  await writeLog({
    level: "info",
    source: "import",
    message: `Import started: ${filename}`,
    details: { filename },
  });
}

export async function logImportFinished(filename: string, summary: ImportSummary, warnings: string[]): Promise<void> {
  await writeLog({
    level: "info",
    source: "import",
    message: `Import finished: ${summary.rows} rows, ${summary.created} created, ${summary.updated} updated, ${summary.collapsed} collapsed, ${summary.retired} retired.`,
    details: { filename, ...summary, warningCount: warnings.length },
  });
  const shown = warnings.slice(0, WARNING_CAP);
  for (const warning of shown) {
    await writeLog({ level: "warn", source: "import", message: warning, details: { filename } });
  }
  if (warnings.length > shown.length) {
    await writeLog({
      level: "warn",
      source: "import",
      message: `${warnings.length - shown.length} more import row warnings were omitted.`,
      details: { filename, warningCount: warnings.length },
    });
  }
}

export async function logImportFailed(filename: string, message: string): Promise<void> {
  await writeLog({ level: "error", source: "import", message, details: { filename } });
}

export async function logCoverStarted(total: number): Promise<void> {
  await writeLog({
    level: "info",
    source: "covers/backfill",
    message: `Cover backfill started for ${total} issues.`,
    details: { total },
  });
}

export async function logCoverFinished(summary: BackfillSummary): Promise<void> {
  await writeLog({
    level: summary.stoppedReason ? "warn" : "info",
    source: "covers/backfill",
    message: `Cover backfill finished: ${summary.matched} matched, ${summary.unmatched} unmatched, ${summary.skipped} skipped.`,
    details: summary,
  });
}

export async function logEnrichStarted(total: number): Promise<void> {
  await writeLog({
    level: "info",
    source: "covers/backfill",
    message: `Metron enrichment started for ${total} matched issues.`,
    details: { total },
  });
}

export async function logEnrichFinished(summary: { filled: number; unchanged: number; failed: number; stoppedReason: string | null }): Promise<void> {
  await writeLog({
    level: summary.stoppedReason ? "warn" : "info",
    source: "covers/backfill",
    message: `Metron enrichment finished: ${summary.filled} filled, ${summary.unchanged} unchanged, ${summary.failed} failed.`,
    details: summary,
  });
}

export async function logMetronFill(label: string, metronIssueId: string, fields: string[]): Promise<void> {
  await writeLog({
    level: "info",
    source: "metron",
    message:
      fields.length > 0
        ? `Filled ${fields.join(", ")} on ${label} from Metron ${metronIssueId}.`
        : `${label} had nothing missing on Metron ${metronIssueId}.`,
    details: { metronIssueId, fields },
  });
}

export async function logCoverProgress(summary: BackfillSummary): Promise<void> {
  const checked = summary.matched + summary.unmatched;
  await writeLog({
    level: "info",
    source: "covers/backfill",
    message: `Cover backfill progress: ${checked} checked, ${summary.matched} matched, ${summary.unmatched} unmatched.`,
    details: summary,
  });
}

export async function logSettingsChange(keys: string[], action: "Updated" | "Cleared" = "Updated"): Promise<void> {
  const unique = [...new Set(keys.map((key) => key.trim()).filter(Boolean))];
  if (unique.length === 0) return;
  await writeLog({
    level: "info",
    source: "settings",
    message: `${action} ${unique.join(", ")}`,
    details: { keys: unique },
  });
}

export async function logConnectionTest(service: string, result: { ok: boolean; message: string }): Promise<void> {
  await writeLog({
    level: result.ok ? "info" : "warn",
    source: "settings",
    message: result.ok ? `Connection test succeeded for ${service}.` : `Connection test failed for ${service}.`,
    details: { service, ok: result.ok, message: result.message },
  });
}

export async function logScanLookup(args: {
  kind: "barcode" | "search";
  query: string;
  parsed?: boolean;
  owned?: boolean;
  matches: number;
  warnings: string[];
}): Promise<void> {
  const query = args.query.trim().slice(0, 120);
  const message =
    args.kind === "barcode"
      ? args.parsed === false
        ? "Barcode could not be parsed."
        : args.owned
          ? `Barcode ${query} is already on the shelf.`
          : `Barcode lookup returned ${args.matches} match(es).`
      : `Catalog search for ${query || "a blank query"} returned ${args.matches} match(es).`;
  await writeLog({
    level: args.kind === "barcode" && args.parsed === false ? "warn" : "info",
    source: "scan",
    message,
    details: {
      kind: args.kind,
      query,
      parsed: args.parsed,
      owned: args.owned,
      matches: args.matches,
      warnings: args.warnings.slice(0, 10),
    },
  });
}

export async function logScanAdd(args: { requested: number; created: number; existing: number }): Promise<void> {
  await writeLog({
    level: "info",
    source: "scan",
    message: `Scan add stored ${args.created} new comic(s); ${args.existing} already on the shelf.`,
    details: args,
  });
}
