import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CatalogIdLink, LinkedJson, LinkedMessage } from "@/components/catalog-id-link";
import { catalogMentions } from "@/lib/catalog-id-text";

describe("catalog id links", () => {
  it("opens the catalog page for the id in a new tab", () => {
    const html = renderToStaticMarkup(
      createElement(
        "div",
        null,
        createElement(CatalogIdLink, { kind: "metron-issue", id: "50", siteUrl: "https://metron.cloud/issue/saga-2012-1/" }),
        createElement(CatalogIdLink, { kind: "metron-series", id: "15" }),
        createElement(CatalogIdLink, { kind: "comicvine-issue", id: "400" }),
        createElement(CatalogIdLink, { kind: "comicvine-series", id: "77" }),
        createElement(CatalogIdLink, { kind: "gcd-issue", id: "256114" }),
        createElement(CatalogIdLink, { kind: "gcd-series", id: "99" }),
      ),
    );
    expect(html).toContain('href="https://metron.cloud/issue/saga-2012-1/"');
    expect(html).toContain('href="https://metron.cloud/series/15/"');
    expect(html).toContain('href="https://comicvine.gamespot.com/issue/4000-400/"');
    expect(html).toContain('href="https://comicvine.gamespot.com/volume/4050-77/"');
    expect(html).toContain('href="https://www.comics.org/issue/256114/"');
    expect(html).toContain('href="https://www.comics.org/series/99/"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain(">50<");
    expect(html).not.toContain("saga-2012-1</a>");
  });

  it("leaves a log line alone except for the catalog ids", () => {
    const parts = catalogMentions("Saga #1 linked Metron 50 from Comic Vine 400. Stored GCD 256114. Metron returned 429.");
    expect(parts.filter((part) => part.kind === "id")).toEqual([
      { kind: "id", catalog: "metron-issue", id: "50" },
      { kind: "id", catalog: "comicvine-issue", id: "400" },
      { kind: "id", catalog: "gcd-issue", id: "256114" },
    ]);
    expect(catalogMentions("Several Metron issues share Comic Vine 400 (50, 51).").filter((part) => part.kind === "id")).toEqual([
      { kind: "id", catalog: "comicvine-issue", id: "400" },
      { kind: "id", catalog: "metron-issue", id: "50" },
      { kind: "id", catalog: "metron-issue", id: "51" },
    ]);
    const html = renderToStaticMarkup(createElement(LinkedMessage, { text: "Stored Comic Vine 400 from Metron 50." }));
    expect(html).toContain('href="https://comicvine.gamespot.com/issue/4000-400/"');
    expect(html).toContain('href="https://metron.cloud/issue/50/"');
    expect(html).toContain(">400<");
    expect(html).toContain(">50<");
  });

  it("links catalog ids inside log details and still redacts secrets", () => {
    const html = renderToStaticMarkup(
      createElement(LinkedJson, {
        value: {
          metronIssueId: "50",
          comicvineSeriesId: "77",
          gcdIssueId: "256114",
          via: "cv_id",
          foreignId: "400",
          password: "secret",
          note: "Metron series 15",
        },
      }),
    );
    expect(html).toContain('href="https://metron.cloud/issue/50/"');
    expect(html).toContain('href="https://comicvine.gamespot.com/volume/4050-77/"');
    expect(html).toContain('href="https://www.comics.org/issue/256114/"');
    expect(html).toContain('href="https://comicvine.gamespot.com/issue/4000-400/"');
    expect(html).toContain('href="https://metron.cloud/series/15/"');
    expect(html).toContain("redacted");
    expect(html).not.toContain("secret");
  });
});
