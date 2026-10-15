"use client";

export function LimitToast({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  if (!message) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[80] flex justify-center px-4">
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-auto flex max-w-lg items-start gap-3 rounded-2xl bg-panel px-4 py-3 text-sm text-paper shadow-2xl ring-1 ring-comic"
      >
        <p className="flex-1">{message}</p>
        <button type="button" className="shrink-0 text-mist" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </div>
  );
}
