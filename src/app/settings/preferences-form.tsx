"use client";

import { useActionState, type ReactNode } from "react";
import { savePreferencesAction, type LibraryState } from "@/app/settings/library-actions";
import { Panel } from "@/components/panel";
import {
  ACCENT_RGB,
  ACCENTS,
  CADENCES,
  CAMERAS,
  CLOCKS,
  COLLECTION_SORTS,
  CURRENCIES,
  DENSITIES,
  SCAN_MODES,
  TIME_ZONES,
  type ShelfPreferences,
} from "@/lib/settings/preferences";

const initial: LibraryState = { status: "idle", message: "" };

const SORT_LABEL = { series: "Series", publisher: "Publisher", added: "Recently added", coverYear: "Cover year" };
const DENSITY_LABEL = { compact: "Compact", regular: "Regular", large: "Large" };

export function PreferencesForm({ prefs, sample }: { prefs: ShelfPreferences; sample: string }) {
  const [state, action, pending] = useActionState(savePreferencesAction, initial);
  return (
    <form action={action} className="space-y-4">
      <Panel title="Pricing" detail="eBay quotes stay empty until that provider ships. Keys refresh on one cadence and the rest of the shelf on the other.">
        <label className="flex items-center gap-2 text-sm text-paper">
          <input type="checkbox" name="pricingEnabled" defaultChecked={prefs.pricing.enabled} className="h-4 w-4 accent-comic" />
          Enable eBay pricing
        </label>
        <div className="grid gap-3 sm:grid-cols-3">
          <Select label="Currency" name="currency" value={prefs.pricing.currency} options={CURRENCIES.map((code) => [code, code])} />
          <Select label="Key issues" name="keyCadence" value={prefs.pricing.keyCadence} options={CADENCES.map((cadence) => [cadence, labelize(cadence)])} />
          <Select label="Other issues" name="otherCadence" value={prefs.pricing.otherCadence} options={CADENCES.map((cadence) => [cadence, labelize(cadence)])} />
        </div>
      </Panel>

      <Panel title="Collection" detail="These choices drive the shelf grid, new scans, and the lists you keep for grades and keys.">
        <div className="grid gap-3 sm:grid-cols-2">
          <Select label="Default sort" name="sort" value={prefs.collection.sort} options={COLLECTION_SORTS.map((sort) => [sort, SORT_LABEL[sort]])} />
          <Select label="Grid density" name="density" value={prefs.collection.density} options={DENSITIES.map((density) => [density, DENSITY_LABEL[density]])} />
          <Field label="Default storage box">
            <input name="defaultStorageBox" defaultValue={prefs.collection.defaultStorageBox} className="field" placeholder="Longbox A" />
          </Field>
        </div>
        <label className="flex items-center gap-2 text-sm text-paper">
          <input type="checkbox" name="showSold" defaultChecked={prefs.collection.showSold} className="h-4 w-4 accent-comic" />
          Show sold items
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Grading companies">
            <textarea name="gradingCompanies" defaultValue={prefs.collection.gradingCompanies.join("\n")} rows={4} className="field" />
          </Field>
          <Field label="Key categories">
            <textarea name="keyCategories" defaultValue={prefs.collection.keyCategories.join("\n")} rows={4} className="field" />
          </Field>
        </div>
      </Panel>

      <Panel title="Display" detail={`Dates and times follow this clock. Right now that looks like ${sample}.`}>
        <fieldset className="space-y-2">
          <legend className="text-sm text-paper">Theme accent</legend>
          <div className="flex flex-wrap gap-2">
            {ACCENTS.map((accent) => (
              <label key={accent} className="flex items-center gap-2 rounded-full bg-panel2 px-3 py-2 text-sm text-paper">
                <input type="radio" name="accent" value={accent} defaultChecked={prefs.display.accent === accent} className="accent-comic" />
                <span className="h-3 w-3 rounded-full" style={{ backgroundColor: `rgb(${ACCENT_RGB[accent]})` }} />
                {labelize(accent)}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="grid gap-3 sm:grid-cols-3">
          <Select label="Clock" name="clock" value={prefs.display.clock} options={CLOCKS.map((clock) => [clock, clock === "12" ? "12-hour" : "24-hour"])} />
          <Select
            label="Date format"
            name="dateFormat"
            value={prefs.display.dateFormat}
            options={[
              ["mdy", "Oct 13, 2026"],
              ["dmy", "13 Oct 2026"],
              ["ymd", "2026 Oct 13"],
            ]}
          />
          <Select label="Timezone" name="timeZone" value={prefs.display.timeZone} options={zoneOptions(prefs.display.timeZone)} />
        </div>
      </Panel>

      <Panel title="Scanning" detail="Camera facing, whether a scan adds the top match, and feedback on the phone.">
        <div className="grid gap-3 sm:grid-cols-2">
          <Select
            label="Camera"
            name="camera"
            value={prefs.scanning.camera}
            options={CAMERAS.map((camera) => [camera, camera === "environment" ? "Rear camera" : "Front camera"])}
          />
          <Select
            label="After a scan"
            name="scanMode"
            value={prefs.scanning.mode}
            options={SCAN_MODES.map((mode) => [mode, mode === "confirm" ? "Confirm the match" : "Auto-add the top match"])}
          />
        </div>
        <div className="flex flex-wrap gap-4">
          <label className="flex items-center gap-2 text-sm text-paper">
            <input type="checkbox" name="beep" defaultChecked={prefs.scanning.beep} className="h-4 w-4 accent-comic" />
            Beep
          </label>
          <label className="flex items-center gap-2 text-sm text-paper">
            <input type="checkbox" name="vibrate" defaultChecked={prefs.scanning.vibrate} className="h-4 w-4 accent-comic" />
            Vibrate
          </label>
        </div>
      </Panel>

      <button type="submit" disabled={pending} className="rounded-full bg-comic px-4 py-2 text-sm font-semibold text-ink disabled:opacity-50">
        {pending ? "Saving…" : "Save preferences"}
      </button>
      {state.message ? <p className={state.status === "error" ? "text-sm text-red-300" : "text-sm text-paper"}>{state.message}</p> : null}
    </form>
  );
}

function zoneOptions(current: string): Array<[string, string]> {
  const zones: string[] = [...TIME_ZONES];
  if (!zones.includes(current)) zones.push(current);
  return zones.map((zone) => [zone, zone.replaceAll("_", " ")]);
}

function labelize(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block space-y-1 text-sm text-paper">
      <span>{label}</span>
      {children}
    </label>
  );
}

function Select({ label, name, value, options }: { label: string; name: string; value: string; options: Array<[string, string]> }) {
  return (
    <Field label={label}>
      <select name={name} defaultValue={value} className="field">
        {options.map(([option, text]) => (
          <option key={option} value={option}>
            {text}
          </option>
        ))}
      </select>
    </Field>
  );
}
