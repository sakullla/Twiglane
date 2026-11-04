export const HEALTH_PATH: string;
export const HOST: string;
export const PORT: number;
export const REAL_API_MODULE: string;
export const MOCK_API_MODULE: string;
export function sameFile(left: unknown, right: unknown): boolean;
export function probeHost(host: unknown): string;
export function portInUse(port?: number, host?: unknown): Promise<boolean>;
export function reportPortInUse(options: {
  host?: unknown;
  port?: number;
  logger: { error(message: string): void };
  fatal?: boolean;
  exit?: (code: number) => void;
}): boolean;
declare const config: import("vite").UserConfig;
export default config;
