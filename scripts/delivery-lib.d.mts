export const BUDGETS: { referenceMemoryBytes: number };
export const REQUIRED_CHECKS: string[];
export function p95(values: number[]): number | null;
export function sha256File(file: string): string;
export function sourceFingerprint(root: string): string;
export function validateCheck(
  check: { id: string; status: string; summary?: string; nextStep?: string; evidence?: unknown },
  options: { root: string; hostPlatform: string },
): string[];
export function judgeReport(
  root: string,
  report: {
    format: string;
    sourceFingerprint: string;
    checks: Array<{ id: string; status: string; summary: string; nextStep?: string; evidence?: unknown }>;
  },
  fingerprint: string,
  hostPlatform?: string,
): { ok: boolean; summary: string; failures: string[] };
export function verifyDelivery(root: string, hostPlatform?: string): { ok: boolean; summary: string; failures: string[] };
