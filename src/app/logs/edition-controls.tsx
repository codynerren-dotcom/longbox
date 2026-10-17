"use client";

import { useState, useTransition } from "react";
import { clearEditionJobAction, resumeEditionJobAction } from "@/app/logs/edition-actions";

export function EditionJobControls({ state }: { state: string | null }) {
  const [message, setMessage] = useState("");
  const [ok, setOk] = useState(true);
  const [pending, start] = useTransition();
  if (!state || state === "finished") return null;

  function run(action: () => Promise<{ ok: boolean; message: string }>) {
    start(async () => {
      const result = await action();
      setOk(result.ok);
      setMessage(result.message);
    });
  }

  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <button
        type="button"
        disabled={pending}
        className="rounded-full bg-comic px-3 py-2 text-sm font-semibold text-ink disabled:opacity-50"
        onClick={() => run(() => resumeEditionJobAction())}
      >
        Resume re-match
      </button>
      <button
        type="button"
        disabled={pending}
        className="rounded-full bg-panel2 px-3 py-2 text-sm font-semibold text-paper disabled:opacity-50"
        onClick={() => run(() => clearEditionJobAction())}
      >
        Clear re-match
      </button>
      {message ? <p className={ok ? "text-sm text-paper" : "text-sm text-red-300"}>{message}</p> : null}
    </div>
  );
}
