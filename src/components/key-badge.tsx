export function keyTone(level: string | null | undefined): "major" | "minor" | null {
  const text = level?.trim() ?? "";
  if (!text || /^no$/i.test(text)) return null;
  return /^major$/i.test(text) ? "major" : "minor";
}

export function KeyBadge({
  level,
  variant = "pill",
  className = "",
}: {
  level: string | null | undefined;
  variant?: "pill" | "icon";
  className?: string;
}) {
  const tone = keyTone(level);
  if (!tone) return null;
  const label = keyLabel(level ?? "", tone);
  const toneClass = tone === "major" ? "key-major" : "key-minor";
  if (variant === "icon") {
    return (
      <span
        className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${toneClass} ${className}`}
        title={`${label} key`}
        aria-label={`${label} key`}
      >
        <KeyIcon />
      </span>
    );
  }
  return (
    <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${toneClass} ${className}`}>
      {label}
    </span>
  );
}

function keyLabel(level: string, tone: "major" | "minor"): string {
  if (tone === "major") return "Major";
  if (/^minor$/i.test(level.trim())) return "Minor";
  return level.trim();
}

function KeyIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="currentColor" aria-hidden="true">
      <path d="M7.2 1.2a3.3 3.3 0 0 0-1.55 6.2l-.08.7-1.32 1.32-1.15-.9-1.05 1.05 1.15 1.15-1.2 1.2 1.05 1.05 1.2-1.2.95.75 1.35-1.35.72-.08A3.3 3.3 0 1 0 7.2 1.2Zm.15 1.7a1.6 1.6 0 1 1 0 3.2 1.6 1.6 0 0 1 0-3.2Z" />
    </svg>
  );
}
