import Link from "next/link";

export default function NotFound() {
  return (
    <div className="rounded-2xl bg-panel px-5 py-8">
      <h1 className="font-display text-5xl tracking-wide">Not on the shelf</h1>
      <p className="mt-2 text-sm text-mist">That page does not match a series, issue, or box.</p>
      <Link href="/collection" className="mt-4 inline-flex rounded-full bg-comic px-4 py-2 text-sm font-semibold text-ink">
        Back to the collection
      </Link>
    </div>
  );
}
