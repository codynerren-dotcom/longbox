import type { DateDisplay } from "@/lib/format";

export const PREFERENCES_KEY = "preferences";

export const COLLECTION_SORTS = ["series", "publisher", "added", "coverYear"] as const;
export const DENSITIES = ["compact", "regular", "large"] as const;
export const ACCENTS = ["yellow", "red", "blue", "green"] as const;
export const CLOCKS = ["12", "24"] as const;
export const DATE_FORMATS = ["mdy", "dmy", "ymd"] as const;
export const CURRENCIES = ["USD", "CAD", "GBP", "EUR"] as const;
export const CADENCES = ["weekly", "monthly"] as const;
export const CAMERAS = ["environment", "user"] as const;
export const SCAN_MODES = ["confirm", "auto"] as const;
export const TIME_ZONES = ["America/Chicago", "America/New_York", "America/Denver", "America/Los_Angeles", "America/Phoenix", "UTC"] as const;

export type CollectionSort = (typeof COLLECTION_SORTS)[number];
export type Density = (typeof DENSITIES)[number];
export type Accent = (typeof ACCENTS)[number];
export type Clock = (typeof CLOCKS)[number];
export type DateFormat = (typeof DATE_FORMATS)[number];
export type CurrencyCode = (typeof CURRENCIES)[number];
export type Cadence = (typeof CADENCES)[number];
export type CameraFacing = (typeof CAMERAS)[number];
export type ScanMode = (typeof SCAN_MODES)[number];

export const ACCENT_RGB: Record<Accent, string> = {
  yellow: "255 204 26",
  red: "226 61 61",
  blue: "76 141 255",
  green: "61 220 151",
};

export const DEFAULT_GRADING_COMPANIES = ["CGC", "CBCS", "PGX"];
export const DEFAULT_KEY_CATEGORIES = ["First appearance", "Origin", "Death", "Storyline"];
export const DEFAULT_LOG_RETENTION_DAYS = 30;
export const MIN_LOG_RETENTION_DAYS = 1;
export const MAX_LOG_RETENTION_DAYS = 3650;

export type ShelfPreferences = {
  collection: {
    sort: CollectionSort;
    density: Density;
    showSold: boolean;
    defaultStorageBox: string;
    gradingCompanies: string[];
    keyCategories: string[];
  };
  display: {
    accent: Accent;
    clock: Clock;
    dateFormat: DateFormat;
    timeZone: string;
  };
  pricing: {
    enabled: boolean;
    currency: CurrencyCode;
    keyCadence: Cadence;
    otherCadence: Cadence;
  };
  scanning: {
    camera: CameraFacing;
    mode: ScanMode;
    beep: boolean;
    vibrate: boolean;
  };
  covers: {
    paused: boolean;
  };
  logs: {
    retentionDays: number;
  };
};

export function defaultPreferences(): ShelfPreferences {
  return {
    collection: {
      sort: "series",
      density: "regular",
      showSold: true,
      defaultStorageBox: "",
      gradingCompanies: [...DEFAULT_GRADING_COMPANIES],
      keyCategories: [...DEFAULT_KEY_CATEGORIES],
    },
    display: {
      accent: "yellow",
      clock: "12",
      dateFormat: "mdy",
      timeZone: "America/Chicago",
    },
    pricing: {
      enabled: false,
      currency: "USD",
      keyCadence: "weekly",
      otherCadence: "monthly",
    },
    scanning: {
      camera: "environment",
      mode: "confirm",
      beep: false,
      vibrate: false,
    },
    covers: { paused: false },
    logs: { retentionDays: DEFAULT_LOG_RETENTION_DAYS },
  };
}

export function parsePreferences(raw: string | null | undefined): ShelfPreferences {
  if (!raw?.trim()) return defaultPreferences();
  try {
    return normalizePreferences(JSON.parse(raw) as unknown);
  } catch {
    return defaultPreferences();
  }
}

export function normalizePreferences(input: unknown, base: ShelfPreferences = defaultPreferences()): ShelfPreferences {
  const source = object(input);
  const collection = object(source.collection);
  const display = object(source.display);
  const pricing = object(source.pricing);
  const scanning = object(source.scanning);
  const covers = object(source.covers);
  const logs = object(source.logs);
  return {
    collection: {
      sort: oneOf(collection.sort, COLLECTION_SORTS, base.collection.sort),
      density: oneOf(collection.density, DENSITIES, base.collection.density),
      showSold: flag(collection.showSold, base.collection.showSold),
      defaultStorageBox: text(collection.defaultStorageBox, base.collection.defaultStorageBox, 80),
      gradingCompanies: collection.gradingCompanies === undefined ? base.collection.gradingCompanies : stringList(collection.gradingCompanies),
      keyCategories: collection.keyCategories === undefined ? base.collection.keyCategories : stringList(collection.keyCategories),
    },
    display: {
      accent: oneOf(display.accent, ACCENTS, base.display.accent),
      clock: oneOf(display.clock, CLOCKS, base.display.clock),
      dateFormat: oneOf(display.dateFormat, DATE_FORMATS, base.display.dateFormat),
      timeZone: timeZone(display.timeZone, base.display.timeZone),
    },
    pricing: {
      enabled: flag(pricing.enabled, base.pricing.enabled),
      currency: oneOf(pricing.currency, CURRENCIES, base.pricing.currency),
      keyCadence: oneOf(pricing.keyCadence, CADENCES, base.pricing.keyCadence),
      otherCadence: oneOf(pricing.otherCadence, CADENCES, base.pricing.otherCadence),
    },
    scanning: {
      camera: oneOf(scanning.camera, CAMERAS, base.scanning.camera),
      mode: oneOf(scanning.mode, SCAN_MODES, base.scanning.mode),
      beep: flag(scanning.beep, base.scanning.beep),
      vibrate: flag(scanning.vibrate, base.scanning.vibrate),
    },
    covers: {
      paused: flag(covers.paused, base.covers.paused),
    },
    logs: {
      retentionDays: retentionDays(logs.retentionDays, base.logs.retentionDays),
    },
  };
}

export function preferencesFromForm(form: FormData, current: ShelfPreferences): ShelfPreferences {
  return normalizePreferences(
    {
      collection: {
        sort: form.get("sort"),
        density: form.get("density"),
        showSold: form.get("showSold") === "on",
        defaultStorageBox: form.get("defaultStorageBox"),
        gradingCompanies: lines(form.get("gradingCompanies")),
        keyCategories: lines(form.get("keyCategories")),
      },
      display: {
        accent: form.get("accent"),
        clock: form.get("clock"),
        dateFormat: form.get("dateFormat"),
        timeZone: form.get("timeZone"),
      },
      pricing: {
        enabled: form.get("pricingEnabled") === "on",
        currency: form.get("currency"),
        keyCadence: form.get("keyCadence"),
        otherCadence: form.get("otherCadence"),
      },
      scanning: {
        camera: form.get("camera"),
        mode: form.get("scanMode"),
        beep: form.get("beep") === "on",
        vibrate: form.get("vibrate") === "on",
      },
      covers: current.covers,
      logs: {
        retentionDays: form.has("logRetentionDays") ? form.get("logRetentionDays") : current.logs.retentionDays,
      },
    },
    current,
  );
}

export function dateOptions(prefs: ShelfPreferences, withTime = false): DateDisplay {
  return {
    dateFormat: prefs.display.dateFormat,
    timeZone: prefs.display.timeZone,
    clock: prefs.display.clock,
    withTime,
  };
}

export function collectionGridClass(density: Density): string {
  if (density === "compact") return "grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8";
  if (density === "large") return "grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3";
  return "grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5";
}

function lines(value: FormDataEntryValue | null): string[] {
  return String(value ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function flag(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "off"].includes(normalized)) return false;
  }
  return fallback;
}

function text(value: unknown, fallback: string, max: number): string {
  if (typeof value !== "string") return fallback;
  return value.trim().slice(0, max);
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const list: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim().slice(0, 60);
    const key = trimmed.toLowerCase();
    if (!trimmed || seen.has(key)) continue;
    seen.add(key);
    list.push(trimmed);
    if (list.length >= 40) break;
  }
  return list;
}

export function retentionDays(value: unknown, fallback = DEFAULT_LOG_RETENTION_DAYS): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(MAX_LOG_RETENTION_DAYS, Math.max(MIN_LOG_RETENTION_DAYS, Math.round(parsed)));
}

function timeZone(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 80) return fallback;
  try {
    Intl.DateTimeFormat("en-US", { timeZone: trimmed }).format(new Date());
    return trimmed;
  } catch {
    return fallback;
  }
}
