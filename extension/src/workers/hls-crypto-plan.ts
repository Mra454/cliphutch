import {
  AccessDeniedError,
  CancelledError,
  DrmProtectedError,
  EncryptedStreamError,
  NetworkError,
  UnsupportedMediaShapeError,
} from "../lib/errors";

export type HlsKeyContext =
  | { method: "NONE" }
  | { method: "AES-128"; keyUri: string; iv?: Uint8Array };

export type HlsSegmentCrypto = {
  key: HlsKeyContext;
  sequence: bigint;
  mapKey?: HlsKeyContext;
};

export type HlsCryptoPlan = {
  segments: HlsSegmentCrypto[];
  iFramesOnly: boolean;
};

const MAX_SEQUENCE = (1n << 64n) - 1n;

function copiedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function parseAttributeList(raw: string): Map<string, string> {
  const attributes = new Map<string, string>();
  let index = 0;
  while (index < raw.length) {
    while (index < raw.length && (raw[index] === "," || /\s/.test(raw[index]))) index += 1;
    if (index >= raw.length) break;

    const nameStart = index;
    while (index < raw.length && raw[index] !== "=" && raw[index] !== ",") index += 1;
    const name = raw.slice(nameStart, index).trim().toUpperCase();
    if (raw[index] !== "=") {
      if (name) attributes.set(name, "");
      continue;
    }
    index += 1;
    while (index < raw.length && /\s/.test(raw[index])) index += 1;

    let value = "";
    if (raw[index] === '"') {
      index += 1;
      const valueStart = index;
      while (index < raw.length && raw[index] !== '"') index += 1;
      value = raw.slice(valueStart, index);
      if (raw[index] === '"') index += 1;
      while (index < raw.length && raw[index] !== ",") index += 1;
    } else {
      const valueStart = index;
      while (index < raw.length && raw[index] !== ",") index += 1;
      value = raw.slice(valueStart, index).trim();
    }
    if (name) attributes.set(name, value);
  }
  return attributes;
}

export function parseHexIv(raw: string): Uint8Array {
  const digits = raw.replace(/^0x/i, "");
  if (!/^[0-9a-f]{1,32}$/i.test(digits)) {
    throw new EncryptedStreamError("malformed IV");
  }
  const padded = digits.padStart(32, "0");
  const iv = new Uint8Array(16);
  for (let index = 0; index < iv.length; index += 1) {
    iv[index] = Number.parseInt(padded.slice(index * 2, index * 2 + 2), 16);
  }
  return iv;
}

function keyContext(raw: string, playlistUrl: string): HlsKeyContext {
  const attributes = parseAttributeList(raw);
  const method = attributes.get("METHOD")?.trim().toUpperCase();
  if (method === "NONE") return { method: "NONE" };

  const keyFormat = attributes.get("KEYFORMAT");
  if (keyFormat !== undefined && keyFormat !== "identity") {
    throw new DrmProtectedError("unknown");
  }
  if (method !== "AES-128") throw new EncryptedStreamError();

  const uri = attributes.get("URI");
  if (!uri) throw new EncryptedStreamError("malformed key declaration");
  let keyUri: string;
  try {
    keyUri = new URL(uri, playlistUrl).href;
  } catch {
    throw new EncryptedStreamError("malformed key declaration");
  }
  const rawIv = attributes.get("IV");
  return {
    method: "AES-128",
    keyUri,
    ...(rawIv === undefined ? {} : { iv: parseHexIv(rawIv) }),
  };
}

export function buildHlsCryptoPlan(
  playlistText: string,
  playlistUrl: string,
): HlsCryptoPlan {
  let mediaSequence = 0n;
  let activeKey: HlsKeyContext = { method: "NONE" };
  let activeMapKey: HlsKeyContext | undefined;
  let iFramesOnly = false;
  const segments: HlsSegmentCrypto[] = [];

  for (const rawLine of playlistText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const upper = line.toUpperCase();

    if (upper.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
      const rawSequence = line.slice(line.indexOf(":") + 1).trim();
      if (!/^\d+$/.test(rawSequence)) {
        throw new UnsupportedMediaShapeError("an invalid media sequence");
      }
      mediaSequence = BigInt(rawSequence);
      continue;
    }
    if (upper === "#EXT-X-I-FRAMES-ONLY") {
      iFramesOnly = true;
      continue;
    }
    if (upper.startsWith("#EXT-X-SESSION-KEY:")) continue;
    if (upper.startsWith("#EXT-X-KEY:")) {
      activeKey = keyContext(line.slice(line.indexOf(":") + 1), playlistUrl);
      continue;
    }
    if (upper.startsWith("#EXT-X-MAP:")) {
      if (activeKey.method === "AES-128" && activeKey.iv === undefined) {
        throw new EncryptedStreamError("encrypted initialization section without IV");
      }
      activeMapKey = activeKey;
      continue;
    }
    if (line.startsWith("#")) continue;

    segments.push({
      key: activeKey,
      sequence: mediaSequence + BigInt(segments.length),
      ...(activeMapKey === undefined ? {} : { mapKey: activeMapKey }),
    });
  }

  return { segments, iFramesOnly };
}

function sequenceIv(sequence: bigint): Uint8Array {
  if (sequence < 0n || sequence > MAX_SEQUENCE) {
    throw new UnsupportedMediaShapeError("a media sequence too large for an AES-128 IV");
  }
  const iv = new Uint8Array(16);
  let remaining = sequence;
  for (let index = iv.length - 1; index >= 0; index -= 1) {
    iv[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return iv;
}

export function ivForSegment(segment: HlsSegmentCrypto): Uint8Array {
  return segment.key.method === "AES-128" && segment.key.iv !== undefined
    ? segment.key.iv
    : sequenceIv(segment.sequence);
}

export function ivForMap(segment: HlsSegmentCrypto): Uint8Array {
  if (segment.mapKey?.method !== "AES-128" || segment.mapKey.iv === undefined) {
    throw new EncryptedStreamError("encrypted initialization section without IV");
  }
  return segment.mapKey.iv;
}

export async function decryptAes128Cbc(
  key: CryptoKey,
  iv: Uint8Array,
  data: Uint8Array,
): Promise<Uint8Array> {
  if (data.length === 0 || data.length % 16 !== 0) {
    throw new EncryptedStreamError("invalid ciphertext length");
  }
  try {
    const decrypted = await globalThis.crypto.subtle.decrypt(
      { name: "AES-CBC", iv: copiedArrayBuffer(iv) },
      key,
      copiedArrayBuffer(data),
    );
    return new Uint8Array(decrypted);
  } catch {
    throw new EncryptedStreamError("decryption failed");
  }
}

async function readKeyBytes(response: Response): Promise<Uint8Array> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && declaredLength !== "16") {
    throw new EncryptedStreamError("unexpected key size");
  }

  if (response.body === null) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length !== 16) throw new EncryptedStreamError("unexpected key size");
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let retainedBytes = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    const retain = Math.min(chunk.value.byteLength, 17 - retainedBytes);
    if (retain > 0) {
      chunks.push(chunk.value.slice(0, retain));
      retainedBytes += retain;
    }
    if (retainedBytes > 16) {
      await reader.cancel();
      throw new EncryptedStreamError("unexpected key size");
    }
  }
  if (retainedBytes !== 16) throw new EncryptedStreamError("unexpected key size");

  const bytes = new Uint8Array(16);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function createKeyCache(
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): { getKey(keyUri: string): Promise<CryptoKey> } {
  const cache = new Map<string, Promise<CryptoKey>>();

  const getKey = (keyUri: string): Promise<CryptoKey> => {
    const existing = cache.get(keyUri);
    if (existing !== undefined) return existing;
    const pending = (async () => {
      let response: Response;
      try {
        response = await fetchImpl(keyUri, { credentials: "include", signal });
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          throw new CancelledError();
        }
        throw new NetworkError(error instanceof Error ? error.message : undefined);
      }
      if (response.status === 401 || response.status === 403) throw new AccessDeniedError();
      if (!response.ok) throw new EncryptedStreamError("key request failed");
      const bytes = await readKeyBytes(response);
      return globalThis.crypto.subtle.importKey(
        "raw",
        copiedArrayBuffer(bytes),
        "AES-CBC",
        false,
        ["decrypt"],
      );
    })();
    cache.set(keyUri, pending);
    pending.catch(() => {});
    return pending;
  };

  return { getKey };
}
