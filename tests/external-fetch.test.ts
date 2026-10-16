import path from "node:path";
import { describe, expect, it } from "vitest";
import { readSourceTree, ungatedExternalFetches, type SourceFile } from "./external-fetch-scan";

function file(source: string): SourceFile[] {
  return [{ path: "src/example.ts", source }];
}

describe("external fetch gate", () => {
  it("allows a fetch that reserved a window first", () => {
    const source = `
      async function load() {
        await reserveGcdRequest();
        await fetch(url);
      }
    `;
    expect(ungatedExternalFetches(file(source))).toEqual([]);
  });

  it("fails when fetch talks to an external host with no limiter", () => {
    const source = `
      async function load() {
        await fetch("https://example.com/api");
      }
    `;
    const hits = ungatedExternalFetches(file(source));
    expect(hits).toHaveLength(1);
    expect(hits[0]?.text).toContain("https://example.com/api");
  });

  it("fails when the URL is built at runtime and nothing reserved a window", () => {
    const source = `
      async function load(url: string) {
        return fetch(url);
      }
    `;
    expect(ungatedExternalFetches(file(source))).toHaveLength(1);
  });

  it("allows same-origin app routes", () => {
    const source = `
      async function load(barcode: string) {
        await fetch(\`/api/lookup?barcode=\${barcode}\`);
        await fetch("/api/health");
      }
    `;
    expect(ungatedExternalFetches(file(source))).toEqual([]);
  });

  it("requires the caller of loggedFetch to reserve, not the helper itself", () => {
    const open = `
      async function loggedFetch(fetchImpl: typeof fetch, url: string) {
        return fetchImpl(url);
      }
      async function probe() {
        await loggedFetch(fetch, "https://api.example.com/token");
      }
    `;
    expect(ungatedExternalFetches(file(open))).toHaveLength(1);
    const gated = open.replace(
      "async function probe() {",
      "async function probe() {\n        await reserveEbayRequest();",
    );
    expect(ungatedExternalFetches(file(gated))).toEqual([]);
  });

  it("the shelf source has no ungated external fetch", () => {
    const hits = ungatedExternalFetches(readSourceTree(path.resolve(__dirname, "..")));
    expect(hits).toEqual([]);
  });
});
