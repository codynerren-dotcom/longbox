"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect, useState } from "react";
import { clearLogsAction, type ClearLogsState } from "@/app/logs/actions";

const initial: ClearLogsState = { status: "idle", message: "" };
const STORAGE_KEY = "longbox-logs-live";

export function AutoRefresh() {
  const router = useRouter();
  const [on, setOn] = useState(false);

  useEffect(() => {
    setOn(window.sessionStorage.getItem(STORAGE_KEY) === "1");
  }, []);

  useEffect(() => {
    if (!on) return;
    const id = window.setInterval(() => router.refresh(), 5000);
    return () => window.clearInterval(id);
  }, [on, router]);

  return (
    <label className="flex items-center gap-2 text-sm text-paper">
      <input
        type="checkbox"
        checked={on}
        className="h-4 w-4 accent-comic"
        onChange={(event) => {
          const next = event.target.checked;
          setOn(next);
          window.sessionStorage.setItem(STORAGE_KEY, next ? "1" : "0");
        }}
      />
      Auto-refresh
    </label>
  );
}

export function ClearLogsButton() {
  const [state, action, pending] = useActionState(clearLogsAction, initial);
  return (
    <form
      action={(formData) => {
        if (!window.confirm("Clear every stored log? This cannot be undone.")) return;
        formData.set("confirm", "yes");
        return action(formData);
      }}
      className="flex flex-wrap items-center gap-3"
    >
      <button type="submit" disabled={pending} className="rounded-full bg-panel2 px-4 py-2 text-sm font-semibold text-paper ring-1 ring-white/10 disabled:opacity-50">
        {pending ? "Clearing…" : "Clear logs"}
      </button>
      {state.message ? <p className={state.status === "error" ? "text-sm text-red-300" : "text-sm text-paper"}>{state.message}</p> : null}
    </form>
  );
}
