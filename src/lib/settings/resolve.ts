export const PLAIN_KEYS = ["metron.username", "gcd.username", "ebay.clientId"] as const;
export const SECRET_KEYS = ["metron.password", "gcd.password", "comicvine.apiKey", "ebay.clientSecret"] as const;
export const CREDENTIAL_KEYS = [...PLAIN_KEYS, ...SECRET_KEYS] as const;

export type PlainKey = (typeof PLAIN_KEYS)[number];
export type SecretKey = (typeof SECRET_KEYS)[number];
export type CredentialKey = (typeof CREDENTIAL_KEYS)[number];

export const SEED_ON_EMPTY_KEY = "seedOnEmpty";

export const SECRET_MASK = "••••••••";

export type ValueSource = "database" | "environment" | "unset";

export type EnvSnapshot = {
  metronUsername: string;
  metronPassword: string;
  metronToken: string;
  metronBase: string;
  gcdUsername: string;
  gcdPassword: string;
  comicvineApiKey: string;
  ebayClientId: string;
  ebayClientSecret: string;
  seedOnEmpty: string;
};

export type StoredSettings = {
  secrets: Partial<Record<CredentialKey, string | null>>;
  seedOnEmpty: string | null;
};

export type ResolvedString = { value: string; source: Exclude<ValueSource, "unset"> } | { value: null; source: "unset" };

export type FieldView =
  | { kind: "plain"; source: ValueSource; value: string; mask: null }
  | { kind: "secret"; source: ValueSource; value: null; mask: typeof SECRET_MASK | null };

export type SettingsView = {
  metron: { username: FieldView; password: FieldView };
  gcd: { username: FieldView; password: FieldView };
  comicvine: { apiKey: FieldView };
  ebay: { clientId: FieldView; clientSecret: FieldView };
  seedOnEmpty: { enabled: boolean; source: "database" | "environment" };
};

export type IntegrationConfig = {
  metron: {
    username: string;
    password: string;
    token: string | null;
    baseUrl: string;
    configured: boolean;
    usernameSource: ValueSource;
    passwordSource: ValueSource;
  };
  gcd: {
    username: string;
    password: string;
    configured: boolean;
    usernameSource: ValueSource;
    passwordSource: ValueSource;
  };
  comicvine: { apiKey: string | null; source: ValueSource; configured: boolean };
  ebay: {
    clientId: string;
    clientSecret: string;
    configured: boolean;
    clientIdSource: ValueSource;
    clientSecretSource: ValueSource;
  };
  seedOnEmpty: { enabled: boolean; source: "database" | "environment" };
};

export function isPlainKey(value: string): value is PlainKey {
  return (PLAIN_KEYS as readonly string[]).includes(value);
}

export function isSecretKey(value: string): value is SecretKey {
  return (SECRET_KEYS as readonly string[]).includes(value);
}

export function isCredentialKey(value: string): value is CredentialKey {
  return (CREDENTIAL_KEYS as readonly string[]).includes(value);
}

export function readEnv(env: NodeJS.ProcessEnv = process.env): EnvSnapshot {
  return {
    metronUsername: env.METRON_USERNAME ?? "",
    metronPassword: env.METRON_PASSWORD ?? "",
    metronToken: env.METRON_API_TOKEN ?? "",
    metronBase: env.METRON_API_BASE || "https://metron.cloud/api",
    gcdUsername: env.GCD_USERNAME ?? "",
    gcdPassword: env.GCD_PASSWORD ?? "",
    comicvineApiKey: env.COMICVINE_API_KEY ?? "",
    ebayClientId: env.EBAY_CLIENT_ID ?? "",
    ebayClientSecret: env.EBAY_CLIENT_SECRET ?? "",
    seedOnEmpty: env.SEED_ON_EMPTY ?? "",
  };
}

export function resolveString(db: string | null | undefined, env: string | null | undefined): ResolvedString {
  const stored = db?.trim() ?? "";
  if (stored) return { value: stored, source: "database" };
  const fallback = env?.trim() ?? "";
  if (fallback) return { value: fallback, source: "environment" };
  return { value: null, source: "unset" };
}

function parseBool(value: string | null | undefined): boolean | null {
  if (value == null) return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  return null;
}

export function resolveBoolean(
  db: string | null | undefined,
  env: string | null | undefined,
  fallback: boolean,
): { value: boolean; source: "database" | "environment" } {
  const stored = parseBool(db);
  if (stored != null) return { value: stored, source: "database" };
  const fromEnv = parseBool(env);
  if (fromEnv != null) return { value: fromEnv, source: "environment" };
  return { value: fallback, source: "environment" };
}

function plainView(source: ValueSource, value: string): FieldView {
  return { kind: "plain", source, value, mask: null };
}

function secretView(source: ValueSource): FieldView {
  return { kind: "secret", source, value: null, mask: source === "unset" ? null : SECRET_MASK };
}

export function buildConfig(stored: StoredSettings, env: EnvSnapshot): IntegrationConfig {
  const username = resolveString(stored.secrets["metron.username"], env.metronUsername);
  const password = resolveString(stored.secrets["metron.password"], env.metronPassword);
  const token = env.metronToken.trim();
  const gcdUsername = resolveString(stored.secrets["gcd.username"], env.gcdUsername);
  const gcdPassword = resolveString(stored.secrets["gcd.password"], env.gcdPassword);
  const comicvine = resolveString(stored.secrets["comicvine.apiKey"], env.comicvineApiKey);
  const clientId = resolveString(stored.secrets["ebay.clientId"], env.ebayClientId);
  const clientSecret = resolveString(stored.secrets["ebay.clientSecret"], env.ebayClientSecret);
  const seed = resolveBoolean(stored.seedOnEmpty, env.seedOnEmpty, false);
  return {
    metron: {
      username: username.value ?? "",
      password: password.value ?? "",
      token: token || null,
      baseUrl: (env.metronBase || "https://metron.cloud/api").replace(/\/$/, ""),
      configured: Boolean((username.value && password.value) || token),
      usernameSource: username.source,
      passwordSource: password.source,
    },
    gcd: {
      username: gcdUsername.value ?? "",
      password: gcdPassword.value ?? "",
      configured: Boolean(gcdUsername.value && gcdPassword.value),
      usernameSource: gcdUsername.source,
      passwordSource: gcdPassword.source,
    },
    comicvine: {
      apiKey: comicvine.value,
      source: comicvine.source,
      configured: Boolean(comicvine.value),
    },
    ebay: {
      clientId: clientId.value ?? "",
      clientSecret: clientSecret.value ?? "",
      configured: Boolean(clientId.value && clientSecret.value),
      clientIdSource: clientId.source,
      clientSecretSource: clientSecret.source,
    },
    seedOnEmpty: { enabled: seed.value, source: seed.source },
  };
}

export function toSettingsView(config: IntegrationConfig): SettingsView {
  return {
    metron: {
      username: plainView(config.metron.usernameSource, config.metron.username),
      password: secretView(config.metron.passwordSource),
    },
    gcd: {
      username: plainView(config.gcd.usernameSource, config.gcd.username),
      password: secretView(config.gcd.passwordSource),
    },
    comicvine: { apiKey: secretView(config.comicvine.source) },
    ebay: {
      clientId: plainView(config.ebay.clientIdSource, config.ebay.clientId),
      clientSecret: secretView(config.ebay.clientSecretSource),
    },
    seedOnEmpty: config.seedOnEmpty,
  };
}

/** Typed form values win. Blank fields keep the saved or environment value. */
export function applyCredentialOverrides(
  config: IntegrationConfig,
  fields: Partial<Record<CredentialKey, string | null | undefined>>,
): IntegrationConfig {
  const typed = (key: CredentialKey): string | null => {
    const value = fields[key];
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  };
  const username = typed("metron.username");
  const password = typed("metron.password");
  const gcdUsername = typed("gcd.username");
  const gcdPassword = typed("gcd.password");
  const apiKey = typed("comicvine.apiKey");
  const clientId = typed("ebay.clientId");
  const clientSecret = typed("ebay.clientSecret");
  const nextUsername = username ?? config.metron.username;
  const nextPassword = password ?? config.metron.password;
  const nextGcdUsername = gcdUsername ?? config.gcd.username;
  const nextGcdPassword = gcdPassword ?? config.gcd.password;
  const nextApiKey = apiKey ?? config.comicvine.apiKey;
  const nextClientId = clientId ?? config.ebay.clientId;
  const nextClientSecret = clientSecret ?? config.ebay.clientSecret;
  return {
    ...config,
    metron: {
      ...config.metron,
      username: nextUsername,
      password: nextPassword,
      configured: Boolean((nextUsername && nextPassword) || config.metron.token),
      usernameSource: username ? "database" : config.metron.usernameSource,
      passwordSource: password ? "database" : config.metron.passwordSource,
    },
    gcd: {
      ...config.gcd,
      username: nextGcdUsername,
      password: nextGcdPassword,
      configured: Boolean(nextGcdUsername && nextGcdPassword),
      usernameSource: gcdUsername ? "database" : config.gcd.usernameSource,
      passwordSource: gcdPassword ? "database" : config.gcd.passwordSource,
    },
    comicvine: {
      ...config.comicvine,
      apiKey: nextApiKey,
      configured: Boolean(nextApiKey),
      source: apiKey ? "database" : config.comicvine.source,
    },
    ebay: {
      ...config.ebay,
      clientId: nextClientId,
      clientSecret: nextClientSecret,
      configured: Boolean(nextClientId && nextClientSecret),
      clientIdSource: clientId ? "database" : config.ebay.clientIdSource,
      clientSecretSource: clientSecret ? "database" : config.ebay.clientSecretSource,
    },
  };
}

export function metronAuthorization(config: IntegrationConfig): { header: string; baseUrl: string } | null {
  if (config.metron.username && config.metron.password) {
    const token = Buffer.from(`${config.metron.username}:${config.metron.password}`).toString("base64");
    return { header: `Basic ${token}`, baseUrl: config.metron.baseUrl };
  }
  if (config.metron.token) return { header: `Bearer ${config.metron.token}`, baseUrl: config.metron.baseUrl };
  return null;
}
