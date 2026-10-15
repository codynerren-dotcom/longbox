import type { ImportSummary } from "@/lib/clz/persist";
import { prisma } from "@/lib/db";

export async function recordImportRun(entry: { filename: string; source: "upload" | "cli"; summary: ImportSummary }): Promise<void> {
  await prisma.importRun.create({
    data: {
      filename: entry.filename.slice(0, 180) || "export.csv",
      source: entry.source,
      rows: entry.summary.rows,
      uniqueCount: entry.summary.unique,
      createdCount: entry.summary.created,
      updatedCount: entry.summary.updated,
      collapsed: entry.summary.collapsed,
    },
  });
}
