import { describe, expect, it } from "vitest";
import {
  createCaptureDraftCommandId,
  isCaptureDraftCommandId,
  isCaptureDraftGetRequest,
  isCaptureDraftMutationRequest,
  isCaptureDraftUiRequest,
  parseCaptureDraftUiRequest,
  type CaptureDraftUiRequest,
} from "./capture-pack-messages";

const UUID = "123e4567-e89b-42d3-a456-426614174000";
const COMMAND_ID = `capture-draft-${UUID}`;

const requests = (): CaptureDraftUiRequest[] => [
  { type: "capture-draft-get" },
  {
    type: "capture-draft-add",
    commandId: COMMAND_ID,
    expectedRevision: 0,
    tabId: 12,
    mediaId: "k9z31v",
  },
  {
    type: "capture-draft-remove",
    commandId: COMMAND_ID,
    expectedRevision: 1,
    itemId: "item-123",
  },
  {
    type: "capture-draft-remove-page",
    commandId: COMMAND_ID,
    expectedRevision: 2,
    pageUrl: "https://example.test/research?page=1",
  },
  {
    type: "capture-draft-remove-page",
    commandId: COMMAND_ID,
    expectedRevision: 2,
    pageUrl: null,
  },
  {
    type: "capture-draft-clear",
    commandId: COMMAND_ID,
    expectedRevision: 3,
  },
  {
    type: "capture-draft-rename",
    commandId: COMMAND_ID,
    expectedRevision: 4,
    name: "Campaign research 🎬",
  },
  {
    type: "capture-draft-label-page",
    commandId: COMMAND_ID,
    expectedRevision: 5,
    pageUrl: "https://example.test/research?page=1",
    label: "Interview selects",
  },
  {
    type: "capture-draft-replace-media",
    commandId: COMMAND_ID,
    expectedRevision: 6,
    itemId: "item-123",
    tabId: 12,
    mediaId: "alternate-456",
  },
  {
    type: "capture-draft-set-manifest-csv",
    commandId: COMMAND_ID,
    expectedRevision: 7,
    enabled: true,
  },
];

describe("capture-draft command IDs", () => {
  it("creates and validates a namespaced UUID", () => {
    expect(createCaptureDraftCommandId(() => UUID)).toBe(COMMAND_ID);
    expect(isCaptureDraftCommandId(COMMAND_ID)).toBe(true);
  });

  it("rejects malformed, unbounded, and attacker-controlled values", () => {
    expect(isCaptureDraftCommandId(UUID)).toBe(false);
    expect(isCaptureDraftCommandId("capture-draft-not-a-uuid")).toBe(false);
    expect(isCaptureDraftCommandId("capture-draft-../../../capture-draft-v1")).toBe(false);
    expect(isCaptureDraftCommandId(`${COMMAND_ID}extra`)).toBe(false);
    expect(isCaptureDraftCommandId(undefined)).toBe(false);
    expect(() => createCaptureDraftCommandId(() => "not-a-uuid")).toThrow(TypeError);
  });
});

describe("capture-draft UI request guard", () => {
  it("accepts and canonically parses every supported request", () => {
    for (const request of requests()) {
      expect(isCaptureDraftUiRequest(request)).toBe(true);
      expect(parseCaptureDraftUiRequest(request)).toEqual(request);
      expect(parseCaptureDraftUiRequest(request)).not.toBe(request);
    }
  });

  it("distinguishes read-only get from mutating commands", () => {
    expect(isCaptureDraftGetRequest({ type: "capture-draft-get" })).toBe(true);
    expect(isCaptureDraftMutationRequest({ type: "capture-draft-get" })).toBe(false);
    for (const request of requests().slice(1)) {
      expect(isCaptureDraftGetRequest(request)).toBe(false);
      expect(isCaptureDraftMutationRequest(request)).toBe(true);
    }
  });

  it("does not let the UI submit media snapshots, URLs, headers, or generated fields", () => {
    const add = requests()[1];
    const dangerousFields: Record<string, unknown> = {
      media: { url: "https://attacker.invalid/video.mp4" },
      url: "https://attacker.invalid/video.mp4",
      headers: { Authorization: "Bearer secret" },
      headerLeaseId: "attacker-lease",
      itemId: "attacker-item",
      addedAt: Date.now(),
      draftId: "attacker-draft",
    };
    for (const [key, value] of Object.entries(dangerousFields)) {
      expect(isCaptureDraftUiRequest({ ...add, [key]: value })).toBe(false);
    }
  });

  it("rejects any extra own, symbol, non-enumerable, or inherited field", () => {
    expect(isCaptureDraftUiRequest({ type: "capture-draft-get", expectedRevision: 0 })).toBe(
      false,
    );
    expect(
      isCaptureDraftUiRequest(
        JSON.parse('{"type":"capture-draft-get","__proto__":{"headers":true}}'),
      ),
    ).toBe(false);

    const symbolRequest = { type: "capture-draft-get", [Symbol("headers")]: true };
    expect(isCaptureDraftUiRequest(symbolRequest)).toBe(false);

    const hidden = { type: "capture-draft-get" };
    Object.defineProperty(hidden, "headers", { value: true, enumerable: false });
    expect(isCaptureDraftUiRequest(hidden)).toBe(false);

    const inherited = Object.create({ headers: { Authorization: "secret" } }) as {
      type: string;
    };
    inherited.type = "capture-draft-get";
    expect(isCaptureDraftUiRequest(inherited)).toBe(false);
  });

  it("rejects accessors and hostile proxies without invoking or throwing", () => {
    let getterCalls = 0;
    const accessor = {};
    Object.defineProperty(accessor, "type", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "capture-draft-get";
      },
    });
    expect(() => isCaptureDraftUiRequest(accessor)).not.toThrow();
    expect(isCaptureDraftUiRequest(accessor)).toBe(false);
    expect(getterCalls).toBe(0);

    const hostile = new Proxy({}, {
      getOwnPropertyDescriptor() {
        throw new Error("hostile proxy");
      },
    });
    expect(() => parseCaptureDraftUiRequest(hostile)).not.toThrow();
    expect(parseCaptureDraftUiRequest(hostile)).toBeUndefined();
  });

  it("requires a valid command ID and safe revision on every mutation", () => {
    const clear = requests()[5];
    expect(isCaptureDraftUiRequest({ ...clear, commandId: "bad" })).toBe(false);
    expect(isCaptureDraftUiRequest({ ...clear, expectedRevision: -1 })).toBe(false);
    expect(isCaptureDraftUiRequest({ ...clear, expectedRevision: 1.5 })).toBe(false);
    expect(isCaptureDraftUiRequest({ ...clear, expectedRevision: Number.MAX_SAFE_INTEGER + 1 })).toBe(
      false,
    );
    expect(isCaptureDraftUiRequest({ type: "capture-draft-clear", expectedRevision: 0 })).toBe(
      false,
    );
  });

  it("bounds and validates add references without accepting a snapshot", () => {
    const add = requests()[1];
    expect(isCaptureDraftUiRequest({ ...add, tabId: 0 })).toBe(true);
    expect(isCaptureDraftUiRequest({ ...add, tabId: -1 })).toBe(false);
    expect(isCaptureDraftUiRequest({ ...add, tabId: 1.2 })).toBe(false);
    expect(isCaptureDraftUiRequest({ ...add, mediaId: "" })).toBe(false);
    expect(isCaptureDraftUiRequest({ ...add, mediaId: "x".repeat(257) })).toBe(false);
    expect(isCaptureDraftUiRequest({ ...add, mediaId: "../../media" })).toBe(false);
  });

  it("bounds item IDs, pack names, and originating page URLs", () => {
    const remove = requests()[2];
    expect(isCaptureDraftUiRequest({ ...remove, itemId: "x".repeat(257) })).toBe(false);
    expect(isCaptureDraftUiRequest({ ...remove, itemId: "item/escape" })).toBe(false);

    const removePage = requests()[3];
    expect(isCaptureDraftUiRequest({ ...removePage, pageUrl: "ftp://example.test/page" })).toBe(
      false,
    );
    expect(isCaptureDraftUiRequest({ ...removePage, pageUrl: "not a URL" })).toBe(false);
    expect(
      isCaptureDraftUiRequest({
        ...removePage,
        pageUrl: `https://example.test/${"x".repeat(17_000)}`,
      }),
    ).toBe(false);

    const rename = requests()[6];
    expect(isCaptureDraftUiRequest({ ...rename, name: "   " })).toBe(false);
    expect(isCaptureDraftUiRequest({ ...rename, name: "x".repeat(121) })).toBe(false);
    expect(isCaptureDraftUiRequest({ ...rename, name: "unsafe\nname" })).toBe(false);

    const labelPage = requests()[7];
    expect(isCaptureDraftUiRequest({ ...labelPage, pageUrl: "ftp://example.test/page" })).toBe(false);
    expect(isCaptureDraftUiRequest({ ...labelPage, label: "x".repeat(121) })).toBe(false);
    expect(isCaptureDraftUiRequest({ ...labelPage, label: "unsafe\u202elabel" })).toBe(false);
    expect(isCaptureDraftUiRequest({ ...labelPage, label: "unsafe\nlabel" })).toBe(false);
    expect(isCaptureDraftUiRequest({ ...labelPage, label: 12 })).toBe(false);
  });

  it("canonicalizes page-label edits and treats empty text as an explicit reset", () => {
    const labelPage = requests()[7];
    expect(parseCaptureDraftUiRequest({
      ...labelPage,
      pageUrl: "https://EXAMPLE.test:443/research?page=1",
      label: "  Interview selects  ",
    })).toMatchObject({
      type: "capture-draft-label-page",
      pageUrl: "https://example.test/research?page=1",
      label: "Interview selects",
    });
    expect(parseCaptureDraftUiRequest({ ...labelPage, label: "   " })).toMatchObject({
      label: null,
    });
    expect(parseCaptureDraftUiRequest({ ...labelPage, label: null })).toMatchObject({
      label: null,
    });
  });

  it("strictly bounds authoritative alternate-copy references", () => {
    const replace = requests()[8];
    expect(isCaptureDraftUiRequest({ ...replace, itemId: "" })).toBe(false);
    expect(isCaptureDraftUiRequest({ ...replace, itemId: "../item" })).toBe(false);
    expect(isCaptureDraftUiRequest({ ...replace, tabId: -1 })).toBe(false);
    expect(isCaptureDraftUiRequest({ ...replace, tabId: 1.5 })).toBe(false);
    expect(isCaptureDraftUiRequest({ ...replace, mediaId: "x".repeat(257) })).toBe(false);
    expect(isCaptureDraftUiRequest({ ...replace, media: { url: "https://attacker.test" } })).toBe(false);
  });

  it("accepts only a boolean CSV preference and cannot disable required JSON", () => {
    const csv = requests()[9];
    expect(parseCaptureDraftUiRequest(csv)).toEqual(csv);
    expect(isCaptureDraftUiRequest({ ...csv, enabled: "true" })).toBe(false);
    expect(isCaptureDraftUiRequest({ ...csv, formats: ["csv"] })).toBe(false);
    expect(isCaptureDraftUiRequest({ ...csv, json: false })).toBe(false);
  });

  it("rejects unknown discriminants and non-record inputs", () => {
    expect(isCaptureDraftUiRequest({ type: "capture-draft-delete-everything" })).toBe(false);
    expect(isCaptureDraftUiRequest(null)).toBe(false);
    expect(isCaptureDraftUiRequest([])).toBe(false);
    expect(isCaptureDraftUiRequest("capture-draft-get")).toBe(false);
  });
});
