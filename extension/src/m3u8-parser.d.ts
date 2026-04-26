declare module "m3u8-parser" {
  export class Parser {
    push(text: string): void;
    end(): void;
    manifest: unknown;
  }
}
