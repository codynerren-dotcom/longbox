import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { prisma } from "@/lib/db";
import { formatMoney } from "@/lib/format";
import { getPreferences } from "@/lib/settings/service";
import { computeStats, topSeriesLabel } from "@/lib/stats";

export const metadata = { title: "Dashboard" };

export default async function DashboardPage() {
  const prefs = await getPreferences();
  const comics = await prisma.comic.findMany({
    select: {
      quantity: true,
      series: true,
      publisher: true,
      keyLevel: true,
      rawOrSlabbed: true,
      coverYear: true,
      purchasePrice: true,
      shelfFormat: true,
      issueNo: true,
    },
  });
  const stats = computeStats(comics);
  const maxPublisher = Math.max(1, ...stats.publisherBars.map((bar) => bar.count));
  const ageTotal = Math.max(1, stats.ages.reduce((sum, age) => sum + age.count, 0));

  return (
    <div>
      <PageHeader kicker="Shelf" title="Dashboard" />
      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Comics" value={String(stats.comics)} hint="Distinct issues" />
        <Stat label="Copies" value={String(stats.copies)} hint="Quantity summed" />
        <Stat label="Series" value={String(stats.series)} />
        <Stat label="Publishers" value={String(stats.publishers)} />
        <Stat label="Major keys" value={String(stats.majorKeys)} />
        <Stat label="Minor keys" value={String(stats.minorKeys)} />
        <Stat label="Slabs" value={String(stats.slabs)} />
        <Stat label="Recorded spend" value={formatMoney(stats.spend, prefs.pricing.currency)} hint="Purchase price × quantity" />
        <Stat label="Singles" value={String(stats.singles)} hint={formatMoney(stats.singleSpend, prefs.pricing.currency)} />
        <Stat label="Trades" value={String(stats.trades)} hint={formatMoney(stats.tradeSpend, prefs.pricing.currency)} />
      </section>

      <section className="mt-6 grid gap-4 lg:grid-cols-2">
        <article className="rounded-2xl bg-panel p-5 ring-1 ring-white/5">
          <h2 className="font-display text-3xl tracking-wide">Age split</h2>
          <div className="mt-4 flex h-3 overflow-hidden rounded-full bg-panel2">
            {stats.ages.map((age) => (
              <div
                key={age.label}
                className="h-full bg-comic first:rounded-l-full last:rounded-r-full"
                style={{ width: `${(age.count / ageTotal) * 100}%`, opacity: 0.45 + (age.count / ageTotal) * 0.55 }}
                title={`${age.label} ${age.count}`}
              />
            ))}
          </div>
          <ul className="mt-4 space-y-2">
            {stats.ages.length === 0 ? <li className="text-sm text-mist">No cover years yet.</li> : null}
            {stats.ages.map((age) => (
              <li key={age.label} className="flex items-center justify-between text-sm">
                <span>{age.label}</span>
                <span className="font-display text-2xl text-comic">{age.count}</span>
              </li>
            ))}
          </ul>
        </article>

        <article className="rounded-2xl bg-panel p-5 ring-1 ring-white/5">
          <h2 className="font-display text-3xl tracking-wide">Publishers</h2>
          <ul className="mt-4 space-y-3">
            {stats.publisherBars.length === 0 ? <li className="text-sm text-mist">Import a shelf to see publishers.</li> : null}
            {stats.publisherBars.map((bar) => (
              <li key={bar.label}>
                <div className="mb-1 flex justify-between text-sm">
                  <span>{bar.label}</span>
                  <span className="text-mist">{bar.count}</span>
                </div>
                <div className="h-2 rounded-full bg-panel2">
                  <div className="h-full rounded-full bg-comic" style={{ width: `${(bar.count / maxPublisher) * 100}%` }} />
                </div>
              </li>
            ))}
          </ul>
        </article>
      </section>

      <section className="mt-4 rounded-2xl bg-panel p-5 ring-1 ring-white/5">
        <h2 className="font-display text-3xl tracking-wide">Top series</h2>
        <ol className="mt-4 divide-y divide-white/5">
          {stats.topSeries.length === 0 ? <li className="py-3 text-sm text-mist">Nothing on the shelf yet.</li> : null}
          {stats.topSeries.map((series, index) => (
            <li key={series.label} className="flex items-center justify-between py-3">
              <span className="flex items-baseline gap-3">
                <span className="font-display text-2xl text-comic">{index + 1}</span>
                <Link href={`/collection?q=${encodeURIComponent(series.label)}`} className="hover:text-comic">
                  {series.label}
                </Link>
              </span>
              <span className="text-sm text-mist">
                {topSeriesLabel(series.count, series.copies)}
              </span>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <article className="rounded-2xl bg-panel px-4 py-4 ring-1 ring-white/5">
      <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-mist">{label}</p>
      <p className="mt-2 font-display text-4xl leading-none text-paper sm:text-5xl">{value}</p>
      {hint ? <p className="mt-2 text-xs text-mist">{hint}</p> : null}
    </article>
  );
}
