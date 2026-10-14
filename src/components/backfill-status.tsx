"use client";

import { usePathname } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import type { BackfillStatus } from "@/lib/covers/files";
import { BACKFILL_POLL_MS, backfillPollPlan, backfillProgressLabel, normalizeBackfillStatus } from "@/lib/covers/poll";

type BackfillContextValue = {
  status: BackfillStatus | null;
  refresh: () => void;
};

const BackfillContext = createContext<BackfillContextValue>({ status: null, refresh: () => {} });

export function useBackfillStatus(): BackfillContextValue {
  return useContext(BackfillContext);
}

export function BackfillStatusProvider({ initial, children }: { initial: BackfillStatus | null; children: ReactNode }) {
  const pathname = usePathname();
  const [status, setStatus] = useState<BackfillStatus | null>(initial);
  const running = Boolean(status?.running);
  const refresh = useCallback(() => {
    void fetch("/api/covers/status", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((body: unknown) => {
        if (body == null) {
          setStatus(null);
          return;
        }
        const next = normalizeBackfillStatus(body);
        if (next) setStatus(next);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const plan = backfillPollPlan(pathname, running);
    if (!plan.poll) return;
    refresh();
    const id = window.setInterval(refresh, BACKFILL_POLL_MS);
    return () => window.clearInterval(id);
  }, [pathname, running, refresh]);

  return <BackfillContext.Provider value={{ status, refresh }}>{children}</BackfillContext.Provider>;
}

export function BackfillSidebarNote() {
  const label = useProgressLabel();
  if (!label) return null;
  return <p className="px-3 pb-2 text-xs text-mist">{label}</p>;
}

export function BackfillMobileNote() {
  const label = useProgressLabel();
  if (!label) return null;
  return (
    <p className="fixed inset-x-3 bottom-[4.75rem] z-30 rounded-full bg-panel2 px-3 py-1 text-center text-xs text-mist ring-1 ring-white/10 md:hidden">
      {label}
    </p>
  );
}

function useProgressLabel(): string | null {
  const { status } = useBackfillStatus();
  return backfillProgressLabel(status);
}

export function CoverLiveStatus() {
  const { status } = useBackfillStatus();
  const running = Boolean(status?.running);
  const paused = status?.stoppedReason === "Paused.";
  return (
    <>
      <p className="text-sm text-paper">
        {running ? "Running" : paused ? "Paused" : "Idle"}
        {status ? ` · matched ${status.matched} · unmatched ${status.unmatched} · skipped ${status.skipped}` : ""}
      </p>
      {status?.message ? <p className="text-sm text-mist">{status.message}</p> : null}
    </>
  );
}
