import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  activateLicense,
  deactivateLicense,
  removeLicenseLocally,
  revalidateIfStale,
} from "./license-client";

const VALID = "CH-ABCD-EFGH-IJKL-MNOP";

beforeEach(() => {
  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: { sendMessage: vi.fn() },
  };
});

describe("background-owned license client", () => {
  it("routes activation through the single service-worker owner", async () => {
    vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({ ok: true });

    expect(await activateLicense(VALID)).toEqual({ ok: true });
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      type: "license-activate",
      key: VALID,
    });
  });

  it("preserves the local key when background deactivation is ambiguous", async () => {
    vi.mocked(chrome.runtime.sendMessage).mockRejectedValue(
      new Error("worker restarted"),
    );

    expect(await deactivateLicense()).toMatchObject({
      ok: false,
      canRemoveLocally: true,
    });
  });

  it("treats a failed background refresh as transient", async () => {
    vi.mocked(chrome.runtime.sendMessage).mockRejectedValue(
      new Error("worker restarted"),
    );

    expect(await revalidateIfStale()).toEqual({ status: "transient" });
  });

  it("requires background acknowledgement before local-only removal completes", async () => {
    vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({ ok: true });

    await expect(removeLicenseLocally()).resolves.toBeUndefined();
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      type: "license-remove-local",
    });
  });
});
