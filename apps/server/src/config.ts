import type { EnvValues } from "./env.js";

export function resolveListenConfig(coreEnv: EnvValues, processEnv: NodeJS.ProcessEnv = process.env): { host: string; port: number } {
  const host = processEnv.STARDUST_HOST ?? coreEnv.STARDUST_HOST ?? "127.0.0.1";
  const value = processEnv.STARDUST_PORT ?? coreEnv.STARDUST_PORT;
  if (value === undefined) return { host, port: 8347 };
  if (!/^\d+$/.test(value)) throw new Error("STARDUST_PORT 必须是 1–65535 之间的整数");
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("STARDUST_PORT 必须是 1–65535 之间的整数");
  }
  return { host, port };
}
