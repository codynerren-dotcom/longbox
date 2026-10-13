import { PageHeader } from "@/components/page-header";
import { ScanClient } from "@/app/scan/scan-client";

export const metadata = { title: "Scan" };

export default function ScanPage() {
  return (
    <div>
      <PageHeader kicker="Add" title="Scan" />
      <ScanClient />
    </div>
  );
}
