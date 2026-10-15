"use client";

import { useState, useTransition } from "react";
import { rematchAllSuspectsAction, rematchSuspectAction, unlinkSuspectAction } from "@/app/covers/actions";
import { LimitToast } from "@/components/limit-toast";

export function SuspectActions({ id, manual }: { id: string; manual: boolean }) {
  const [message, setMessage] = useState("");
  const [toast, setToast] = useState("");
  const [ok, setOk] = useState(true);
  const [pending, start] = useTransition();

  function run(action: () => Promise<{ ok: boolean; message: string; notice?: string | null }>) {
    start(async () => {
      const result = await action();
      setOk(result.ok);
      setMessage(result.message);
      setToast(result.notice ?? "");
    });
  }

  return (
    <div className="mt-3">
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={pending} className="rounded-full bg-panel2 px-3 py-2 text-sm font-semibold text-paper disabled:opacity-50" onClick={() => run(() => unlinkSuspectAction(id))}>
          Unlink
        </button>
        <button
          type="button"
          disabled={pending || manual}
          title={manual ? "This link was chosen by hand. Unlink it first." : "Look up this facsimile again and replace the link when a modern issue matches."}
          className="rounded-full bg-comic px-3 py-2 text-sm font-semibold text-ink disabled:opacity-50"
          onClick={() => run(() => rematchSuspectAction(id))}
        >
          Re-match
        </button>
      </div>
      {manual ? <p className="mt-2 text-sm text-mist">Hand-picked link. Re-match leaves it in place until you unlink it.</p> : null}
      {message ? <p className={ok ? "mt-2 text-sm text-paper" : "mt-2 text-sm text-red-300"}>{message}</p> : null}
      <LimitToast message={toast} onDismiss={() => setToast("")} />
    </div>
  );
}

export function RematchAllSuspects() {
  const [message, setMessage] = useState("");
  const [toast, setToast] = useState("");
  const [ok, setOk] = useState(true);
  const [pending, start] = useTransition();

  return (
    <div className="mt-3">
      <button
        type="button"
        disabled={pending}
        className="rounded-full bg-comic px-3 py-2 text-sm font-semibold text-ink disabled:opacity-50"
        onClick={() => {
          start(async () => {
            const result = await rematchAllSuspectsAction();
            setOk(result.ok);
            setMessage(result.message);
            setToast(result.notice ?? "");
          });
        }}
      >
        Re-match all suspect
      </button>
      {message ? <p className={ok ? "mt-2 text-sm text-paper" : "mt-2 text-sm text-red-300"}>{message}</p> : null}
      <LimitToast message={toast} onDismiss={() => setToast("")} />
    </div>
  );
}
