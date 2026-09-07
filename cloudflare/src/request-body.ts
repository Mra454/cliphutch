export class RequestBodyTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Request body exceeds ${maxBytes} bytes`);
    this.name = "RequestBodyTooLargeError";
  }
}

export class InvalidRequestBodyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidRequestBodyError";
  }
}

function declaredLength(request: Request): number | null {
  const value = request.headers.get("Content-Length");
  if (value === null) return null;
  if (!/^(?:0|[1-9]\d*)$/.test(value)) {
    throw new InvalidRequestBodyError("Invalid Content-Length");
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new InvalidRequestBodyError("Unsafe Content-Length");
  }
  return parsed;
}

export async function readBoundedText(
  request: Request,
  maxBytes: number,
): Promise<string> {
  const length = declaredLength(request);
  if (length !== null && length > maxBytes) {
    throw new RequestBodyTooLargeError(maxBytes);
  }
  if (request.body === null) return "";

  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: false,
  });
  let bytesRead = 0;
  let text = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > maxBytes) {
        try {
          await reader.cancel("request body limit exceeded");
        } catch {
          // The size violation is the authoritative failure even if the input
          // stream also errors while cancellation propagates.
        }
        throw new RequestBodyTooLargeError(maxBytes);
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } catch (error) {
    if (
      error instanceof RequestBodyTooLargeError ||
      error instanceof InvalidRequestBodyError
    ) {
      throw error;
    }
    throw new InvalidRequestBodyError("Request body is not valid UTF-8");
  } finally {
    reader.releaseLock();
  }
}
