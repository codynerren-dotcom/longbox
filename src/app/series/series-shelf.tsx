"use client";

import { useState, type ReactNode } from "react";

export function SeriesShelf({ list, grid }: { list: ReactNode; grid: ReactNode }) {
  const [view, setView] = useState<"list" | "grid">("list");

  return (
    <div>
      <div className="mb-3 flex justify-end">
        <div className="inline-flex rounded-full bg-panel p-1 ring-1 ring-white/10" role="group" aria-label="Series layout">
          <ViewButton pressed={view === "list"} onClick={() => setView("list")}>
            List
          </ViewButton>
          <ViewButton pressed={view === "grid"} onClick={() => setView("grid")}>
            Grid
          </ViewButton>
        </div>
      </div>
      {view === "list" ? list : grid}
    </div>
  );
}

function ViewButton({ pressed, onClick, children }: { pressed: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={`rounded-full px-4 py-1.5 text-sm font-semibold ${pressed ? "bg-comic text-ink" : "text-mist"}`}
    >
      {children}
    </button>
  );
}
