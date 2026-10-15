"use client";

import { useActionState, useState, useTransition } from "react";
import { enrichMatchedAction, pauseCoversAction, refetchCoverAction, runCoversAction, saveFillMissingAction, type LibraryState } from "@/app/settings/library-actions";
import { useBackfillStatus } from "@/components/backfill-status";
import { LimitToast } from "@/components/limit-toast";

const initial: LibraryState = { status: "idle", message: "" };

export function CoverControls({ paused, running, fillMissing: fillMissingInitial }: { paused: boolean; running: boolean; fillMissing: boolean }) {
  const [runMessage, setRunMessage] = useState("");
  const [toast, setToast] = useState("");
  const [hiddenNotice, setHiddenNotice] = useState("");
  const [runError, setRunError] = useState(false);
  const [fillMissing, setFillMissing] = useState(fillMissingInitial);
  const [pending, start] = useTransition();
  const [saving, saveFill] = useTransition();
  const [refetch, refetchAction, refetchPending] = useActionState(refetchCoverAction, initial);
  const { status, refresh } = useBackfillStatus();
  const liveRunning = status ? status.running : running;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={pending || liveRunning}
          className="rounded-full bg-comic px-4 py-2 text-sm font-semibold text-ink disabled:opacity-50"
          onClick={() => {
            start(async () => {
              const result = await runCoversAction();
              setRunError(result.status === "error");
              setRunMessage(result.message);
              setToast(result.notice ?? "");
              refresh();
            });
          }}
        >
          {pending ? "Starting…" : paused ? "Resume backfill" : "Run backfill"}
        </button>
        <button
          type="button"
          disabled={pending || paused}
          className="rounded-full bg-panel2 px-4 py-2 text-sm font-semibold text-paper disabled:opacity-50"
          onClick={() => {
            start(async () => {
              const result = await pauseCoversAction();
              setRunError(result.status === "error");
              setRunMessage(result.message);
              refresh();
            });
          }}
        >
          Pause
        </button>
      </div>
      {runMessage ? <p className={runError ? "text-sm text-red-300" : "text-sm text-paper"}>{runMessage}</p> : null}

      <label className="flex items-start gap-2 text-sm text-paper">
        <input
          type="checkbox"
          className="mt-1"
          checked={fillMissing}
          disabled={saving}
          onChange={(event) => {
            const next = event.target.checked;
            setFillMissing(next);
            saveFill(async () => {
              const result = await saveFillMissingAction(next);
              setRunError(result.status === "error");
              setRunMessage(result.message);
            });
          }}
        />
        <span>
          Fill missing details from Metron
          <span className="mt-1 block text-mist">Only blank fields are filled. CLZ values and anything you already saved stay put.</span>
        </span>
      </label>
      <button
        type="button"
        disabled={pending || liveRunning || saving || !fillMissing}
        className="rounded-full bg-panel2 px-4 py-2 text-sm font-semibold text-paper disabled:opacity-50"
        onClick={() => {
          start(async () => {
            const saved = await saveFillMissingAction(true);
            if (saved.status === "error") {
              setRunError(true);
              setRunMessage(saved.message);
              return;
            }
            const result = await enrichMatchedAction();
            setRunError(result.status === "error");
            setRunMessage(result.message);
            setToast(result.notice ?? "");
            refresh();
          });
        }}
      >
        {pending ? "Starting…" : "Enrich matched issues"}
      </button>

      <form action={refetchAction} className="space-y-3 border-t border-white/5 pt-4">
        <h3 className="text-sm font-medium text-paper">Re-fetch one cover</h3>
        <div className="grid gap-3 sm:grid-cols-3">
          <input name="series" placeholder="Series" className="field" aria-label="Series" />
          <input name="issue" placeholder="Issue" className="field" aria-label="Issue" />
          <input name="comicId" placeholder="Issue id" className="field" aria-label="Issue id" />
        </div>
        <button type="submit" disabled={refetchPending} className="rounded-full bg-panel2 px-4 py-2 text-sm font-semibold text-paper disabled:opacity-50">
          {refetchPending ? "Fetching…" : "Re-fetch cover"}
        </button>
        {refetch.message ? <p className={refetch.status === "error" ? "text-sm text-red-300" : "text-sm text-paper"}>{refetch.message}</p> : null}
      </form>
      <LimitToast
        message={(toast || refetch.notice || "") === hiddenNotice ? "" : toast || refetch.notice || ""}
        onDismiss={() => {
          setHiddenNotice(toast || refetch.notice || "");
          setToast("");
        }}
      />
    </div>
  );
}
