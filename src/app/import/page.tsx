import { ImportForm } from "@/app/import/import-form";
import { PageHeader } from "@/components/page-header";

export const metadata = { title: "Import" };

export default function ImportPage() {
  return (
    <div className="max-w-xl">
      <PageHeader kicker="CLZ" title="Import" />
      <p className="mb-4 text-sm leading-relaxed text-mist">
        Upload the CSV from CLZ Comics. All 66 columns are stored. Known fields land in typed columns, and the original row is kept as JSON.
        Re-importing the same comic updates it. A real Core ComicID matches with variant and index. An id of 0, blank, or non-numeric falls back to series, issue, variant, barcode, and index.
      </p>
      <ImportForm />
      <p className="mt-4 text-sm text-mist">
        From the shell: <code className="text-paper">npm run import:clz -- path/to/export.csv</code>
      </p>
    </div>
  );
}
