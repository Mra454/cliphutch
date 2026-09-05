export type CardStatusKind = "progress" | "pending" | "error" | "complete" | "info";

export type CardStatusLine = {
  kind: CardStatusKind;
  text: string;
};

export type CardStatusInput = {
  progress?: string | null;
  pending?: string | null;
  error?: string | null;
  complete?: string | null;
  info?: string | null;
  hasJob?: boolean;
};

function clean(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function selectCardStatusLine(input: CardStatusInput): CardStatusLine | null {
  const progress = clean(input.progress);
  if (progress) return { kind: "progress", text: progress };

  const pending = clean(input.pending);
  if (pending) return { kind: "pending", text: pending };

  const error = clean(input.error);
  if (error) return { kind: "error", text: error };

  const complete = clean(input.complete);
  if (complete) return { kind: "complete", text: complete };

  if (input.hasJob) return null;
  const info = clean(input.info);
  return info ? { kind: "info", text: info } : null;
}
