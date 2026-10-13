/** Exact CLZ Comics export header, in order. All 66 columns are required. */
export const CLZ_HEADERS = [
  "Series",
  "Issue",
  "Variant Description",
  "Publisher",
  "Release Date",
  "Format",
  "Added Date",
  "Issue No.",
  "Cover Date",
  "Barcode",
  "Story Arc",
  "Grade",
  "Raw / Slabbed",
  "Key",
  "Key Category",
  "Key Reason",
  "Purchase Price",
  "Price Sold",
  "CovrPrice Value",
  "Cover Price",
  "Notes",
  "Quantity",
  "Storage Box",
  "Age",
  "Core ComicID",
  "Core SeriesID",
  "Country",
  "Crossover",
  "Full Title",
  "Genre",
  "Imprint",
  "Language",
  "Release Year",
  "Series Group",
  "Subtitle",
  "Title",
  "Variant",
  "Cover Year",
  "No. of Pages",
  "Added Year",
  "Bag/Board Date",
  "Bag/Board Year",
  "Collection Status",
  "Index",
  "Modified Date",
  "My Rating",
  "Owner",
  "Plot",
  "Read",
  "Read Date",
  "Read Year",
  "Tags",
  "Custom Label",
  "Grader Notes",
  "Grading Company",
  "Label Type",
  "My Value",
  "Page Quality",
  "Purchase Date",
  "Purchase Store",
  "Purchase Year",
  "Signed by",
  "Slab Certification Number",
  "Sold Date",
  "Sold Year",
  "Value",
] as const;

export type ClzHeader = (typeof CLZ_HEADERS)[number];

export const CLZ_HEADER_LINE = CLZ_HEADERS.map(encodeCsvField).join(",");

export function encodeCsvField(value: string): string {
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export function encodeCsv(rows: string[][]): string {
  return rows.map((row) => row.map(encodeCsvField).join(",")).join("\n") + "\n";
}
