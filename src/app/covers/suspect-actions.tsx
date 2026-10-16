"use client";

import { useState, useTransition } from "react";
import { rematchAllSuspectsAction, rematchSuspectAction, unlinkSuspectAction } from "@/app/covers/actions";
import { queueSearchAction } from "@/app/logs/queue-actions";
import { LimitToast } from "@/components/limit-toast";
import type { QueueHint, QueueSeed } from "@/lib/catalog/search-queue";

export function SuspectActions({ id, manual }: { id: string; manual: boolean }) {
  const [message, setMessage] = useState("");
  const [toast, setToast] = useState("");
  const [offer, setOffer] = useState<QueueHint | null>(null);
  const [ok, setOk] = useState(true);
  const [pending, start] = useTransition();

  function run(action: () => Promise<{ ok: boolean; message: string; notice?: string | null; queue?: QueueHint | null }>) {
    start(async () => {
      const result = await action();
      setOk(result.ok);
      setMessage(result.message);
      setToast(result.notice ?? "");
      setOffer(result.notice ? (result.queue ?? null) : null);
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
          title={manual ? "This link was chosen by hand. Unlink it first." : "Look this up again and save a proposal. The link stays until you accept it."}
          className="rounded-full bg-comic px-3 py-2 text-sm font-semibold text-ink disabled:opacity-50"
          onClick={() => run(() => rematchSuspectAction(id))}
        >
          Re-match
        </button>
      </div>
      {manual ? <p className="mt-2 text-sm text-mist">Hand-picked link. Re-match leaves it in place until you unlink it.</p> : null}
      {message ? <p className={ok ? "mt-2 text-sm text-paper" : "mt-2 text-sm text-red-300"}>{message}</p> : null}
      <LimitToast
        message={toast}
        onDismiss={() => {
          setToast("");
          setOffer(null);
        }}
        onQueue={
          offer
            ? async () => {
                const result = await queueSearchAction({ ...offer, comicId: id });
                if (result.ok) setOffer(null);
                setToast(result.message);
                return result.message;
              }
            : undefined
        }
      />
    </div>
  );
}

export function RematchAllSuspects() {
  const [message, setMessage] = useState("");
  const [toast, setToast] = useState("");
  const [items, setItems] = useState<QueueSeed[]>([]);
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
            setItems(result.notice ? result.queueItems : []);
          });
        }}
      >
        Propose re-matches
      </button>
      {message ? <p className={ok ? "mt-2 text-sm text-paper" : "mt-2 text-sm text-red-300"}>{message}</p> : null}
      <LimitToast
        message={toast}
        onDismiss={() => {
          setToast("");
          setItems([]);
        }}
        onQueue={
          items.length > 0
            ? async () => {
                const result = await queueSearchAction(items);
                if (result.ok) setItems([]);
                setToast(result.message);
                return result.message;
              }
            : undefined
        }
      />
    </div>
  );
}
