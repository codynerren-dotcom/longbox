import { prisma } from "@/lib/db";
import { decryptSecret, encryptSecret } from "@/lib/settings/crypto";
import { ensureSecretKey } from "@/lib/settings/key";
import {
  isSecretKey,
  readEnv,
  SEED_ON_EMPTY_KEY,
  buildConfig,
  toSettingsView,
  type EnvSnapshot,
  type IntegrationConfig,
  type SecretKey,
  type SettingsView,
  type StoredSettings,
} from "@/lib/settings/resolve";

export type SettingRow = { key: string; secret: string | null; plain: string | null };

export type SettingsRepository = {
  readAll: () => Promise<SettingRow[]>;
  upsert: (row: SettingRow) => Promise<void>;
  delete: (key: string) => Promise<void>;
};

const MAX_SECRET = 2000;

export function createSettingsService(deps: { repo: SettingsRepository; key: Buffer; env: EnvSnapshot }) {
  return {
    async get(): Promise<IntegrationConfig> {
      return buildConfig(await readStored(deps.repo, deps.key), deps.env);
    },
    async view(): Promise<SettingsView> {
      return toSettingsView(await this.get());
    },
    async saveSecret(key: SecretKey, value: string): Promise<void> {
      const trimmed = value.trim();
      if (!trimmed) return;
      if (trimmed.length > MAX_SECRET) throw new Error("That value is too long.");
      await deps.repo.upsert({ key, secret: encryptSecret(trimmed, deps.key), plain: null });
    },
    async clearSecret(key: SecretKey): Promise<void> {
      await deps.repo.delete(key);
    },
    async setSeedOnEmpty(enabled: boolean): Promise<void> {
      await deps.repo.upsert({ key: SEED_ON_EMPTY_KEY, secret: null, plain: enabled ? "true" : "false" });
    },
  };
}

async function readStored(repo: SettingsRepository, key: Buffer): Promise<StoredSettings> {
  const rows = await repo.readAll();
  const secrets: StoredSettings["secrets"] = {};
  let seedOnEmpty: string | null = null;
  for (const row of rows) {
    if (row.key === SEED_ON_EMPTY_KEY) {
      seedOnEmpty = row.plain;
      continue;
    }
    if (!isSecretKey(row.key) || !row.secret) continue;
    secrets[row.key] = decryptSecret(row.secret, key);
  }
  return { secrets, seedOnEmpty };
}

export const prismaSettings: SettingsRepository = {
  async readAll() {
    const rows = await prisma.appSetting.findMany();
    return rows.map((row) => ({ key: row.key, secret: row.secret, plain: row.plain }));
  },
  async upsert(row) {
    await prisma.appSetting.upsert({
      where: { key: row.key },
      create: { key: row.key, secret: row.secret, plain: row.plain },
      update: { secret: row.secret, plain: row.plain },
    });
  },
  async delete(key) {
    await prisma.appSetting.deleteMany({ where: { key } });
  },
};

function liveService() {
  return createSettingsService({
    repo: prismaSettings,
    key: ensureSecretKey(),
    env: readEnv(),
  });
}

export async function getSettings(): Promise<IntegrationConfig> {
  return liveService().get();
}

export async function getSettingsView(): Promise<SettingsView> {
  return liveService().view();
}

export async function saveSecret(key: SecretKey, value: string): Promise<void> {
  await liveService().saveSecret(key, value);
}

export async function clearSecret(key: SecretKey): Promise<void> {
  await liveService().clearSecret(key);
}

export async function setSeedOnEmpty(enabled: boolean): Promise<void> {
  await liveService().setSeedOnEmpty(enabled);
}

export function shouldSeedShelf(enabled: boolean, comicCount: number): boolean {
  return enabled && comicCount === 0;
}
