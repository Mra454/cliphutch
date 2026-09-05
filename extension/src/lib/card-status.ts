export type CardStatusKind = "progress" | "error" | "pending" | "info";

export type CardStatusLine = {
  kind: CardStatusKind;
  text: string;
};

export type CardStatusInput = {
  progress?: string | null;
  error?: string | null;
  pending?: string | null;
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

  const error = clean(input.error);
  if (error) return { kind: "error", text: error };

  const pending = clean(input.pending);
  if (pending) return { kind: "pending", text: pending };

  if (input.hasJob) return null;
  const info = clean(input.info);
  return info ? { kind: "info", text: info } : null;
}
