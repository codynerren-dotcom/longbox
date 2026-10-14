import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CoverTile } from "@/components/cover-tile";
import { KeyBadge, keyTone } from "@/components/key-badge";

function rule(css: string, name: string): string {
  const start = css.indexOf(name);
  expect(start).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf("}", start));
}

describe("key badges", () => {
  it("paints major keys gold and keeps minor keys off the accent", () => {
    expect(keyTone("Major")).toBe("major");
    expect(keyTone(" minor ")).toBe("minor");
    expect(keyTone("No")).toBeNull();
    expect(keyTone(null)).toBeNull();

    const major = renderToStaticMarkup(createElement(KeyBadge, { level: "Major" }));
    const minor = renderToStaticMarkup(createElement(KeyBadge, { level: "Minor", variant: "icon" }));
    const hidden = renderToStaticMarkup(createElement(KeyBadge, { level: "No" }));
    expect(major).toContain("key-major");
    expect(major).toContain("Major");
    expect(major).not.toContain("text-comic");
    expect(major).not.toContain("bg-comic");
    expect(minor).toContain("key-minor");
    expect(minor).toContain("Minor key");
    expect(minor).not.toContain("key-major");
    expect(minor).not.toContain("text-comic");
    expect(hidden).toBe("");
    expect(renderToStaticMarkup(createElement(KeyBadge, { level: "First" }))).toContain("First");

    const css = readFileSync("src/app/globals.css", "utf8");
    const majorRule = rule(css, ".key-major");
    const minorRule = rule(css, ".key-minor");
    expect(majorRule).toMatch(/#d4af37/i);
    expect(majorRule).toMatch(/#1a1408/i);
    expect(majorRule).toMatch(/linear-gradient/);
    expect(majorRule).not.toMatch(/accent|--accent|comic/);
    expect(minorRule).toMatch(/#2a2e38/i);
    expect(minorRule).toMatch(/#d7dbe4/i);
    expect(minorRule).not.toMatch(/accent|--accent|#d4af37/i);

    const tile = renderToStaticMarkup(createElement(CoverTile, { title: "Saga", issue: "1", keyLevel: "Major" }));
    expect(tile).toContain("key-major");
    expect(tile).not.toMatch(/bg-comic/);
    const rows = readFileSync("src/app/series/series-rows.tsx", "utf8");
    const scan = readFileSync("src/app/scan/scan-client.tsx", "utf8");
    expect(rows).toContain('variant="icon"');
    expect(rows).not.toContain("bg-comic/15");
    expect(scan).toContain("<KeyBadge");
  });
});
