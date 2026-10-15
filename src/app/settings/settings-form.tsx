"use client";

import { useRouter } from "next/navigation";
import { useActionState, useRef, useState, useTransition } from "react";
import { clearSettingAction, saveServiceAction, saveSettingsAction, testConnectionAction, type ProbeActionState, type SettingsActionState } from "@/app/settings/actions";
import { Panel } from "@/components/panel";
import { SECRET_MASK, type FieldView, type SettingsView } from "@/lib/settings/resolve";

const initialSave: SettingsActionState = { status: "idle", message: "" };
const initialProbe: ProbeActionState = { status: "idle", service: "", ok: false, message: "" };

export function SettingsForm({ view }: { view: SettingsView }) {
  return (
    <div className="space-y-4">
      <CredentialCard
        title="Metron"
        detail="Username and password for catalog lookup and cover backfill. A saved value overrides the environment."
        service="metron"
        inputs={[
          { name: "metron.username", label: "Username", field: view.metron.username },
          { name: "metron.password", label: "Password", field: view.metron.password },
        ]}
      />
      <CredentialCard
        title="Grand Comics Database"
        detail="Optional. Anonymous requests stay at 30 per hour. A saved username and password switches that window to 2,000 per day."
        service="gcd"
        inputs={[
          { name: "gcd.username", label: "Username", field: view.gcd.username },
          { name: "gcd.password", label: "Password", field: view.gcd.password },
        ]}
      />
      <CredentialCard
        title="Comic Vine"
        detail="API key from the Comic Vine account page."
        service="comicvine"
        inputs={[{ name: "comicvine.apiKey", label: "API key", field: view.comicvine.apiKey }]}
      />
      <CredentialCard
        title="eBay"
        detail="Client id and secret. Pricing stays off until you enable it."
        service="ebay"
        inputs={[
          { name: "ebay.clientId", label: "Client ID", field: view.ebay.clientId },
          { name: "ebay.clientSecret", label: "Client secret", field: view.ebay.clientSecret },
        ]}
      />
      <ShelfCard enabled={view.seedOnEmpty.enabled} source={view.seedOnEmpty.source} />
    </div>
  );
}

function CredentialCard({
  title,
  detail,
  service,
  inputs,
}: {
  title: string;
  detail: string;
  service: "metron" | "gcd" | "comicvine" | "ebay";
  inputs: Array<{ name: string; label: string; field: FieldView }>;
}) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [dirty, setDirty] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [pending, start] = useTransition();
  const [saveState, setSaveState] = useState<SettingsActionState>(initialSave);
  const [probe, setProbe] = useState<ProbeActionState>(initialProbe);

  function payload(): FormData {
    const form = new FormData(formRef.current ?? undefined);
    form.set("service", service);
    return form;
  }

  function markDirty() {
    const form = formRef.current;
    if (!form) return;
    const changed = inputs.some((input) => {
      const element = form.elements.namedItem(input.name);
      if (!(element instanceof HTMLInputElement)) return false;
      if (input.field.kind === "plain") return element.value.trim() !== input.field.value;
      return element.type === "password" && element.value.trim().length > 0;
    });
    setDirty(changed);
  }

  function finishSave(result: SettingsActionState) {
    setSaveState(result);
    if (result.status === "ok" && result.message === "Saved.") {
      setDirty(false);
      setGeneration((value) => value + 1);
      router.refresh();
    }
  }

  return (
    <form ref={formRef} onSubmit={(event) => event.preventDefault()} onInput={markDirty}>
      <Panel title={title} detail={detail}>
        {inputs.map((input) =>
          input.field.kind === "plain" ? (
            <PlainField key={`${input.name}:${input.field.source}:${input.field.value}:${generation}`} name={input.name} label={input.label} field={input.field} />
          ) : (
            <SecretField key={`${input.name}:${input.field.source}:${generation}`} name={input.name} label={input.label} field={input.field} />
          ),
        )}
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={pending}
            onClick={() => start(async () => finishSave(await saveServiceAction(initialSave, payload())))}
            className="rounded-full bg-comic px-4 py-2 text-sm font-semibold text-ink disabled:opacity-50"
          >
            {pending ? "Working…" : "Save"}
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() => start(async () => setProbe(await testConnectionAction(initialProbe, payload())))}
            className="rounded-full bg-panel2 px-4 py-2 text-sm font-semibold text-paper disabled:opacity-50"
          >
            Test connection
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() =>
              start(async () => {
                const body = payload();
                const saved = await saveServiceAction(initialSave, body);
                finishSave(saved);
                if (saved.status !== "ok") return;
                setProbe(await testConnectionAction(initialProbe, body));
              })
            }
            className="rounded-full bg-panel2 px-4 py-2 text-sm font-semibold text-paper disabled:opacity-50"
          >
            Save & test
          </button>
          <span className={dirty ? "text-sm font-semibold text-comic" : "text-sm text-mist"}>{dirty ? "Unsaved" : savedLabel(inputs.map((input) => input.field))}</span>
        </div>
        {saveState.message ? <p className={saveState.status === "error" ? "text-sm text-red-300" : "text-sm text-paper"}>{saveState.message}</p> : null}
        {probe.status === "done" && probe.service === service ? <p className={probe.ok ? "text-sm text-paper" : "text-sm text-red-300"}>{probe.message}</p> : null}
      </Panel>
    </form>
  );
}

function savedLabel(fields: FieldView[]): string {
  if (fields.every((field) => field.source === "unset")) return "Not saved";
  if (fields.some((field) => field.source === "database")) return "Saved";
  return "Using the environment";
}

function ShelfCard({ enabled, source }: { enabled: boolean; source: "database" | "environment" }) {
  const [state, action, pending] = useActionState(saveSettingsAction, initialSave);
  return (
    <form action={action}>
      <Panel title="Shelf" detail="A saved choice overrides SEED_ON_EMPTY. It applies the next time the app starts.">
        <label className="flex items-center gap-2 text-sm text-paper">
          <input type="checkbox" name="seedOnEmpty" defaultChecked={enabled} className="h-4 w-4 accent-comic" />
          Seed the synthetic shelf when the database is empty
        </label>
        <p className="text-sm text-mist">{source === "database" ? "Saved" : "Using the environment"}</p>
        <button type="submit" disabled={pending} className="rounded-full bg-comic px-4 py-2 text-sm font-semibold text-ink disabled:opacity-50">
          {pending ? "Saving…" : "Save"}
        </button>
        {state.message ? <p className={state.status === "error" ? "text-sm text-red-300" : "text-sm text-paper"}>{state.message}</p> : null}
      </Panel>
    </form>
  );
}

function PlainField({ name, label, field }: { name: string; label: string; field: Extract<FieldView, { kind: "plain" }> }) {
  return (
    <div className="space-y-2">
      <label className="block space-y-1 text-sm text-paper">
        <span>{label}</span>
        <input name={name} type="text" defaultValue={field.value} autoComplete="off" spellCheck={false} className="field" aria-label={label} />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-mist">{field.source === "database" ? "Saved" : field.source === "environment" ? "Using the environment" : "Not saved"}</span>
        {field.source === "database" ? <ClearButton name={name} /> : null}
      </div>
    </div>
  );
}

function SecretField({ name, label, field }: { name: string; label: string; field: Extract<FieldView, { kind: "secret" }> }) {
  const [replacing, setReplacing] = useState(field.source === "unset");
  return (
    <div className="space-y-2">
      <p className="text-sm text-paper">{label}</p>
      {replacing ? (
        <input name={name} type="password" autoComplete="new-password" className="field" aria-label={label} placeholder={field.source === "unset" ? "" : "New value"} />
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-xl bg-panel2 px-3 py-2 font-mono text-sm tracking-widest text-mist">{field.mask ?? SECRET_MASK}</span>
          <span className="text-sm text-mist">{field.source === "database" ? "Saved" : "Using the environment"}</span>
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
