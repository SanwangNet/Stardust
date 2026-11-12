import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";
import TOML from "@iarna/toml";
import { projectConfigRoot, type EnvValues } from "./env.js";

export interface StardustConfig {
  service: { name: string; description: string };
  server: { host: string; port: number };
  web: { title: string };
}

function defaults(): StardustConfig {
  return {
    service: { name: "Stardust", description: "" },
    server: { host: "127.0.0.1", port: 8347 },
    web: { title: "Stardust" },
  };
}

function table(value: unknown, label: string, allowed: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || value instanceof Date) {
    throw new Error(`${label} 必须是配置表`);
  }
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some((key) => !allowed.includes(key))) throw new Error(`${label} 包含未知配置字段`);
  return result;
}

function stringValue(value: unknown, fallback: string, label: string, allowEmpty = false): string {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || (!allowEmpty && value.trim() === "")) {
    throw new Error(`${label} 必须是${allowEmpty ? "" : "非空"}字符串`);
  }
  return value;
}

function validateConfig(value: unknown): StardustConfig {
  const config = table(value, "config.toml", ["service", "server", "web"]);
  const service = table(config.service === undefined ? {} : config.service, "service", ["name", "description"]);
  const server = table(config.server === undefined ? {} : config.server, "server", ["host", "port"]);
  const web = table(config.web === undefined ? {} : config.web, "web", ["title"]);
  const fallback = defaults();
  const port = server.port === undefined ? fallback.server.port : server.port;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("server.port 必须是 1–65535 之间的整数");
  }
  return {
    service: {
      name: stringValue(service.name, fallback.service.name, "service.name"),
      description: stringValue(service.description, fallback.service.description, "service.description", true),
    },
    server: { host: stringValue(server.host, fallback.server.host, "server.host"), port },
    web: { title: stringValue(web.title, fallback.web.title, "web.title") },
  };
}

export function createConfigStore(configRoot: string = projectConfigRoot) {
  if (!isAbsolute(configRoot)) throw new Error("配置根目录必须是绝对路径");
  const configPath = join(configRoot, "config.toml");

  function loadConfig(): StardustConfig {
    let source: string;
    try {
      source = fs.readFileSync(configPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaults();
      throw new Error("无法读取 config.toml");
    }
    let parsed: unknown;
    try {
      parsed = TOML.parse(source);
    } catch {
      throw new Error("config.toml 格式错误");
    }
    return validateConfig(parsed);
  }

  function saveConfig(value: StardustConfig): void {
    const config = validateConfig(value);
    // Do not silently replace a malformed or unsupported existing configuration.
    loadConfig();
    const serialized = TOML.stringify({ service: { ...config.service }, server: { ...config.server }, web: { ...config.web } });
    const temporaryPath = join(configRoot, `.config.toml.${randomUUID()}.tmp`);
    let fd: number | undefined;
    let temporaryCreated = false;
    try {
      fd = fs.openSync(temporaryPath, "wx", 0o600);
      temporaryCreated = true;
      fs.writeFileSync(fd, serialized, "utf8");
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      fs.renameSync(temporaryPath, configPath);
      temporaryCreated = false;
    } catch {
      throw new Error("无法保存 config.toml");
    } finally {
      if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* preserve the original error */ } }
      if (temporaryCreated) { try { fs.unlinkSync(temporaryPath); } catch { /* best-effort cleanup */ } }
    }
  }

  return { loadConfig, saveConfig };
}

export const { loadConfig, saveConfig } = createConfigStore();

export function resolveListenConfig(
  coreEnv: EnvValues,
  processEnv: NodeJS.ProcessEnv = process.env,
  server: StardustConfig["server"] = defaults().server,
): { host: string; port: number } {
  const host = processEnv.STARDUST_HOST ?? coreEnv.STARDUST_HOST ?? server.host;
  const value = processEnv.STARDUST_PORT ?? coreEnv.STARDUST_PORT;
  if (value === undefined) return { host, port: server.port };
  if (!/^\d+$/.test(value)) throw new Error("STARDUST_PORT 必须是 1–65535 之间的整数");
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("STARDUST_PORT 必须是 1–65535 之间的整数");
  }
  return { host, port };
}

export function resolveConfig(config: StardustConfig, coreEnv: EnvValues, processEnv: NodeJS.ProcessEnv = process.env): StardustConfig {
  return { ...config, server: resolveListenConfig(coreEnv, processEnv, config.server) };
}
