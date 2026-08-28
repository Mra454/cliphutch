export class ResponseBodyTooLargeError extends Error {
  constructor(readonly limitBytes: number) {
    super(`Response body exceeds the ${limitBytes}-byte limit.`);
    this.name = "ResponseBodyTooLargeError";
  }
}

/** Reads UTF-8 response text without ever buffering beyond the stated cap. */
export async function readResponseTextBounded(
  response: Response,
  limitBytes: number,
): Promise<string> {
  if (!Number.isSafeInteger(limitBytes) || limitBytes <= 0) {
    throw new TypeError("limitBytes must be a positive safe integer.");
  }
  const declared = Number.parseInt(response.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declared) && declared > limitBytes) {
    throw new ResponseBodyTooLargeError(limitBytes);
  }
  if (!response.body) throw new Error("Response body is unavailable.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limitBytes) throw new ResponseBodyTooLargeError(limitBytes);
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
