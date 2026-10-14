import { PageHeader } from "@/components/page-header";
import { prisma } from "@/lib/db";
import { formatDate } from "@/lib/format";
import { redactValue } from "@/lib/log/redact";
import { logFiltersFrom, logQueryString, logWhere } from "@/lib/log/query";
import { LOG_LEVELS, LOG_SOURCES, SOURCE_LABELS, type LogSource } from "@/lib/log/types";
import { pruneLogs } from "@/lib/log/write";
import { dateOptions, defaultPreferences } from "@/lib/settings/preferences";
import { getPreferences } from "@/lib/settings/service";
import { AutoRefresh, ClearLogsButton } from "@/app/logs/log-tools";

export const dynamic = "force-dynamic";
export const metadata = { title: "Logs" };

const PAGE_SIZE = 200;

export default async function LogsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const filters = logFiltersFrom(await searchParams);
  let prefs = defaultPreferences();
  let error: string | null = null;
  try {
    prefs = await getPreferences();
  } catch (caught) {
    error = caught instanceof Error ? caught.message : "Preferences could not be read.";
  }
  await pruneLogs(false);
  let rows: Awaited<ReturnType<typeof prisma.appLog.findMany>> = [];
  try {
    rows = await prisma.appLog.findMany({
      where: logWhere(filters, prefs.display.timeZone),
      orderBy: { createdAt: "desc" },
      take: PAGE_SIZE,
    });
  } catch (caught) {
    error = caught instanceof Error ? caught.message : "Logs could not be read.";
  }
  const query = logQueryString(filters);
  const display = dateOptions(prefs, true);

  return (
    <div>
      <PageHeader kicker="Shelf" title="Logs">
        <p className="max-w-sm text-sm text-mist">Events stay for {prefs.logs.retentionDays} days, then they are pruned. Times follow your display settings.</p>
      </PageHeader>

      <form method="get" className="grid gap-3 rounded-2xl bg-panel p-4 ring-1 ring-white/5 sm:grid-cols-2 lg:grid-cols-6">
        <label className="block space-y-1 text-sm text-paper">
          <span>Level</span>
          <select name="level" defaultValue={filters.level} className="field">
            <option value="">All</option>
            {LOG_LEVELS.map((level) => (
              <option key={level} value={level}>
                {labelize(level)}
              </option>
            ))}
          </select>
        </label>
        <label className="block space-y-1 text-sm text-paper">
          <span>Source</span>
          <select name="source" defaultValue={filters.source} className="field">
            <option value="">All</option>
            {LOG_SOURCES.map((source) => (
              <option key={source} value={source}>
                {SOURCE_LABELS[source]}
              </option>
            ))}
          </select>
        </label>
        <label className="block space-y-1 text-sm text-paper">
          <span>From</span>
          <input type="date" name="from" defaultValue={filters.from} className="field" />
        </label>
        <label className="block space-y-1 text-sm text-paper">
          <span>To</span>
          <input type="date" name="to" defaultValue={filters.to} className="field" />
        </label>
        <label className="block space-y-1 text-sm text-paper lg:col-span-2">
          <span>Search</span>
          <input name="q" defaultValue={filters.q} placeholder="Message" className="field" />
        </label>
        <div className="flex flex-wrap items-center gap-3 sm:col-span-2 lg:col-span-6">
          <button type="submit" className="rounded-full bg-comic px-4 py-2 text-sm font-semibold text-ink">
            Apply
          </button>
          <a href="/logs" className="text-sm text-mist hover:text-paper">
            Reset
          </a>
          <AutoRefresh />
        </div>
      </form>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-3 text-sm">
          <a href={`/api/logs${logQueryString(filters, "text")}`} className="font-medium text-paper hover:text-comic">
            Download text
          </a>
          <a href={`/api/logs${logQueryString(filters, "json")}`} className="font-medium text-paper hover:text-comic">
            Download JSON
          </a>
        </div>
        <ClearLogsButton />
      </div>

      {error ? <p className="mt-4 text-sm text-red-300">{error}</p> : null}
      {query ? <p className="mt-4 text-sm text-mist">Showing the latest {PAGE_SIZE} events that match these filters.</p> : null}

      {rows.length === 0 ? (
        <p className="mt-6 rounded-2xl bg-panel px-4 py-8 text-sm text-mist ring-1 ring-white/5">No log events match these filters.</p>
      ) : (
        <ol className="mt-4 space-y-2">
          {rows.map((row) => (
            <li key={row.id} className="rounded-2xl bg-panel px-4 py-3 ring-1 ring-white/5">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <time className="text-xs text-mist" dateTime={row.createdAt.toISOString()}>
                  {formatDate(row.createdAt, display)}
                </time>
                <span className={`text-xs font-semibold uppercase tracking-wide ${levelClass(row.level)}`}>{row.level}</span>
                <span className="text-xs text-mist">{sourceLabel(row.source)}</span>
              </div>
              <p className="mt-1 text-sm text-paper">{row.message}</p>
              {row.details != null ? (
                <details className="mt-2">
                  <summary className="cursor-pointer text-xs text-mist">Details</summary>
                  <pre className="mt-2 overflow-x-auto whitespace-pre-wrap text-xs text-paper/80">{detailText(row.details)}</pre>
                </details>
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function sourceLabel(source: string): string {
  if ((LOG_SOURCES as readonly string[]).includes(source)) return SOURCE_LABELS[source as LogSource];
  return source;
}

function levelClass(level: string): string {
  if (level === "error") return "text-red-300";
  if (level === "warn") return "text-amber-300";
  return "text-paper";
}

function labelize(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}

function detailText(details: unknown): string {
  try {
    return JSON.stringify(redactValue(details), null, 2);
  } catch {
    return "";
  }
}
