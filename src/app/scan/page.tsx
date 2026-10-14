import { PageHeader } from "@/components/page-header";
import { ScanClient } from "@/app/scan/scan-client";
import { getPreferences } from "@/lib/settings/service";

export const metadata = { title: "Scan" };

export default async function ScanPage() {
  const prefs = await getPreferences();
  return (
    <div>
      <PageHeader kicker="Add" title="Scan" />
      <ScanClient scanning={prefs.scanning} storageBox={prefs.collection.defaultStorageBox} />
    </div>
  );
}
