import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const swSource = readFileSync("public/sw.js", "utf8");
const loadWorker = new Function(`${swSource}\nreturn { isCacheableAppResponse };`) as () => {
  isCacheableAppResponse: (
    response: {
      ok: boolean;
      type: string;
      redirected: boolean;
      url: string;
      headers: { get(name: string): string | null };
    },
    requestPath: string,
    origin: string,
  ) => boolean;
};
const { isCacheableAppResponse } = loadWorker();

const origin = "https://longbox.codyscasa.com";

function response(partial: {
  status?: number;
  type?: string;
  redirected?: boolean;
  url: string;
  headers?: Record<string, string>;
}) {
  const status = partial.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    type: partial.type ?? "basic",
    redirected: partial.redirected ?? false,
    url: partial.url,
    headers: new Headers(partial.headers),
  };
}

describe("service worker Access cache", () => {
  it("stores the app shell and the manifest only when they are same-origin 200s", () => {
    expect(
      isCacheableAppResponse(
        response({ url: `${origin}/`, headers: { "content-type": "text/html; charset=utf-8" } }),
        "/",
        origin,
      ),
    ).toBe(true);
    expect(
      isCacheableAppResponse(
        response({
          url: `${origin}/manifest.webmanifest`,
          headers: { "content-type": "application/manifest+json" },
        }),
        "/manifest.webmanifest",
        origin,
      ),
    ).toBe(true);
  });

  it("refuses Access redirects and login pages", () => {
    expect(
      isCacheableAppResponse(
        response({
          status: 302,
          redirected: true,
          url: "https://codyscasa.cloudflareaccess.com/cdn-cgi/access/login/longbox.codyscasa.com",
          headers: { location: "https://codyscasa.cloudflareaccess.com/cdn-cgi/access/login/longbox.codyscasa.com" },
        }),
        "/",
        origin,
      ),
    ).toBe(false);
    expect(
      isCacheableAppResponse(
        response({
          type: "opaqueredirect",
          status: 0,
          url: `${origin}/`,
        }),
        "/",
        origin,
      ),
    ).toBe(false);
    expect(
      isCacheableAppResponse(
        response({
          url: "https://codyscasa.cloudflareaccess.com/cdn-cgi/access/login/longbox.codyscasa.com",
          headers: { "content-type": "text/html" },
        }),
        "/",
        origin,
      ),
    ).toBe(false);
    expect(
      isCacheableAppResponse(
        response({
          url: `${origin}/cdn-cgi/access/login`,
          headers: { "content-type": "text/html" },
        }),
        "/",
        origin,
      ),
    ).toBe(false);
    expect(
      isCacheableAppResponse(
        response({
          url: `${origin}/manifest.webmanifest`,
          headers: { "content-type": "text/html" },
        }),
        "/manifest.webmanifest",
        origin,
      ),
    ).toBe(false);
  });

  it("fetches precache candidates without following redirects", () => {
    expect(swSource).toContain('redirect: "manual"');
    expect(swSource).toContain('credentials: "include"');
    expect(swSource).toContain("isCacheableAppResponse");
    expect(swSource).not.toContain("cache.addAll");
  });
});

describe("manifest credentials", () => {
  it("asks the browser to send the Access cookie with the manifest", () => {
    const layout = readFileSync("src/app/layout.tsx", "utf8");
    expect(layout).toContain('rel="manifest"');
    expect(layout).toContain('href="/manifest.webmanifest"');
    expect(layout).toContain('crossOrigin="use-credentials"');
    expect(layout).not.toContain('manifest: "/manifest.webmanifest"');
    const example = readFileSync(".env.example", "utf8");
    const readme = readFileSync("README.md", "utf8");
    expect(example).toContain("LONGBOX_LOG=off");
    expect(readme).toContain("LONGBOX_LOG");
    expect(readme).toContain("https://longbox.codyscasa.com");
    expect(readme).toContain("crossorigin=\"use-credentials\"");
  });
});
