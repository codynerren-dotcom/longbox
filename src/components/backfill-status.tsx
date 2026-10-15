"use client";

import { usePathname } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { editionJobText, type EditionJobState } from "@/lib/covers/edition-job";
import type { BackfillStatus } from "@/lib/covers/files";
import { BACKFILL_POLL_MS, backfillPollPlan, backfillProgressLabel, normalizeBackfillStatus } from "@/lib/covers/poll";

type BackfillContextValue = {
  status: BackfillStatus | null;
  rematch: EditionJobState | null;
  refresh: () => void;
};

const BackfillContext = createContext<BackfillContextValue>({ status: null, rematch: null, refresh: () => {} });

export function useBackfillStatus(): BackfillContextValue {
  return useContext(BackfillContext);
}

export function readRematchStatus(value: unknown): EditionJobState | null {
  if (!value || typeof value !== "object") return null;
  const row = (value as { rematch?: unknown }).rematch;
  if (!row || typeof row !== "object") return null;
  const job = row as Partial<EditionJobState>;
  if (job.state !== "running" && job.state !== "paused" && job.state !== "finished") return null;
  return {
    state: job.state,
    message: typeof job.message === "string" ? job.message : null,
    resumeAt: typeof job.resumeAt === "string" ? job.resumeAt : null,
    metronResumeAt: typeof job.metronResumeAt === "string" ? job.metronResumeAt : null,
    matched: typeof job.matched === "number" ? job.matched : 0,
    unmatched: typeof job.unmatched === "number" ? job.unmatched : 0,
    updatedAt: typeof job.updatedAt === "string" ? job.updatedAt : "",
  };
}

export function BackfillStatusProvider({
  initial,
  rematch: initialRematch = null,
  children,
}: {
  initial: BackfillStatus | null;
  rematch?: EditionJobState | null;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const [status, setStatus] = useState<BackfillStatus | null>(initial);
  const [rematch, setRematch] = useState<EditionJobState | null>(initialRematch);
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
        setRematch(readRematchStatus(body));
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

  return <BackfillContext.Provider value={{ status, rematch, refresh }}>{children}</BackfillContext.Provider>;
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
  const { status, rematch } = useBackfillStatus();
  const running = Boolean(status?.running);
  const paused = status?.stoppedReason === "Paused." || Boolean(status?.stoppedReason?.includes("Resumes at"));
  const rematchLine = editionJobText(rematch);
  return (
    <>
      <p className="text-sm text-paper">
        {running ? "Running" : paused ? "Paused" : "Idle"}
        {status ? ` · matched ${status.matched} · unmatched ${status.unmatched} · skipped ${status.skipped}` : ""}
      </p>
      {status?.message ? <p className="text-sm text-mist">{status.message}</p> : null}
      {rematchLine ? <p className="text-sm text-paper">{rematchLine}</p> : null}
    </>
  );
}
