import { describe, expect, it } from "vitest";
import { orderSeriesCards } from "@/lib/collection";
import { buildBackup, renderClzCsv } from "@/lib/export";
import { formatDate, formatMoney } from "@/lib/format";
import { duplicateGroups, isDemoCoreId, searchIndexFields } from "@/lib/maintenance";
import { decryptSecret, encryptSecret, parseSecretKey } from "@/lib/settings/crypto";
import {
  defaultPreferences,
  normalizePreferences,
  parsePreferences,
  preferencesFromForm,
  PREFERENCES_KEY,
} from "@/lib/settings/preferences";
import { readEnv } from "@/lib/settings/resolve";
import { createSettingsService, type SettingRow, type SettingsRepository } from "@/lib/settings/service";

const key = parseSecretKey(Buffer.alloc(32, 9).toString("base64"));

function memoryRepo(rows: SettingRow[] = []): SettingsRepository & { rows: SettingRow[] } {
  const stored = [...rows];
  return {
    rows: stored,
    async readAll() {
      return stored.map((row) => ({ ...row }));
    },
    async upsert(row) {
      const index = stored.findIndex((item) => item.key === row.key);
      if (index >= 0) stored[index] = row;
      else stored.push(row);
    },
    async delete(keyName) {
      const index = stored.findIndex((item) => item.key === keyName);
      if (index >= 0) stored.splice(index, 1);
    },
  };
}

describe("shelf preferences", () => {
  it("uses America/Chicago, weekly keys, and monthly other issues by default", () => {
    const prefs = defaultPreferences();
    expect(prefs.display.timeZone).toBe("America/Chicago");
    expect(prefs.display.clock).toBe("12");
    expect(prefs.pricing.enabled).toBe(false);
    expect(prefs.pricing.keyCadence).toBe("weekly");
    expect(prefs.pricing.otherCadence).toBe("monthly");
    expect(prefs.collection.gradingCompanies).toEqual(["CGC", "CBCS", "PGX"]);
    expect(prefs.covers.paused).toBe(false);
    expect(prefs.logs.retentionDays).toBe(30);
  });

  it("round-trips saved preferences and ignores unknown keys", async () => {
    const repo = memoryRepo();
    const service = createSettingsService({ repo, key, env: readEnv({} as NodeJS.ProcessEnv) });
    const saved = await service.savePreferences({
      display: { accent: "blue", timeZone: "America/Chicago", nope: true },
      pricing: { enabled: true, currency: "CAD", keyCadence: "weekly", otherCadence: "monthly" },
      covers: { paused: true },
      extra: { ignored: true },
    });
    expect(saved.display.accent).toBe("blue");
    expect(saved.pricing.currency).toBe("CAD");
    expect(saved.pricing.enabled).toBe(true);
    expect(saved.covers.paused).toBe(true);
    expect(saved.collection.sort).toBe("series");
    const stored = repo.rows.find((row) => row.key === PREFERENCES_KEY);
    expect(stored?.secret).toBeNull();
    expect(JSON.parse(stored?.plain ?? "{}")).not.toHaveProperty("extra");
    expect(JSON.parse(stored?.plain ?? "{}").display).not.toHaveProperty("nope");
    expect(await service.getPreferences()).toEqual(saved);
  });

  it("keeps the cover pause flag when the preferences form is saved", () => {
    const current = normalizePreferences({ covers: { paused: true } });
    const form = new FormData();
    form.set("sort", "added");
    form.set("density", "compact");
    form.set("showSold", "on");
    form.set("accent", "green");
    form.set("clock", "24");
    form.set("dateFormat", "ymd");
    form.set("timeZone", "Not/AZone");
    form.set("currency", "GBP");
    form.set("keyCadence", "monthly");
    form.set("otherCadence", "weekly");
    form.set("camera", "user");
    form.set("scanMode", "auto");
    form.set("beep", "on");
    form.set("gradingCompanies", "CGC\n\nCGC\nCBCS");
    form.set("keyCategories", "");
    const next = preferencesFromForm(form, current);
    expect(next.covers.paused).toBe(true);
    expect(next.collection.sort).toBe("added");
    expect(next.collection.density).toBe("compact");
    expect(next.collection.showSold).toBe(true);
    expect(next.collection.gradingCompanies).toEqual(["CGC", "CBCS"]);
    expect(next.collection.keyCategories).toEqual([]);
    expect(next.display.accent).toBe("green");
    expect(next.display.clock).toBe("24");
    expect(next.display.timeZone).toBe("America/Chicago");
    expect(next.pricing.currency).toBe("GBP");
    expect(next.pricing.enabled).toBe(false);
    expect(next.scanning.camera).toBe("user");
    expect(next.scanning.mode).toBe("auto");
    expect(next.scanning.beep).toBe(true);
    expect(next.scanning.vibrate).toBe(false);
    expect(next.logs.retentionDays).toBe(30);
  });

  it("falls back when stored JSON is junk", () => {
    expect(parsePreferences("not-json").display.accent).toBe("yellow");
    expect(parsePreferences(JSON.stringify({ display: { accent: "purple" } })).display.accent).toBe("yellow");
  });

  it("does not mix preferences into secret storage", async () => {
    const secret = encryptSecret("metron-user", key);
    const repo = memoryRepo([{ key: "metron.username", secret, plain: null }]);
    const service = createSettingsService({ repo, key, env: readEnv({} as NodeJS.ProcessEnv) });
    await service.savePreferences({ scanning: { beep: true } });
    const config = await service.get();
    expect(config.metron.username).toBe("metron-user");
    expect(decryptSecret(secret, key)).toBe("metron-user");
    expect((await service.getPreferences()).scanning.beep).toBe(true);
  });
});

describe("maintenance and export", () => {
  it("groups shared barcodes and identical copies, and recognizes demo ids", () => {
    const groups = duplicateGroups([
      { id: "1", series: "Saga", issue: "1", variant: null, barcode: "07596060000100001" },
      { id: "2", series: "Saga", issue: "2", variant: null, barcode: "07596060000100001" },
      { id: "3", series: "Paper Girls", issue: "1", variant: "Cover B", barcode: "" },
      { id: "4", series: "Paper Girls", issue: "1", variant: "cover b", barcode: null },
      { id: "5", series: "Paper Girls", issue: "2", variant: null, barcode: null },
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0].map((comic) => comic.id)).toEqual(["1", "2"]);
    expect(groups[1].map((comic) => comic.id)).toEqual(["3", "4"]);
    expect(isDemoCoreId("900001")).toBe(true);
    expect(isDemoCoreId("900030")).toBe(true);
    expect(isDemoCoreId("900031")).toBe(false);
    expect(isDemoCoreId("0")).toBe(false);
    expect(isDemoCoreId("")).toBe(false);
  });

  it("rebuilds series and issue sort fields", () => {
    expect(searchIndexFields({ series: "Saga", issueNo: "12" })).toEqual({ seriesSort: "saga", issueSort: 12 });
    expect(searchIndexFields({ series: "Saga", issueNo: "12A" }).issueSort).toBeNull();
  });

  it("sorts series cards by publisher", () => {
    const cards = orderSeriesCards(
      [
        { id: "b", series: "Saga", publisher: "Image" },
        { id: "a", series: "Batman", publisher: "DC" },
      ],
      new Map(),
      "publisher",
    );
    expect(cards.map((card) => card.series)).toEqual(["Batman", "Saga"]);
  });

  it("exports CLZ rows from the stored raw row and keeps backup secrets encrypted", () => {
    const csv = renderClzCsv([
      {
        series: "Saga",
        rawRow: { Series: "Saga", Issue: "1", Notes: "Bought, \"near mint\"" },
      },
    ]);
    expect(csv.startsWith("Series,Issue,")).toBe(true);
    expect(csv).toContain("\"Bought, \"\"near mint\"\"\"");
    const backup = buildBackup({
      comics: [{ series: "Saga", purchasePrice: { toString: () => "9.99", toFixed: () => "9.99" } }],
      wishlist: [],
      priceSnapshots: [],
      settings: [{ key: "metron.password", secret: "v1.ciphertext", plain: null }],
      imports: [],
    });
    expect(backup.settings).toEqual([{ key: "metron.password", secret: "v1.ciphertext", plain: null }]);
    expect(JSON.stringify(backup)).not.toContain("plaintext-password");
    expect((backup.comics as Array<{ purchasePrice: string }>)[0].purchasePrice).toBe("9.99");
  });

  it("formats dates in the saved timezone and currency", () => {
    const noon = new Date("2020-06-15T12:00:00.000Z");
    expect(formatDate(noon)).toBe("Jun 15, 2020");
    expect(formatDate(noon, { timeZone: "America/Chicago", dateFormat: "dmy" })).toBe("15 Jun 2020");
    expect(formatDate(noon, { timeZone: "America/Chicago", dateFormat: "mdy", clock: "12", withTime: true })).toMatch(/Jun 15, 2020, 0?7:00\s*AM/);
    expect(formatDate(noon, { timeZone: "America/Chicago", dateFormat: "ymd", clock: "24", withTime: true })).toMatch(/2020 Jun 15, 0?7:00/);
    expect(formatMoney(12.5, "CAD")).toMatch(/12\.50/);
    expect(formatMoney(12.5)).toBe("$12.50");
  });
});
