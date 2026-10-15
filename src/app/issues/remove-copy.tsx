"use client";

import { removeCopyAction } from "@/app/issues/actions";

export function RemoveCopyButton({ id }: { id: string }) {
  return (
    <form action={removeCopyAction}>
      <input type="hidden" name="id" value={id} />
      <button
        type="submit"
        className="text-sm font-semibold text-red-300"
        onClick={(event) => {
          if (!window.confirm("Remove this copy from the shelf?")) event.preventDefault();
        }}
      >
        Remove
      </button>
    </form>
  );
}
