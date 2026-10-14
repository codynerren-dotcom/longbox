import { coverContentType, coversDir, readCoverBytes } from "@/lib/covers/files";

export async function GET(_request: Request, context: { params: Promise<{ name: string }> }) {
  const { name } = await context.params;
  const type = coverContentType(name);
  const bytes = type ? await readCoverBytes(coversDir(), name) : null;
  if (!type || !bytes) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": type,
      "Cache-Control": name.startsWith("user-") ? "no-cache" : "public, max-age=86400",
    },
  });
}
