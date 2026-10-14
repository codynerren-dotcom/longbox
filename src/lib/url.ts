const LOCAL_COVER =
  /^\/covers\/files\/(?:(?:metron|cv)-\d+(?:-[a-f0-9]{8})?\.(?:jpg|jpeg|png|webp|gif)|user-[a-z0-9]{20,32}\.webp)(?:\?v=\d{1,16})?$/;

export function safeImageUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  if (LOCAL_COVER.test(url)) return url;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:" || parsed.protocol === "http:") return parsed.toString();
  } catch {
    return null;
  }
  return null;
}
