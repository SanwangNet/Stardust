import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";
import TOML from "@iarna/toml";
import { projectConfigRoot, type EnvValues } from "./env.js";

export interface StardustConfig {
  initialized: boolean;
  service: { description: string };
  server: { host: string; port: number };
  web: { title: string };
  model: { baseUrl: string; modelId: string; timeoutMs: number; stream: boolean };
}

export type ConfigUpdate = {
  service?: Partial<StardustConfig["service"]>;
  server?: Partial<StardustConfig["server"]>;
  web?: Partial<StardustConfig["web"]>;
};

export class ConfigValidationError extends Error {}

export class AlreadyInitializedError extends Error {
  readonly code = "ALREADY_INITIALIZED";
  constructor() {
    super("ALREADY_INITIALIZED");
    this.name = "AlreadyInitializedError";
  }
}

function defaults(): StardustConfig {
  return {
    initialized: false,
    service: { description: "" },
    server: { host: "127.0.0.1", port: 8347 },
    web: { title: "Stardust" },
    model: { baseUrl: "", modelId: "", timeoutMs: 30000, stream: false },
  };
}

function table(value: unknown, label: string, allowed: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || value instanceof Date) {
    throw new ConfigValidationError(`${label} 必须是配置表`);
  }
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some((key) => !allowed.includes(key))) throw new ConfigValidationError(`${label} 包含未知配置字段`);
  return result;
}

function stringValue(value: unknown, fallback: string, label: string, allowEmpty = false): string {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || (!allowEmpty && value.trim() === "")) {
    throw new ConfigValidationError(`${label} 必须是${allowEmpty ? "" : "非空"}字符串`);
  }
  return value;
}

function validateConfig(value: unknown, allowLegacyName = false): StardustConfig {
  const config = table(value, "config.toml", ["initialized", "service", "server", "web", "model"]);
  const service = table(config.service === undefined ? {} : config.service, "service", allowLegacyName ? ["name", "description"] : ["description"]);
  const server = table(config.server === undefined ? {} : config.server, "server", ["host", "port"]);
  const web = table(config.web === undefined ? {} : config.web, "web", ["title"]);
  const model = table(config.model === undefined ? {} : config.model, "model", ["baseUrl", "modelId", "timeoutMs", "stream"]);
  const fallback = defaults();
  const initialized = config.initialized === undefined ? false : config.initialized;
  if (typeof initialized !== "boolean") throw new ConfigValidationError("initialized 必须是布尔值");
  const port = server.port === undefined ? fallback.server.port : server.port;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigValidationError("server.port 必须是 1–65535 之间的整数");
  }
  const baseUrl = stringValue(model.baseUrl, fallback.model.baseUrl, "model.baseUrl", true);
  const modelId = stringValue(model.modelId, fallback.model.modelId, "model.modelId", true);
  const timeoutMs = model.timeoutMs === undefined ? fallback.model.timeoutMs : model.timeoutMs;
  const stream = model.stream === undefined ? fallback.model.stream : model.stream;
  if (typeof stream !== "boolean") throw new ConfigValidationError("model.stream 必须是布尔值");
  if (modelId.length > 256 || /[\x00-\x1f\x7f]/.test(modelId)) throw new ConfigValidationError("model.modelId 无效");
  if (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) throw new ConfigValidationError("model.timeoutMs 必须是 1000–120000 之间的整数");
  if (baseUrl) {
    try {
      const url = new URL(baseUrl);
      const local = url.hostname === "localhost" || url.hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
      if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && local))) throw new Error();
    } catch { throw new ConfigValidationError("model.baseUrl 必须是 HTTPS 或本机 HTTP 地址，且不能包含凭据、查询参数或片段"); }
  }
  return {
    initialized,
    service: {
      description: stringValue(service.description, fallback.service.description, "service.description", true),
    },
    server: { host: stringValue(server.host, fallback.server.host, "server.host"), port },
    web: { title: stringValue(web.title, fallback.web.title, "web.title") },
    model: { baseUrl, modelId, timeoutMs, stream },
  };
}

function mergeUpdate(current: StardustConfig, value: ConfigUpdate): StardustConfig {
  const update = table(value, "配置更新", ["service", "server", "web"]);
  const service = table(update.service === undefined ? {} : update.service, "service", ["description"]);
  const server = table(update.server === undefined ? {} : update.server, "server", ["host", "port"]);
  const web = table(update.web === undefined ? {} : update.web, "web", ["title"]);
  // Treat undefined as absent, so omitted values retain their current setting.
  const defined = (fields: Record<string, unknown>) => Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
  return validateConfig({
    initialized: current.initialized,
    service: { ...current.service, ...defined(service) },
    server: { ...current.server, ...defined(server) },
    web: { ...current.web, ...defined(web) },
    model: current.model,
  });
}

export function validateConfigUpdate(value: ConfigUpdate): void {
  mergeUpdate(defaults(), value);
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
    // Old files may still contain service.name; the next save drops it.
    return validateConfig(parsed, true);
  }

  function writeConfig(config: StardustConfig): void {
    const serialized = TOML.stringify({ initialized: config.initialized, service: { ...config.service }, server: { ...config.server }, web: { ...config.web }, model: { ...config.model } });
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

  function saveConfig(value: Omit<StardustConfig, "initialized"> & { initialized?: boolean }): void {
    const candidate = validateConfig(value);
    // Do not silently replace a malformed or unsupported existing configuration.
    const current = loadConfig();
    if (value.initialized !== undefined && candidate.initialized !== current.initialized) {
      throw new Error("普通设置不能修改 initialized");
    }
    writeConfig({ ...candidate, initialized: current.initialized });
  }

  function initializeConfig(input: ConfigUpdate): StardustConfig {
    // Synchronous read, check and atomic write form one critical section in this process.
    const current = loadConfig();
    if (current.initialized) throw new AlreadyInitializedError();
    const config = { ...mergeUpdate(current, input), initialized: true };
    writeConfig(config);
    return config;
  }

  return { loadConfig, saveConfig, initializeConfig, validateConfig };
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
