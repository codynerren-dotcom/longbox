export type Viewer = {
  email: string;
  source: "cloudflare-access" | "single-user";
};

/**
 * v1 has no login. If Cloudflare Access is in front of the app it sends
 * `Cf-Access-Authenticated-User-Email`. Trust that header when it is present.
 * Otherwise the shelf belongs to the single configured user.
 *
 * This does not authorize requests. It only identifies who Access says is here
 * so a later version can scope data without changing the deployment.
 */
export function viewerFromHeaders(headers: Headers): Viewer {
  const email = headers.get("cf-access-authenticated-user-email")?.trim();
  if (email) return { email, source: "cloudflare-access" };
  const fallback = process.env.LONGBOX_USER_EMAIL?.trim() || "cody@localhost";
  return { email: fallback, source: "single-user" };
}

export async function getViewer(): Promise<Viewer> {
  const { headers } = await import("next/headers");
  return viewerFromHeaders(await headers());
}
