import Link from "next/link";
import { ImportForm } from "@/app/import/import-form";
import { CoverControls } from "@/app/settings/cover-controls";
import { CoverLiveStatus } from "@/components/backfill-status";
import { MaintenancePanel } from "@/app/settings/maintenance-panel";
import { PreferencesForm } from "@/app/settings/preferences-form";
import { SettingsForm } from "@/app/settings/settings-form";
import { PageHeader } from "@/components/page-header";
import { Panel } from "@/components/panel";
import { readBackfillStatus } from "@/lib/covers/files";
import { prisma } from "@/lib/db";
import { formatDate } from "@/lib/format";
import { duplicateGroups, isDemoCoreId } from "@/lib/maintenance";
import { dateOptions, defaultPreferences } from "@/lib/settings/preferences";
import { loadApiUsage } from "@/lib/catalog/rate-store";
import { pauseLabel, type UsageWindow } from "@/lib/catalog/rate-limit";
import { formatResumeTime } from "@/lib/covers/limiter";
import { getPreferences, getSettingsView } from "@/lib/settings/service";
import { APP_VERSION, appCommit } from "@/lib/version";

export const metadata = { title: "Settings" };

export default async function SettingsPage() {
  let view = null;
  let prefs = defaultPreferences();
  let error: string | null = null;
  try {
    view = await getSettingsView();
  } catch (caught) {
    error = caught instanceof Error ? caught.message : "Settings could not be read.";
  }
  try {
    prefs = await getPreferences();
  } catch (caught) {
    error = error ?? (caught instanceof Error ? caught.message : "Preferences could not be read.");
  }

  const [imports, comics, counts] = await Promise.all([
    prisma.importRun.findMany({ orderBy: { createdAt: "desc" }, take: 20 }),
    prisma.comic.findMany({
      select: { id: true, series: true, issue: true, issueNo: true, variant: true, barcode: true, coreComicId: true },
    }),
    loadCounts(),
  ]);
  const status = readBackfillStatus();
  const usage = await loadApiUsage().catch(() => [] as UsageWindow[]);
  const groups = duplicateGroups(
    comics.map((comic) => ({
      id: comic.id,
      series: comic.series,
      issue: comic.issueNo || comic.issue,
      variant: comic.variant,
      barcode: comic.barcode,
    })),
  );
  const visible = groups.slice(0, 8).map((group) => ({
    label: groupLabel(group),
    comics: group.map((comic) => ({ id: comic.id, series: comic.series, issue: comic.issue, variant: comic.variant })),
  }));
  const demoCount = comics.filter((comic) => isDemoCoreId(comic.coreComicId)).length;
  const sample = formatDate(new Date(), dateOptions(prefs, true));
  const paused = prefs.covers.paused || status?.stoppedReason === "Paused.";

  return (
    <div className="max-w-3xl space-y-4">
      <PageHeader kicker="Library" title="Settings" />
      <p className="text-sm leading-relaxed text-mist">
        Import, covers, pricing, and how the shelf looks. Passwords and API keys stay encrypted. Usernames and client ids are shown in the form.
      </p>

      <Panel title="Import / Export" detail="Upload a CLZ CSV, download the shelf, or take a database backup. The backup keeps settings encrypted.">
        <ImportForm embedded />
        <div className="flex flex-wrap gap-2">
          <a href="/api/export/csv" className="rounded-full bg-panel2 px-4 py-2 text-sm font-semibold text-paper">
            Export CSV
          </a>
          <a href="/api/export/json" className="rounded-full bg-panel2 px-4 py-2 text-sm font-semibold text-paper">
            Export JSON
          </a>
          <a href="/api/export/backup" className="rounded-full bg-comic px-4 py-2 text-sm font-semibold text-ink">
            Download backup
          </a>
        </div>
        <div>
          <h3 className="text-sm font-medium text-paper">Past imports</h3>
          {imports.length === 0 ? <p className="mt-1 text-sm text-mist">No imports yet.</p> : null}
          <ul className="mt-2 divide-y divide-white/5 text-sm">
            {imports.map((run) => (
              <li key={run.id} className="flex flex-wrap items-baseline justify-between gap-2 py-2">
                <span className="text-paper">
                  {run.filename} <span className="text-mist">· {run.source}</span>
                </span>
                <span className="text-mist">
                  {formatDate(run.createdAt, dateOptions(prefs, true))} · {run.rows} rows · {run.createdCount} new · {run.updatedCount} updated
                </span>
              </li>
            ))}
          </ul>
        </div>
      </Panel>

      <Panel title="Covers" detail="Run or pause the Metron backfill. A match can fill blank issue details from that same Metron issue.">
        <CoverLiveStatus />
        <p className="text-sm text-mist">
          Shelf: {counts.matched} matched, {counts.pending} still need a cover, {counts.unmatched} unmatched.
        </p>
        <CoverControls paused={paused} running={Boolean(status?.running)} fillMissing={prefs.covers.fillMissing} />
        <Link href="/covers" className="inline-block text-sm font-semibold text-comic">
          Open the unmatched report
        </Link>
        <Link href="/covers#suspects" className="ml-4 inline-block text-sm font-semibold text-comic">
          Review suspect matches
        </Link>
      </Panel>

      <PreferencesForm prefs={prefs} sample={sample} />

      {error ? <p className="text-sm text-red-300">{error}</p> : null}
      {view ? <SettingsForm view={view} /> : null}
      <ApiUsage windows={usage} />

      <MaintenancePanel groups={visible} hiddenGroups={Math.max(0, groups.length - visible.length)} demoCount={demoCount} />

      <Panel title="About" detail="This install.">
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <Stat label="Version" value={APP_VERSION} />
          <Stat label="Commit" value={appCommit()} />
          <Stat label="Issues" value={String(counts.comics)} />
          <Stat label="Copies" value={String(counts.copies)} />
          <Stat label="Series" value={String(counts.series)} />
          <Stat label="Wishlist" value={String(counts.wishlist)} />
          <Stat label="Unmatched covers" value={String(counts.unmatched)} />
          <Stat label="Slabs" value={String(counts.slabs)} />
        </dl>
      </Panel>
    </div>
  );
}

function ApiUsage({ windows }: { windows: UsageWindow[] }) {
  return (
    <Panel title="API usage" detail="Requests already counted in the open window. A pause holds the next request until that time.">
      <ul className="space-y-3 text-sm">
        {windows.map((row) => (
          <li key={`${row.source}:${row.label}`} className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="text-paper">
              {row.source} <span className="text-mist">{row.label}</span>
            </span>
            <span className="font-mono text-paper">
              {row.used}/{row.limit}
              {row.resetAt ? <span className="ml-2 font-sans text-mist">resets {formatResumeTime(row.resetAt)}</span> : null}
            </span>
            <span className="w-full text-mist">{row.pausedUntil ? pauseLabel(row.source, row.pausedUntil) : "Active"}</span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[11px] font-semibold uppercase tracking-[0.14em] text-mist">{label}</dt>
      <dd className="mt-1 font-mono text-paper">{value}</dd>
    </div>
  );
}

function groupLabel(group: Array<{ barcode: string | null; series: string; issue: string | null }>): string {
  const barcode = group[0]?.barcode?.trim();
  if (barcode) return `Barcode ${barcode} · ${group.length} copies`;
  const comic = group[0];
  return `${comic?.series ?? "Issue"} #${comic?.issue || "?"} · ${group.length} copies`;
}

async function loadCounts() {
  const [comics, copySum, series, wishlist, unmatched, matched, pending, slabs] = await Promise.all([
    prisma.comic.count(),
    prisma.comic.aggregate({ _sum: { quantity: true } }),
    prisma.comic.groupBy({ by: ["series"] }),
    prisma.wishlistItem.count(),
    prisma.comic.count({ where: { coverStatus: "unmatched" } }),
    prisma.comic.count({ where: { coverStatus: "matched" } }),
    prisma.comic.count({ where: { coverFile: null, OR: [{ coverStatus: null }, { coverStatus: "matched" }] } }),
    prisma.comic.count({ where: { rawOrSlabbed: "Slabbed" } }),
  ]);
  return {
    comics,
    copies: copySum._sum.quantity ?? 0,
    series: series.length,
    wishlist,
    unmatched,
    matched,
    pending,
    slabs,
  };
}
