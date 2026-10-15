"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition, type ReactNode } from "react";
import { saveIssueAction } from "@/app/issues/actions";
import { RefreshFromMetron } from "@/app/issues/refresh-metron";
import { CatalogIdLink, catalogIdHref } from "@/components/catalog-id-link";
import type { CatalogIdKind } from "@/lib/catalog-id-text";
import { SHELF_FORMAT_OPTIONS } from "@/lib/shelf-format";
import {
  ISSUE_FIELDS,
  KEY_LEVELS,
  RAW_CHOICES,
  choiceList,
  issueGroups,
  type IssueDraft,
  type IssueFieldDef,
  type IssueFieldKey,
} from "@/lib/issue-fields";

const CATALOG_FIELD: Partial<Record<IssueFieldKey, CatalogIdKind>> = {
  metronIssueId: "metron-issue",
  metronSeriesId: "metron-series",
  comicvineIssueId: "comicvine-issue",
  comicvineSeriesId: "comicvine-series",
  gcdIssueId: "gcd-issue",
  gcdSeriesId: "gcd-series",
};

export function IssueEditor({
  draft,
  boxes,
  categories,
  companies,
  coverTools,
  metronIssueUrl,
  metronSeriesUrl,
  children,
}: {
  draft: IssueDraft;
  boxes: string[];
  categories: string[];
  companies: string[];
  coverTools?: ReactNode;
  metronIssueUrl?: string | null;
  metronSeriesUrl?: string | null;
  children: ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  if (editing) {
    return (
      <IssueForm
        draft={draft}
        boxes={boxes}
        categories={categories}
        companies={companies}
        coverTools={coverTools}
        metronIssueUrl={metronIssueUrl}
        metronSeriesUrl={metronSeriesUrl}
        onCancel={() => setEditing(false)}
        onSaved={() => setEditing(false)}
      />
    );
  }
  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="inline-flex min-h-11 items-center rounded-full bg-comic px-4 py-2 text-sm font-semibold text-ink"
        >
          Edit
        </button>
        <RefreshFromMetron comicId={draft.id} />
      </div>
      {children}
    </div>
  );
}

function IssueForm({
  draft,
  boxes,
  categories,
  companies,
  coverTools,
  metronIssueUrl,
  metronSeriesUrl,
  onCancel,
  onSaved,
}: {
  draft: IssueDraft;
  boxes: string[];
  categories: string[];
  companies: string[];
  coverTools?: ReactNode;
  metronIssueUrl?: string | null;
  metronSeriesUrl?: string | null;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [errors, setErrors] = useState<{ field: string; message: string }[]>([]);
  const groups = issueGroups();
  const boxChoices = choiceList(boxes, draft.values.storageBox);

  function messageFor(key: string) {
    return errors.find((error) => error.field === key)?.message;
  }

  return (
    <form
      id="issue-edit"
      className="mt-2 space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        const raw = collect(event.currentTarget);
        setErrors([]);
        startTransition(async () => {
          const result = await saveIssueAction(draft.id, raw);
          if (!result.ok) {
            setErrors(result.errors);
            return;
          }
          onSaved();
          router.refresh();
        });
      }}
    >
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="font-display text-4xl tracking-wide">Edit</h2>
          <p className="mt-1 max-w-xl text-sm text-mist">Edits stay on this copy. Metron and a later CLZ import will not replace them.</p>
        </div>
        <FormActions pending={pending} onCancel={onCancel} />
      </div>
      {errors.length > 0 ? (
        <div role="alert" className="rounded-xl bg-red-950/60 px-3 py-3 text-sm text-red-100 ring-1 ring-red-400/40">
          {errors.map((error) => (
            <p key={`${error.field}-${error.message}`}>{error.message}</p>
          ))}
        </div>
      ) : null}
      {coverTools}
      {groups.map((group) => (
        <fieldset key={group} className="rounded-2xl bg-panel p-4 ring-1 ring-white/5">
          <legend className="px-1 font-display text-3xl tracking-wide">{group}</legend>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {ISSUE_FIELDS.filter((field) => field.group === group).map((field) => (
              <Field
                key={field.key}
                field={field}
                draft={draft}
                boxes={boxChoices}
                categories={categories}
                companies={companies}
                error={messageFor(field.key)}
                siteUrl={field.key === "metronIssueId" ? metronIssueUrl : field.key === "metronSeriesId" ? metronSeriesUrl : null}
              />
            ))}
          </div>
        </fieldset>
      ))}
      <div className="sticky bottom-[4.75rem] z-30 -mx-4 border-t border-white/10 bg-ink/95 px-4 py-3 backdrop-blur md:bottom-0">
        <FormActions pending={pending} onCancel={onCancel} />
      </div>
    </form>
  );
}

function FormActions({ pending, onCancel }: { pending: boolean; onCancel: () => void }) {
  return (
    <div className="flex flex-wrap gap-2">
      <button
        type="button"
        onClick={onCancel}
        disabled={pending}
        className="inline-flex min-h-11 items-center rounded-full bg-panel2 px-4 py-2 text-sm font-semibold text-paper ring-1 ring-white/10 disabled:opacity-50"
      >
        Cancel
      </button>
      <button
        type="submit"
        disabled={pending}
        className="inline-flex min-h-11 items-center rounded-full bg-comic px-4 py-2 text-sm font-semibold text-ink disabled:opacity-50"
      >
        {pending ? "Saving…" : "Save"}
      </button>
    </div>
  );
}

function Field({
  field,
  draft,
  boxes,
  categories,
  companies,
  error,
  siteUrl,
}: {
  field: IssueFieldDef;
  draft: IssueDraft;
  boxes: string[];
  categories: string[];
  companies: string[];
  error?: string;
  siteUrl?: string | null;
}) {
  const id = `edit-${field.key}`;
  const value = draft.values[field.key as IssueFieldKey];
  const catalog = CATALOG_FIELD[field.key as IssueFieldKey];
  const [live, setLive] = useState(value);
  const span = field.full ? "sm:col-span-2" : "";
  return (
    <div className={span}>
      <label className="block" htmlFor={id}>
        <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-mist">{field.label}</span>
        <span className="mt-1 block">{control(field, id, value, { boxes, categories, companies }, catalog ? setLive : undefined)}</span>
        {error ? (
          <span id={`${id}-error`} className="mt-1 block text-sm text-red-200">
            {error}
          </span>
        ) : null}
      </label>
      {catalog && catalogIdHref(catalog, live, siteUrl) ? (
        <span className="mt-1 block text-sm">
          <CatalogIdLink kind={catalog} id={live} siteUrl={siteUrl} fallback={false} />
        </span>
      ) : null}
    </div>
  );
}

function control(
  field: IssueFieldDef,
  id: string,
  value: string,
  lists: { boxes: string[]; categories: string[]; companies: string[] },
  onValue?: (value: string) => void,
) {
  const described = `${id}-error`;
  if (field.kind === "bool") {
    return (
      <span className="flex min-h-11 items-center gap-3 rounded-xl bg-ink px-3 py-2 ring-1 ring-white/10">
        <input id={id} name={field.key} type="checkbox" value="true" defaultChecked={value === "true"} className="h-5 w-5 accent-comic" aria-describedby={described} />
        <span className="text-sm text-paper">On the read list</span>
      </span>
    );
  }
  if (field.kind === "textarea") {
    return <textarea id={id} name={field.key} defaultValue={value} rows={4} maxLength={field.max} className="field" aria-describedby={described} />;
  }
  if (field.kind === "shelfFormat") {
    return (
      <select id={id} name={field.key} defaultValue={value || "single"} className="field min-h-11" aria-describedby={described}>
        {SHELF_FORMAT_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    );
  }
  if (field.kind === "raw" || field.kind === "keyLevel" || field.kind === "category" || field.kind === "company") {
    const options =
      field.kind === "raw"
        ? choiceList(RAW_CHOICES, value)
        : field.kind === "keyLevel"
          ? choiceList(KEY_LEVELS, value)
          : field.kind === "category"
            ? choiceList(lists.categories, value)
            : choiceList(lists.companies, value);
    return (
      <select id={id} name={field.key} defaultValue={value} className="field min-h-11" aria-describedby={described}>
        <option value="">None</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    );
  }
  if (field.kind === "box") {
    return (
      <>
        <input id={id} name={field.key} list="storage-boxes" defaultValue={value} maxLength={field.max} className="field min-h-11" aria-describedby={described} />
        <datalist id="storage-boxes">
          {lists.boxes.map((box) => (
            <option key={box} value={box} />
          ))}
        </datalist>
      </>
    );
  }
  const type = field.kind === "date" ? "date" : field.kind === "quantity" || field.kind === "int" || field.kind === "year" || field.kind === "rating" ? "number" : "text";
  return (
    <input
      id={id}
      name={field.key}
      type={type}
      defaultValue={value}
      maxLength={field.kind === "text" ? field.max : undefined}
      min={field.kind === "quantity" ? 1 : field.kind === "rating" ? 0 : field.kind === "year" ? 1800 : field.kind === "int" ? 1 : undefined}
      max={field.kind === "quantity" ? 9999 : field.kind === "rating" ? 10 : field.kind === "year" ? 2100 : undefined}
      step={field.kind === "rating" ? "0.01" : field.kind === "quantity" || field.kind === "int" || field.kind === "year" ? "1" : undefined}
      inputMode={field.kind === "money" ? "decimal" : field.kind === "quantity" || field.kind === "int" || field.kind === "year" ? "numeric" : undefined}
      required={field.key === "series" || field.kind === "quantity"}
      className="field min-h-11"
      aria-describedby={described}
      onChange={onValue ? (event) => onValue(event.target.value) : undefined}
    />
  );
}

function collect(form: HTMLFormElement): Record<string, string> {
  const data = new FormData(form);
  const raw: Record<string, string> = {};
  for (const field of ISSUE_FIELDS) {
    raw[field.key] = field.kind === "bool" ? (data.get(field.key) === "true" ? "true" : "false") : String(data.get(field.key) ?? "");
  }
  return raw;
}
