/** A GCD issue id, or a comics.org issue URL such as https://www.comics.org/issue/2513854/. */
export function parseGcdIssueRef(input: string): string | null {
  const trimmed = input.trim();
  if (/^\d{1,12}$/.test(trimmed)) return trimmed === "0" ? null : trimmed;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (host !== "comics.org") return null;
  const match = url.pathname.match(/^\/issue\/(\d{1,12})\/?$/);
  if (!match?.[1] || match[1] === "0") return null;
  return match[1];
}
