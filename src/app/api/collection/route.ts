import { revalidatePath } from "next/cache";
import { viewerFromHeaders } from "@/lib/auth";
import type { AddComicInput } from "@/lib/catalog/types";
import { addComics } from "@/lib/mutations";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let body: { items?: AddComicInput[] };
  try {
    body = (await request.json()) as { items?: AddComicInput[] };
  } catch {
    return Response.json({ error: "Expected JSON." }, { status: 400 });
  }
  const items = body.items ?? [];
  if (!Array.isArray(items) || items.length === 0 || items.length > 40) {
    return Response.json({ error: "Send between 1 and 40 comics." }, { status: 400 });
  }
  const viewer = viewerFromHeaders(request.headers);
  const results = await addComics(items, viewer.email);
  revalidatePath("/", "layout");
  return Response.json({ results });
}
