type RequestError = Error & { digest?: string };

export async function onRequestError(
  error: RequestError,
  request: { path: string; method: string },
  context: { routePath?: string },
): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { reportRequestError } = await import("@/lib/log/node-error");
    await reportRequestError(error, request, context);
  }
}
