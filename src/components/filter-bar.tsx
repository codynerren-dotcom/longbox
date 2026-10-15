"use client";

import { SHELF_FORMATS, type ShelfFormat } from "@/lib/shelf-format";

const FORMAT_CHIPS: Array<{ value: ShelfFormat; label: string }> = [
  { value: "single", label: "Singles" },
  { value: "tp", label: "TP" },
  { value: "hc", label: "HC" },
  { value: "omnibus", label: "Omnibus" },
  { value: "gn", label: "GN" },
  { value: "compendium", label: "Compendium" },
];

type FilterBarProps = {
  q: string;
  keys: boolean;
  slabs: boolean;
  read: string;
  format: string;
  publisher: string;
  box: string;
  publishers: string[];
  boxes: string[];
};

function toggleHref(current: URLSearchParams, key: string, value: string) {
  const next = new URLSearchParams(current);
  if (next.get(key) === value) next.delete(key);
  else next.set(key, value);
  const query = next.toString();
  return query ? `/collection?${query}` : "/collection";
}

export function FilterBar(props: FilterBarProps) {
  const current = new URLSearchParams();
  if (props.q) current.set("q", props.q);
  if (props.keys) current.set("keys", "1");
  if (props.slabs) current.set("slabs", "1");
  if (props.read) current.set("read", props.read);
  if (props.format) current.set("format", props.format);
  if (props.publisher) current.set("publisher", props.publisher);
  if (props.box) current.set("box", props.box);

  const chips = [
    { label: "Keys", href: toggleHref(current, "keys", "1"), active: props.keys },
    { label: "Slabs", href: toggleHref(current, "slabs", "1"), active: props.slabs },
    { label: "Unread", href: toggleHref(current, "read", "unread"), active: props.read === "unread" },
    { label: "Read", href: toggleHref(current, "read", "read"), active: props.read === "read" },
    ...FORMAT_CHIPS.map((chip) => ({
      label: chip.label,
      href: toggleHref(current, "format", chip.value),
      active: props.format === chip.value,
    })),
  ];

  return (
    <div className="mb-5 space-y-3">
      <form action="/collection" className="md:hidden">
        <label className="sr-only" htmlFor="mobile-search">
          Search
        </label>
        <input id="mobile-search" name="q" defaultValue={props.q} placeholder="Search series, barcode, box" className="field" />
      </form>
      <div className="flex gap-2 overflow-x-auto pb-1">
        {chips.map((chip) => (
          <a
            key={chip.label}
            href={chip.href}
            className={`shrink-0 rounded-full px-3 py-1.5 text-sm font-semibold ${
              chip.active ? "bg-comic text-ink" : "bg-panel2 text-paper ring-1 ring-white/10"
            }`}
          >
            {chip.label}
          </a>
        ))}
      </div>
      <form action="/collection" className="grid grid-cols-2 gap-2">
        {props.q ? <input type="hidden" name="q" value={props.q} /> : null}
        {props.keys ? <input type="hidden" name="keys" value="1" /> : null}
        {props.slabs ? <input type="hidden" name="slabs" value="1" /> : null}
        {props.read ? <input type="hidden" name="read" value={props.read} /> : null}
        {props.format && (SHELF_FORMATS as readonly string[]).includes(props.format) ? <input type="hidden" name="format" value={props.format} /> : null}
        <select
          name="publisher"
          defaultValue={props.publisher}
          className="field"
          aria-label="Publisher"
          onChange={(event) => event.currentTarget.form?.requestSubmit()}
        >
          <option value="">All publishers</option>
          {props.publishers.map((publisher) => (
            <option key={publisher} value={publisher}>
              {publisher}
            </option>
          ))}
        </select>
        <select
          name="box"
          defaultValue={props.box}
          className="field"
          aria-label="Storage box"
          onChange={(event) => event.currentTarget.form?.requestSubmit()}
        >
          <option value="">All boxes</option>
          {props.boxes.map((box) => (
            <option key={box} value={box}>
              {box}
            </option>
          ))}
        </select>
      </form>
    </div>
  );
}
