import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = "v1";

export class SettingsCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingsCryptoError";
  }
}

/** Accept a 32-byte key as base64 or hex. */
export function parseSecretKey(raw: string): Buffer {
  const trimmed = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return Buffer.from(trimmed, "hex");
  const decoded = Buffer.from(trimmed, "base64");
  if (decoded.length === 32 && trimmed.length >= 43) return decoded;
  throw new SettingsCryptoError("LONGBOX_SECRET_KEY must be 32 bytes, base64 or hex.");
}

export function encryptSecret(plain: string, key: Buffer, iv = randomBytes(12)): string {
  if (key.length !== 32) throw new SettingsCryptoError("LONGBOX_SECRET_KEY must be 32 bytes, base64 or hex.");
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION}.${Buffer.concat([iv, tag, ciphertext]).toString("base64")}`;
}

export function decryptSecret(payload: string, key: Buffer): string {
  if (key.length !== 32) throw new SettingsCryptoError("LONGBOX_SECRET_KEY must be 32 bytes, base64 or hex.");
  const [version, body] = payload.split(".");
  if (version !== VERSION || !body) throw new SettingsCryptoError("Saved settings could not be decrypted.");
  const bytes = Buffer.from(body, "base64");
  if (bytes.length < 12 + 16 + 1) throw new SettingsCryptoError("Saved settings could not be decrypted.");
  const iv = bytes.subarray(0, 12);
  const tag = bytes.subarray(12, 28);
  const ciphertext = bytes.subarray(28);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw new SettingsCryptoError("Saved settings could not be decrypted. LONGBOX_SECRET_KEY does not match the key used to save them.");
  }
}
