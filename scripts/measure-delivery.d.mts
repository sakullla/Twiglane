export function redact(text: string): string;

export function remoteKind(url: string): "https" | "ssh" | "local";

export function resetSampleLog(file: string): void;

export function startupTiming(
  samples: Array<{
    name?: string;
    pid?: number;
    elapsedMs?: number;
    detail?: { launch?: string | null; contentOk?: boolean; elapsedMs?: number };
  }>,
  pid: number,
): { launch: string | null; contentOk: boolean; controlsMs: number; openMs: number };

export function parseCpuTime(value: string): number | null;

export function idleCpuPercent(samples: Array<{ at: number; cpuSeconds: number }>): number | null;

export function measureProtocol(
  kind: "https" | "ssh",
  env: Record<string, string | undefined>,
  runGit: (url: string) => Promise<{ status: number | null; stdout?: string; stderr?: string }>,
): Promise<{
  id: string;
  status: string;
  summary: string;
  nextStep?: string;
  evidence: {
    remoteConfigured?: boolean;
    denyConfigured?: boolean;
    localBare?: boolean;
    success?: boolean;
    authFailure?: boolean;
    redacted?: boolean;
    transcript?: string;
  };
}>;
