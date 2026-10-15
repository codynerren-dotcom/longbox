import type { ReactNode } from "react";

export function Panel({ title, detail, children }: { title: string; detail?: string; children: ReactNode }) {
  return (
    <section className="space-y-3 rounded-2xl bg-panel p-5 ring-1 ring-white/5">
      <div>
        <h2 className="font-display text-3xl tracking-wide">{title}</h2>
        {detail ? <p className="text-sm leading-relaxed text-mist">{detail}</p> : null}
      </div>
      {children}
    </section>
  );
}
