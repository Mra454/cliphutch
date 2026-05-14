declare module "mux.js" {
  type Stream<TIn = unknown, TOut = unknown> = {
    push(data: TIn): void;
    flush(): void;
    pipe<TNext>(dest: Stream<TOut, TNext>): Stream<TOut, TNext>;
    on(event: "data", cb: (data: TOut) => void): void;
    on(event: "done", cb: () => void): void;
  };

  type TransmuxedSegment = {
    type: "audio" | "video";
    initSegment: Uint8Array;
    data: Uint8Array;
  };

  const mux: {
    mp4: {
      Transmuxer: new (opts?: Record<string, unknown>) => Stream<Uint8Array, TransmuxedSegment>;
    };
    mp2t: {
      TransportPacketStream: new () => Stream<Uint8Array, unknown>;
      TransportParseStream: new () => Stream<unknown, unknown>;
      ElementaryStream: new () => Stream<unknown, unknown>;
    };
    codecs: {
      Adts: new () => Stream<unknown, unknown>;
    };
  };

  export default mux;
}
