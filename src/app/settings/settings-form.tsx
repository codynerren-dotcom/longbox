"use client";

import { useRouter } from "next/navigation";
import { useActionState, useState, useTransition } from "react";
import { clearSettingAction, saveSettingsAction, testConnectionAction, type ProbeActionState, type SettingsActionState } from "@/app/settings/actions";
import { Panel } from "@/components/panel";
import { SECRET_MASK, type FieldView, type SettingsView } from "@/lib/settings/resolve";

const initialSave: SettingsActionState = { status: "idle", message: "" };
const initialProbe: ProbeActionState = { status: "idle", service: "", ok: false, message: "" };

export function SettingsForm({ view }: { view: SettingsView }) {
  const [saveState, saveAction, savePending] = useActionState(saveSettingsAction, initialSave);
  return (
    <form action={saveAction} className="space-y-4">
      <Panel title="Metron" detail="Username and password for catalog lookup and cover backfill. A saved value overrides the environment.">
        <SecretField key={`metron.username:${view.metron.username.source}`} name="metron.username" label="Username" field={view.metron.username} />
        <SecretField key={`metron.password:${view.metron.password.source}`} name="metron.password" label="Password" field={view.metron.password} />
        <TestConnection service="metron" />
      </Panel>
      <Panel title="Comic Vine" detail="API key from the Comic Vine account page.">
        <SecretField key={`comicvine.apiKey:${view.comicvine.apiKey.source}`} name="comicvine.apiKey" label="API key" field={view.comicvine.apiKey} />
        <TestConnection service="comicvine" />
      </Panel>
      <Panel title="eBay" detail="Client id and secret. Pricing stays off until you enable it.">
        <SecretField key={`ebay.clientId:${view.ebay.clientId.source}`} name="ebay.clientId" label="Client ID" field={view.ebay.clientId} />
        <SecretField key={`ebay.clientSecret:${view.ebay.clientSecret.source}`} name="ebay.clientSecret" label="Client secret" field={view.ebay.clientSecret} />
        <TestConnection service="ebay" />
      </Panel>
      <Panel title="Shelf" detail="A saved choice overrides SEED_ON_EMPTY. It applies the next time the app starts.">
        <label className="flex items-center gap-2 text-sm text-paper">
          <input type="checkbox" name="seedOnEmpty" defaultChecked={view.seedOnEmpty.enabled} className="h-4 w-4 accent-comic" />
          Seed the synthetic shelf when the database is empty
        </label>
        <p className="text-sm text-mist">{view.seedOnEmpty.source === "database" ? "Saved in the database." : "Using the environment variable."}</p>
      </Panel>
      <button type="submit" disabled={savePending} className="rounded-full bg-comic px-4 py-2 text-sm font-semibold text-ink disabled:opacity-50">
        {savePending ? "Saving…" : "Save settings"}
      </button>
      {saveState.message ? <p className={saveState.status === "error" ? "text-sm text-red-300" : "text-sm text-paper"}>{saveState.message}</p> : null}
    </form>
  );
}

function SecretField({ name, label, field }: { name: string; label: string; field: FieldView }) {
  const [replacing, setReplacing] = useState(field.source === "unset");
  return (
    <div className="space-y-2">
      <p className="text-sm text-paper">{label}</p>
      {replacing ? (
        <input name={name} type="password" autoComplete="new-password" className="field" aria-label={label} placeholder={field.source === "unset" ? "" : "New value"} />
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-xl bg-panel2 px-3 py-2 font-mono text-sm tracking-widest text-mist">{field.mask ?? SECRET_MASK}</span>
          <span className="text-sm text-mist">{field.source === "database" ? "Saved in the database." : "Using the environment variable."}</span>
          <button type="button" onClick={() => setReplacing(true)} className="rounded-full bg-panel2 px-3 py-2 text-sm font-semibold text-paper">
            Replace
          </button>
          {field.source === "database" ? <ClearButton name={name} /> : null}
        </div>
      )}
    </div>
  );
}

function ClearButton({ name }: { name: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      className="rounded-full bg-panel2 px-3 py-2 text-sm font-semibold text-paper disabled:opacity-50"
      onClick={() => {
        const data = new FormData();
        data.set("key", name);
        start(async () => {
          await clearSettingAction(data);
          router.refresh();
        });
      }}
    >
      {pending ? "Clearing…" : "Clear"}
    </button>
  );
}

function TestConnection({ service }: { service: "metron" | "comicvine" | "ebay" }) {
  const [pending, start] = useTransition();
  const [state, setState] = useState<ProbeActionState>(initialProbe);
  return (
    <div className="space-y-2">
      <button
        type="button"
        disabled={pending}
        className="rounded-full bg-panel2 px-3 py-2 text-sm font-semibold text-paper disabled:opacity-50"
        onClick={() => {
          const data = new FormData();
          data.set("service", service);
          start(async () => {
            setState(await testConnectionAction(initialProbe, data));
          });
        }}
      >
        {pending ? "Testing…" : "Test connection"}
      </button>
      <p className="text-sm text-mist">Uses the saved credentials.</p>
      {state.status === "done" && state.service === service ? (
        <p className={state.ok ? "text-sm text-paper" : "text-sm text-red-300"}>{state.message}</p>
      ) : null}
    </div>
  );
}
