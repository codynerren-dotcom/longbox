const LOCAL_COVER = /^\/covers\/files\/metron-\d+\.(?:jpg|jpeg|png|webp|gif)$/;

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
