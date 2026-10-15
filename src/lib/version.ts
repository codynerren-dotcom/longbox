import packageJson from "../../package.json";

export const APP_VERSION = packageJson.version;

export function appCommit(): string {
  const commit = process.env.LONGBOX_COMMIT?.trim();
  return commit || "dev";
}
