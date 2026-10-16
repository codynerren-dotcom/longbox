import { AsyncLocalStorage } from "node:async_hooks";
import type { RateLane } from "@/lib/catalog/rate-limit";

const lanes = new AsyncLocalStorage<RateLane>();

/** Match searches stay interactive. Background jobs opt in. */
export function currentLane(): RateLane {
  return lanes.getStore() ?? "interactive";
}

export function runInLane<T>(lane: RateLane, fn: () => Promise<T>): Promise<T> {
  return lanes.run(lane, fn);
}
