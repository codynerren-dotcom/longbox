"use client";

import { useState, useTransition } from "react";
import { rematchSuspectAction, unlinkSuspectAction } from "@/app/covers/actions";

export function SuspectActions({ id, manual }: { id: string; manual: boolean }) {
  const [message, setMessage] = useState("");
  const [ok, setOk] = useState(true);
  const [pending, start] = useTransition();

  function run(action: () => Promise<{ ok: boolean; message: string }>) {
    start(async () => {
      const result = await action();
      setOk(result.ok);
      setMessage(result.message);
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
          title={manual ? "This link was chosen by hand. Unlink it first." : "Clear the automatic link so backfill can try again."}
          className="rounded-full bg-comic px-3 py-2 text-sm font-semibold text-ink disabled:opacity-50"
          onClick={() => run(() => rematchSuspectAction(id))}
        >
          Re-match
        </button>
      </div>
      {manual ? <p className="mt-2 text-sm text-mist">Hand-picked link. Re-match leaves it in place until you unlink it.</p> : null}
      {message ? <p className={ok ? "mt-2 text-sm text-paper" : "mt-2 text-sm text-red-300"}>{message}</p> : null}
    </div>
  );
}
