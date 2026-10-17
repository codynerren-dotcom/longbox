export const DATABASE_URL_MISSING = "DATABASE_URL is not set. Add it to the environment before starting Longbox.";

/** Scripts and the server refuse to start without a database URL. Tests and `next build` skip the check. */
export function assertDatabaseUrl(env: NodeJS.ProcessEnv = process.env): void {
  if (env.VITEST === "true" || env.NEXT_PHASE === "phase-production-build") return;
  if (!env.DATABASE_URL?.trim()) throw new Error(DATABASE_URL_MISSING);
}
