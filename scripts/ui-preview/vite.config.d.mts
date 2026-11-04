export const HEALTH_PATH: string;
export const HOST: string;
export const PORT: number;
export const REAL_API_MODULE: string;
export const MOCK_API_MODULE: string;
export function sameFile(left: unknown, right: unknown): boolean;
export function portInUse(port?: number, host?: string): Promise<boolean>;
declare const config: import("vite").UserConfig;
export default config;
