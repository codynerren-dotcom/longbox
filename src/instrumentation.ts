import { serverErrorDetails } from "@/lib/log/query";

type RequestError = Error & { digest?: string };

export async function onRequestError(
  error: RequestError,
  request: { path: string; method: string },
  context: { routePath: string },
): Promise<void> {
  try {
    const { writeLog } = await import("@/lib/log/write");
    await writeLog({
      level: "error",
      source: "system",
      message: error.message || "Unhandled server error.",
      details: serverErrorDetails({
        path: request.path,
        method: request.method,
        routePath: context.routePath,
        digest: error.digest,
      }),
    });
  } catch {
    // A logging failure must not replace the original error.
  }
}
