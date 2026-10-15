import type { ReactNode } from "react";

export function PageHeader({
  kicker,
  title,
  children,
}: {
  kicker?: string;
  title: string;
  children?: ReactNode;
}) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        {kicker ? <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-comic">{kicker}</p> : null}
        <h1 className="font-display text-5xl tracking-wide text-paper sm:text-6xl">{title}</h1>
      </div>
      {children}
    </header>
  );
}
