import { SettingsForm } from "@/app/settings/settings-form";
import { PageHeader } from "@/components/page-header";
import { getSettingsView } from "@/lib/settings/service";

export const metadata = { title: "Settings" };

export default async function SettingsPage() {
  let view = null;
  let error: string | null = null;
  try {
    view = await getSettingsView();
  } catch (caught) {
    error = caught instanceof Error ? caught.message : "Settings could not be read.";
  }

  return (
    <div className="max-w-xl">
      <PageHeader kicker="Integrations" title="Settings" />
      <p className="mb-4 text-sm leading-relaxed text-mist">
        Credentials saved here override environment variables. The environment stays as a fallback after Clear. Saved secrets are encrypted and are not sent back to the browser.
      </p>
      {error ? <p className="text-sm text-red-300">{error}</p> : null}
      {view ? <SettingsForm view={view} /> : null}
    </div>
  );
}
