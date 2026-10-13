import { probeComicVine, type ProbeResult } from "@/lib/settings/probe";
import { getSettings } from "@/lib/settings/service";

export async function testComicVineConnection(fetchImpl?: typeof fetch): Promise<ProbeResult> {
  return probeComicVine(await getSettings(), fetchImpl);
}
