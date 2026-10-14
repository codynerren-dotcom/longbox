export type CatalogSource = "local" | "metron" | "gcd";

export type CatalogMatch = {
  source: CatalogSource;
  externalId: string;
  series: string;
  issueNo: string;
  title: string;
  publisher: string | null;
  coverUrl: string | null;
  coverDate: string | null;
  barcode: string | null;
  plot: string | null;
  variant: string | null;
  coreSeriesId: string | null;
  ownedId: string | null;
};

export type AddComicInput = {
  series: string;
  issueNo: string;
  publisher?: string | null;
  coverUrl?: string | null;
  coverDate?: string | null;
  barcode?: string | null;
  plot?: string | null;
  variant?: string | null;
  variantDescription?: string | null;
  source: CatalogSource | "manual";
  externalId?: string | null;
  coreSeriesId?: string | null;
};
