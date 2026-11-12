import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { isAbsolute, join, relative } from "node:path";
import { parseEnv } from "node:util";
import { createEnvLoader, projectConfigRoot } from "./env.js";
import { ModelError, modelService, type ModelService } from "./model.js";
import type { ChannelInstance, ChannelMessage, ExtensionPackage, ExtensionStatus } from "./channel.js";
import { logger, type LogService } from "./logger.js";

type Installed = Record<string, { enabled: boolean }>;
type Runtime = { state: ExtensionStatus; error?: string; instance?: ChannelInstance; controller?: AbortController };
export class ExtensionError extends Error {
  constructor(readonly code: string, readonly status = 400) { super(code); }
}

export class ExtensionManager {
  private readonly packages: Map<string, ExtensionPackage>;
  private readonly runtimes = new Map<string, Runtime>();
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  constructor(private readonly root = projectConfigRoot, private readonly model: Pick<ModelService, "chat"> = modelService, packages: ExtensionPackage[] = [], private readonly logs: LogService = logger) {
    if (!isAbsolute(root)) throw new Error("INVALID_ROOT");
    this.packages = new Map(packages.map((item) => [item.manifest.id, item]));
    for (const id of this.packages.keys()) this.validateId(id);
  }
  private validateId(id: string): void {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) || id.length > 64 || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(id)) throw new ExtensionError("INVALID_EXTENSION_ID");
  }
  private directory(parent: string, name: string, create: boolean): string | undefined {
    const path = join(parent, name);
    try { if (create) fs.mkdirSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    try {
      const stat = fs.lstatSync(path);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("INVALID_DIRECTORY");
      const actual = fs.realpathSync(path);
      const rel = relative(fs.realpathSync(parent), actual);
      if (!rel || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) throw new Error("INVALID_DIRECTORY");
      return actual;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT" && !create) return undefined; throw error; }
  }
  private safeFile(path: string): void {
    try { if (fs.lstatSync(path).isSymbolicLink()) throw new Error("INVALID_FILE"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  private writeAtomic(directory: string, name: string, contents: string): void {
    const path = join(directory, name);
    this.safeFile(path);
    const temporary = join(directory, `.${name}.${randomUUID()}.tmp`);
    let fd: number | undefined;
    try {
      fd = fs.openSync(temporary, "wx", 0o600);
      fs.writeFileSync(fd, contents, "utf8"); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      this.safeFile(path);
      fs.renameSync(temporary, path);
    } finally {
      if (fd !== undefined) try { fs.closeSync(fd); } catch {}
      try { fs.unlinkSync(temporary); } catch {}
    }
  }
  private readInstalled(): Installed {
    const data = this.directory(this.root, "data", false);
    if (!data) return Object.create(null) as Installed;
    const path = join(data, "extensions.json");
    try {
      this.safeFile(path);
      const parsed: unknown = JSON.parse(fs.readFileSync(path, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      const result: Installed = Object.create(null) as Installed;
      for (const [id, entry] of Object.entries(parsed)) {
        this.validateId(id);
        if (!entry || typeof entry !== "object" || Array.isArray(entry) || typeof (entry as { enabled?: unknown }).enabled !== "boolean") throw new Error();
        result[id] = { enabled: (entry as { enabled: boolean }).enabled };
      }
      return result;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return Object.create(null) as Installed; throw new ExtensionError("STATE_UNAVAILABLE", 500); }
  }
  private writeInstalled(state: Installed): void {
    try { this.writeAtomic(this.directory(this.root, "data", true)!, "extensions.json", `${JSON.stringify(state, null, 2)}\n`); }
    catch { throw new ExtensionError("SAVE_FAILED", 500); }
  }
  private item(id: string): ExtensionPackage {
    this.validateId(id);
    const item = this.packages.get(id);
    if (!item) throw new ExtensionError("EXTENSION_NOT_FOUND", 404);
    return item;
  }
  private values(id: string): Record<string, string> {
    const env = createEnvLoader(this.root).loadExtensionEnv(id);
    return env.configured ? env.values : {};
  }
  private serializeEnv(values: Record<string, string>): string {
    return Object.entries(values).map(([key, value]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || value.length > 4096 || /[^\x20-\x7e]/.test(value)) throw new ExtensionError("INVALID_INPUT");
      const encoded = [value, `'${value}'`, `"${value}"`].find((part) => parseEnv(`${key}=${part}`)[key] === value);
      if (encoded === undefined) throw new ExtensionError("INVALID_INPUT");
      return `${key}=${encoded}\n`;
    }).join("");
  }
  list() {
    const installed = this.readInstalled();
    return [...this.packages.values()].map(({ manifest }) => {
      const entry = installed[manifest.id];
      const values = entry ? this.values(manifest.id) : {};
      const secrets = manifest.fields.filter((field) => field.sensitive).map((field) => values[field.env]).filter((value): value is string => Boolean(value));
      const fields = manifest.fields.map((field) => ({ key: field.key, label: field.label, sensitive: field.sensitive, required: field.required, configured: Boolean(values[field.env]), ...(!field.sensitive ? { value: secrets.some((secret) => values[field.env]?.includes(secret)) ? "" : values[field.env] ?? "" } : {}) }));
      const runtime = this.runtimes.get(manifest.id);
      return { id: manifest.id, name: manifest.name, version: manifest.version, description: manifest.description, type: manifest.type, installed: Boolean(entry), enabled: entry?.enabled ?? false, state: runtime?.state ?? "disconnected", ...(runtime?.error ? { error: runtime.error } : {}), fields };
    });
  }
  private exclusive<T>(action: () => T | Promise<T>): Promise<T> {
    const next = this.queue.then(() => { if (this.closed) throw new ExtensionError("SHUTTING_DOWN", 503); return action(); });
    this.queue = next.catch(() => undefined);
    return next;
  }
  private operation<T>(id: string, operation: string, action: () => T | Promise<T>): Promise<T> {
    return this.exclusive(action).then((result) => { this.logs.write("INFO", "extensions", `扩展${operation}成功。`, { code: this.packages.has(id) ? id : undefined }); return result; }, (error: unknown) => { this.logs.write("ERROR", "extensions", `扩展${operation}失败。`, { code: error instanceof ExtensionError ? error.code : "EXTENSION_FAILED" }); throw error; });
  }
  install(id: string): Promise<void> { return this.operation(id, "安装", () => { this.item(id); const state = this.readInstalled(); if (state[id]) throw new ExtensionError("ALREADY_INSTALLED", 409); state[id] = { enabled: false }; this.writeInstalled(state); }); }
  saveConfig(id: string, input: unknown): Promise<void> { return this.operation(id, "配置保存", async () => {
    const item = this.item(id); const state = this.readInstalled(); if (!state[id]) throw new ExtensionError("NOT_INSTALLED", 404);
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new ExtensionError("INVALID_INPUT");
    const fields = input as Record<string, unknown>;
    if (Object.keys(fields).some((key) => !item.manifest.fields.some((field) => field.key === key))) throw new ExtensionError("INVALID_INPUT");
    const values = this.values(id);
    for (const field of item.manifest.fields) {
      const value = fields[field.key];
      if (value === undefined) continue;
      if (value === null || value === "") delete values[field.env];
      else if (typeof value === "string" && value.trim() && value.length <= 4096 && /^[\x20-\x7e]+$/.test(value)) values[field.env] = value.trim();
      else throw new ExtensionError("INVALID_INPUT");
    }
    const contents = this.serializeEnv(values);
    try { const env = this.directory(this.root, "env", true)!; const dir = this.directory(env, id, true)!; this.writeAtomic(dir, ".env", contents); }
    catch (error) { if (error instanceof ExtensionError) throw error; throw new ExtensionError("SAVE_FAILED", 500); }
    if (state[id]!.enabled) { await this.stop(id); if (!this.closed) this.launch(item); }
  }); }
  enable(id: string): Promise<void> { return this.operation(id, "启用", () => {
    const item = this.item(id); const state = this.readInstalled(); if (!state[id]) throw new ExtensionError("NOT_INSTALLED", 404);
    const values = this.values(id); if (item.manifest.fields.some((field) => field.required && !values[field.env])) throw new ExtensionError("NOT_CONFIGURED");
    if (!state[id]!.enabled) { state[id]!.enabled = true; this.writeInstalled(state); }
    if (!this.runtimes.get(id)?.instance) this.launch(item);
  }); }
  disable(id: string): Promise<void> { return this.operation(id, "停用", async () => { this.item(id); const state = this.readInstalled(); if (!state[id]) throw new ExtensionError("NOT_INSTALLED", 404); state[id]!.enabled = false; this.writeInstalled(state); await this.stop(id); }); }
  uninstall(id: string, deleteConfig: boolean): Promise<void> { return this.operation(id, "卸载", async () => {
    this.item(id); const state = this.readInstalled(); if (!state[id]) throw new ExtensionError("NOT_INSTALLED", 404);
    if (deleteConfig) {
      try { const env = this.directory(this.root, "env", false); const dir = env && this.directory(env, id, false); if (dir) { const path = join(dir, ".env"); this.safeFile(path); try { fs.unlinkSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } try { fs.rmdirSync(dir); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOTEMPTY") throw error; } } }
      catch { throw new ExtensionError("DELETE_CONFIG_FAILED", 500); }
    }
    delete state[id]; this.writeInstalled(state); await this.stop(id); this.runtimes.delete(id);
  }); }
  restore(): Promise<void> { return this.exclusive(() => { const state = this.readInstalled(); for (const item of this.packages.values()) if (state[item.manifest.id]?.enabled && !this.runtimes.get(item.manifest.id)?.instance) this.launch(item); }); }
  private launch(item: ExtensionPackage): void {
    const id = item.manifest.id;
    this.logs.write("INFO", "extensions", "扩展启动中。", { code: id });
    let values: Record<string, string>;
    try { values = this.values(id); } catch { this.logs.write("ERROR", "extensions", "扩展配置读取失败。", { code: id }); this.runtimes.set(id, { state: "error", error: "无法读取扩展配置。" }); return; }
    if (item.manifest.fields.some((field) => field.required && !values[field.env])) { this.logs.write("WARN", "extensions", "扩展配置不完整，未启动。", { code: id }); this.runtimes.set(id, { state: "error", error: "扩展配置不完整。" }); return; }
    const config = Object.fromEntries(item.manifest.fields.map((field) => [field.key, values[field.env] ?? ""]));
    const controller = new AbortController();
    const runtime: Runtime = { state: "connecting", controller };
    this.runtimes.set(id, runtime);
    try {
      runtime.instance = item.create(config, {
        status: (state, error) => { if (this.runtimes.get(id) === runtime && !controller.signal.aborted) { runtime.state = state; if (error) runtime.error = "扩展连接失败，请检查配置、网络和平台权限。"; } },
        log: (level, message, details) => { if (this.runtimes.get(id) === runtime && !controller.signal.aborted) this.logs.write(level, id, message, details, item.manifest.fields.filter((field) => field.sensitive).map((field) => config[field.key] ?? "")); },
        reportError: (code) => { if (this.runtimes.get(id) === runtime && !controller.signal.aborted) runtime.error = code === "MODEL_FAILED" ? runtime.error ?? "模型请求失败，请检查模型配置和服务状态。" : "渠道发送失败，请检查平台权限和连接状态。"; },
        message: async (message: ChannelMessage, signal: AbortSignal) => {
          if (controller.signal.aborted || signal.aborted || message.channelId !== id) throw new Error("STOPPED");
          runtime.error = undefined;
          try { return await this.model.chat(message.content, AbortSignal.any([controller.signal, signal]), { eventId: message.eventId }); }
          catch (error) {
            if (!controller.signal.aborted && !signal.aborted) {
              const categories: Record<string, string> = { NOT_CONFIGURED: "模型未配置。", AUTH_FAILED: "模型认证失败。", MODEL_NOT_FOUND: "模型不存在。", RATE_LIMITED: "模型请求受到限流。", TIMEOUT: "模型请求超时。" };
              runtime.error = error instanceof ModelError ? categories[error.code] ?? "模型请求失败，请检查模型服务状态。" : "模型请求失败，请检查模型服务状态。";
            }
            throw new Error("MODEL_FAILED");
          }
        },
      });
      runtime.instance.start();
    } catch { this.logs.write("ERROR", "extensions", "扩展启动异常。", { code: id }); controller.abort(); runtime.instance = undefined; runtime.state = "error"; runtime.error = "扩展启动失败，请检查配置。"; }
  }
  private async stop(id: string): Promise<void> { const runtime = this.runtimes.get(id); if (!runtime) return; runtime.controller?.abort(); let pending: void | Promise<void> = undefined; try { pending = runtime.instance?.stop(); } catch {} this.runtimes.set(id, { state: "disconnected" }); try { await pending; } catch {} }
  async shutdown(): Promise<void> { this.closed = true; await Promise.all([...this.runtimes.keys()].map((id) => this.stop(id))); }
}
