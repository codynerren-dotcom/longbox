import { prisma } from "@/lib/db";
import { formatDate } from "@/lib/format";
import { formatLogText, logFiltersFrom, logWhere, serializeLog } from "@/lib/log/query";
import { dateOptions, defaultPreferences } from "@/lib/settings/preferences";
import { getPreferences } from "@/lib/settings/service";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const format = url.searchParams.get("format") === "text" ? "text" : "json";
  let prefs = defaultPreferences();
  try {
    prefs = await getPreferences();
  } catch {
    prefs = defaultPreferences();
  }
  const filters = logFiltersFrom(url.searchParams);
  const rows = await prisma.appLog.findMany({
    where: logWhere(filters, prefs.display.timeZone),
    orderBy: { createdAt: "desc" },
    take: 5000,
  });
  if (format === "text") {
    const body = formatLogText(rows, dateOptions(prefs, true));
    return new Response(body ? `${body}\n` : "", {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": "attachment; filename=\"longbox.log\"",
        "Cache-Control": "no-store",
      },
    });
  }
  const body = JSON.stringify(
    rows.map((row) => ({
      ...serializeLog(row),
      createdAt: row.createdAt.toISOString(),
      displayTime: formatDate(row.createdAt, dateOptions(prefs, true)),
    })),
    null,
    2,
  );
  return new Response(body, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": "attachment; filename=\"longbox-logs.json\"",
      "Cache-Control": "no-store",
    },
  });
}
