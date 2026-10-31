import type { AppFailure } from "./types";

export function normalizeError(error: unknown): AppFailure {
  if (typeof error === "string") {
    const parsed = parseObject(error);
    if (parsed) return parsed;
    return { code: "unknown", message: error || "操作失败。" };
  }
  if (isRecord(error)) {
    if (typeof error.message === "string") {
      return {
        code: typeof error.code === "string" ? error.code : "unknown",
        message: error.message,
        generation: typeof error.generation === "number" ? error.generation : undefined,
      };
    }
    if (typeof error.error === "string") {
      const parsed = parseObject(error.error);
      if (parsed) return parsed;
      return { code: "unknown", message: error.error };
    }
  }
  return { code: "unknown", message: "操作失败。" };
}

function parseObject(value: string): AppFailure | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (isRecord(parsed) && typeof parsed.message === "string") {
      return {
        code: typeof parsed.code === "string" ? parsed.code : "unknown",
        message: parsed.message,
        generation: typeof parsed.generation === "number" ? parsed.generation : undefined,
      };
    }
  } catch {
    return null;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
