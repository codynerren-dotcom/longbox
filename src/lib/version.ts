import { readFileSync } from "node:fs";
import packageJson from "../../package.json";

export const APP_VERSION = packageJson.version;

function readRevisionFile(): string {
  for (const file of ["/app/REVISION", "REVISION"]) {
    try {
      const text = readFileSync(file, "utf8").trim().split(/\s+/)[0] ?? "";
      if (text) return text;
    } catch {
      // The revision file is written next to the image build, not in git.
    }
  }
  return "";
}

export function appCommit(): string {
  const commit = process.env.LONGBOX_COMMIT?.trim() ?? "";
  if (commit && commit !== "dev") return commit;
  return readRevisionFile() || commit || "dev";
}
