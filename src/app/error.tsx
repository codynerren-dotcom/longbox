"use client";

export default function ErrorPage({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <div className="rounded-2xl bg-panel px-5 py-8">
      <h1 className="font-display text-5xl tracking-wide">Longbox hit a snag</h1>
      <p className="mt-2 max-w-xl text-sm text-mist">{error.message || "Something failed while loading the shelf."}</p>
      <button type="button" onClick={reset} className="mt-4 rounded-full bg-comic px-4 py-2 text-sm font-semibold text-ink">
        Try again
      </button>
    </div>
  );
}
