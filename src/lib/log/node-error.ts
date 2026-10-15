import { serverErrorDetails } from "@/lib/log/query";
import { writeLog } from "@/lib/log/write";

type RequestError = Error & { digest?: string };

export async function reportRequestError(
  error: RequestError,
  request: { path: string; method: string },
  context: { routePath?: string },
): Promise<void> {
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
}
