import { describe, expect, it, vi } from "vitest";
import {
  preflightCaptureNativeSource,
  preflightCaptureNativeSources,
} from "./capture-native-preflight";

describe("preflightCaptureNativeSource", () => {
  it("accepts a successful HEAD response without reading media bytes", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, {
      status: 200,
      headers: {
        "content-type": "video/mp4",
        "content-length": "1234",
      },
    }));

    await expect(preflightCaptureNativeSource("https://cdn.example/video.mp4", {
      fetchImpl,
    })).resolves.toMatchObject({
      ok: true,
      method: "HEAD",
      status: 200,
      contentType: "video/mp4",
      sizeBytes: 1234,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({
      method: "HEAD",
      credentials: "include",
      redirect: "follow",
      referrerPolicy: "no-referrer",
    });
  });

  it("bounds batch concurrency, preserves order, and validates identifiers", async () => {
    let active = 0;
    let peak = 0;
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return new Response(null, { status: 200, headers: { "content-type": "video/mp4" } });
    });
    const result = await preflightCaptureNativeSources(
      Array.from({ length: 7 }, (_, index) => ({
        itemId: `item-${index}`,
        url: `https://cdn.example/${index}.mp4`,
      })),
      { fetchImpl, maxConcurrency: 2 },
    );
    expect(peak).toBe(2);
    expect(result.map((entry) => entry.itemId)).toEqual([
      "item-0", "item-1", "item-2", "item-3", "item-4", "item-5", "item-6",
    ]);
    await expect(preflightCaptureNativeSources([
      { itemId: "same", url: "https://cdn.example/a" },
      { itemId: "same", url: "https://cdn.example/b" },
    ])).rejects.toThrow(/unique/);
  });

  it("falls back to a one-byte GET and cancels its body when HEAD is rejected", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array([1]));
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 405 }))
      .mockResolvedValueOnce(new Response(body, {
        status: 206,
        headers: {
          "content-type": "image/jpeg",
          "content-range": "bytes 0-0/98765",
        },
      }));

    await expect(preflightCaptureNativeSource("https://cdn.example/image", {
      fetchImpl,
    })).resolves.toMatchObject({
      ok: true,
      method: "GET",
      contentType: "image/jpeg",
      sizeBytes: 98765,
    });
    expect(fetchImpl.mock.calls[1]?.[1]).toMatchObject({
      method: "GET",
      headers: { Range: "bytes=0-0" },
    });
    expect(cancelled).toBe(true);
  });

  it("rejects stale, login-page, malformed, and timed-out sources", async () => {
    const stale = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 410 }));
    await expect(preflightCaptureNativeSource("https://cdn.example/gone.mp4", {
      fetchImpl: stale,
    })).resolves.toMatchObject({ ok: false, code: "NATIVE_SOURCE_UNAVAILABLE", status: 410 });

    const login = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    }));
    await expect(preflightCaptureNativeSource("https://cdn.example/video.mp4", {
      fetchImpl: login,
    })).resolves.toMatchObject({ ok: false, code: "NATIVE_SOURCE_NOT_MEDIA" });

    await expect(preflightCaptureNativeSource("javascript:alert(1)")).resolves.toMatchObject({
      ok: false,
      code: "NATIVE_SOURCE_INVALID",
    });

    const hanging = vi.fn<typeof fetch>()
      .mockImplementation((_url, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      }));
    await expect(preflightCaptureNativeSource("https://cdn.example/slow.mp4", {
      fetchImpl: hanging,
      timeoutMs: 100,
    })).resolves.toMatchObject({ ok: false, code: "NATIVE_SOURCE_TIMEOUT" });

    const batchController = new AbortController();
    const cancelled = preflightCaptureNativeSource("https://cdn.example/slow-too.mp4", {
      fetchImpl: hanging,
      timeoutMs: 30_000,
      signal: batchController.signal,
    });
    batchController.abort();
    await expect(cancelled).resolves.toMatchObject({ ok: false, code: "NATIVE_SOURCE_TIMEOUT" });
  });
});
