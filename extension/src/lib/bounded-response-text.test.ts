import { describe, expect, it } from "vitest";
import {
  readResponseTextBounded,
  ResponseBodyTooLargeError,
} from "./bounded-response-text";

describe("readResponseTextBounded", () => {
  it("decodes a chunked UTF-8 body within the cap", async () => {
    const response = new Response(new Blob(["#EXTM3U\n", "☃"]));
    await expect(readResponseTextBounded(response, 64)).resolves.toBe("#EXTM3U\n☃");
  });

  it("rejects a declared oversize body before reading it", async () => {
    const response = new Response("small", { headers: { "content-length": "101" } });
    await expect(readResponseTextBounded(response, 100)).rejects.toBeInstanceOf(
      ResponseBodyTooLargeError,
    );
  });

  it("stops a chunked body as soon as observed bytes cross the cap", async () => {
    let pulls = 0;
    const response = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(60));
        if (pulls === 3) controller.close();
      },
    }));
    await expect(readResponseTextBounded(response, 100)).rejects.toBeInstanceOf(
      ResponseBodyTooLargeError,
    );
    expect(pulls).toBeLessThanOrEqual(3);
  });
});
