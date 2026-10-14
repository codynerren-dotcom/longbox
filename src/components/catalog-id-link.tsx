import { Fragment, type ReactNode } from "react";
import {
  comicVineIssueHref,
  comicVineVolumeHref,
  gcdIssueHref,
  gcdSeriesHref,
  metronIssueHref,
  metronSeriesHref,
} from "@/lib/catalog-links";
import { catalogIdText, catalogMentions, detailIdKind, type CatalogIdKind } from "@/lib/catalog-id-text";
import { redactValue } from "@/lib/log/redact";

export function catalogIdHref(kind: CatalogIdKind, id: string | null | undefined, siteUrl?: string | null): string | null {
  switch (kind) {
    case "metron-issue":
      return metronIssueHref(id, siteUrl);
    case "metron-series":
      return metronSeriesHref(id, siteUrl);
    case "comicvine-issue":
      return comicVineIssueHref(id);
    case "comicvine-series":
      return comicVineVolumeHref(id);
    case "gcd-issue":
      return gcdIssueHref(id);
    case "gcd-series":
      return gcdSeriesHref(id);
  }
}

export function CatalogIdLink({
  kind,
  id,
  siteUrl,
  fallback = true,
  className = "text-comic hover:underline",
}: {
  kind: CatalogIdKind;
  id: string;
  siteUrl?: string | null;
  fallback?: boolean;
  className?: string;
}) {
  const label = id.trim();
  const href = catalogIdHref(kind, label, siteUrl);
  if (!href) return fallback ? <>{label}</> : null;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={className}>
      {label}
    </a>
  );
}

export function LinkedMessage({ text }: { text: string }) {
  const parts = catalogMentions(text);
  return (
    <>
      {parts.map((part, index) =>
        part.kind === "text" ? (
          <Fragment key={index}>{part.text}</Fragment>
        ) : (
          <CatalogIdLink key={index} kind={part.catalog} id={part.id} />
        ),
      )}
    </>
  );
}

export function LinkedJson({ value }: { value: unknown }) {
  return <>{formatValue(redactValue(value), 0, null, undefined)}</>;
}

function formatValue(value: unknown, depth: number, key: string | null, via: unknown): ReactNode {
  const kind = key ? detailIdKind(key, via) : null;
  const id = kind ? catalogIdText(value) : null;
  if (kind && id) return <JsonId id={id} kind={kind} />;
  if (value == null) return "null";
  if (typeof value === "string") return <Quoted text={value} />;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const pad = "  ".repeat(depth);
    const inner = "  ".repeat(depth + 1);
    return (
      <>
        {"[\n"}
        {value.map((item, index) => (
          <Fragment key={index}>
            {inner}
            {formatValue(item, depth + 1, key, via)}
            {index < value.length - 1 ? "," : ""}
            {"\n"}
          </Fragment>
        ))}
        {pad}
        {"]"}
      </>
    );
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const entries = Object.entries(record);
    if (entries.length === 0) return "{}";
    const nextVia = "via" in record ? record.via : via;
    const pad = "  ".repeat(depth);
    const inner = "  ".repeat(depth + 1);
    return (
      <>
        {"{\n"}
        {entries.map(([entryKey, entry], index) => (
          <Fragment key={entryKey}>
            {inner}
            {JSON.stringify(entryKey)}
            {": "}
            {formatValue(entry, depth + 1, entryKey, nextVia)}
            {index < entries.length - 1 ? "," : ""}
            {"\n"}
          </Fragment>
        ))}
        {pad}
        {"}"}
      </>
    );
  }
  return "";
}

function JsonId({ id, kind }: { id: string; kind: CatalogIdKind }) {
  return (
    <>
      {'"'}
      <CatalogIdLink kind={kind} id={id} />
      {'"'}
    </>
  );
}

function Quoted({ text }: { text: string }) {
  const parts = catalogMentions(text);
  if (parts.length === 1 && parts[0].kind === "text") return JSON.stringify(text);
  return (
    <>
      {'"'}
      {parts.map((part, index) =>
        part.kind === "text" ? (
          <Fragment key={index}>{jsonEscape(part.text)}</Fragment>
        ) : (
          <CatalogIdLink key={index} kind={part.catalog} id={part.id} />
        ),
      )}
      {'"'}
    </>
  );
}

function jsonEscape(text: string): string {
  return JSON.stringify(text).slice(1, -1);
}
