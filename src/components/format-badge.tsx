import { formatBadge } from "@/lib/shelf-format";

export function FormatBadge({ format, className }: { format?: string | null; className?: string }) {
  const label = formatBadge(format);
  if (!label) return null;
  return (
    <span className={`rounded bg-ink/85 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-paper ring-1 ring-white/20 ${className ?? ""}`}>
      {label}
    </span>
  );
}
