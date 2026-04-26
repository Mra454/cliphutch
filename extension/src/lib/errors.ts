export class HlsDownloadError extends Error {
  code: string;
  userMessage: string;
  constructor(code: string, userMessage: string, message?: string) {
    super(message ?? userMessage);
    this.name = "HlsDownloadError";
    this.code = code;
    this.userMessage = userMessage;
  }
}
