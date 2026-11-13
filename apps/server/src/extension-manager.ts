import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { isAbsolute, join, relative } from "node:path";
import { parseEnv } from "node:util";
import { createEnvLoader, projectConfigRoot } from "./env.js";
import { ModelError, modelService, type ModelService } from "./model.js";
import type { CapabilityTestInput, ChannelInstance, ChannelMessage, ExtensionPackage, ExtensionStatus, ToolDefinition, ToolHost, MessageTarget, ChannelSendResult, ToolInput, ToolResult } from "./channel.js";
import { logger, type LogService } from "./logger.js";

type InstalledEntry = { enabled: boolean; installed?: boolean; tools?: Record<string, boolean>; [key: string]: unknown };
type Installed = Record<string, InstalledEntry>;
const isInstalled = (entry: InstalledEntry | undefined): boolean => Boolean(entry && entry.installed !== false);
type Runtime = { state: ExtensionStatus; error?: string; instance?: ChannelInstance; controller?: AbortController };
export class ExtensionError extends Error {
  constructor(readonly code: string, readonly status = 400) { super(code); }
}

export class ExtensionManager {
  private readonly packages: Map<string, ExtensionPackage>;
  private readonly runtimes = new Map<string, Runtime>();
  private readonly toolControllers = new Map<string, AbortController>();
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  constructor(private readonly root = projectConfigRoot, private readonly model: Pick<ModelService, "chat"> = modelService, packages: ExtensionPackage[] = [], private readonly logs: LogService = logger) {
    if (!isAbsolute(root)) throw new Error("INVALID_ROOT");
    this.packages = new Map(packages.map((item) => [item.manifest.id, item]));
    for (const id of this.packages.keys()) this.validateId(id);
    const names = new Set<string>();
    for (const item of this.packages.values()) for (const tool of this.packageTools(item)) {
      if (names.has(tool.name)) throw new Error("DUPLICATE_TOOL");
      names.add(tool.name);
    }
  }
  private packageTools(item: ExtensionPackage): ToolDefinition[] { return item.tools ?? (item.tool ? [item.tool] : []); }
  private ownerOfTool(name: string): ExtensionPackage | undefined { return [...this.packages.values()].find((item) => this.packageTools(item).some((tool) => tool.name === name)); }
  private toolEnabled(item: ExtensionPackage, tool: ToolDefinition, state: Installed): boolean {
    const entry = state[item.manifest.id];
    return isInstalled(entry) && Boolean(entry?.enabled) && (item.manifest.type === "tool" ? true : entry?.tools?.[tool.name] === true);
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
        const value = entry as InstalledEntry;
        if (value.installed !== undefined && typeof value.installed !== "boolean") throw new Error();
        if (value.tools !== undefined && (!value.tools || typeof value.tools !== "object" || Array.isArray(value.tools) || Object.values(value.tools).some((flag) => typeof flag !== "boolean"))) throw new Error();
        result[id] = { ...value, ...(value.tools ? { tools: { ...value.tools } } : {}) };
      }
      let migrated = false;
      for (const item of this.packages.values()) for (const tool of this.packageTools(item)) {
        const legacyId = tool.legacyExtensionId;
        if (!legacyId || legacyId === item.manifest.id || !result[legacyId]) continue;
        const owner = result[item.manifest.id] ?? { enabled: false, installed: false };
        const tools = { ...owner.tools };
        if (tools[tool.name] === undefined) tools[tool.name] = result[legacyId]!.enabled;
        result[item.manifest.id] = { ...owner, tools };
        delete result[legacyId]; migrated = true;
      }
      if (migrated) this.writeInstalled(result);
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
      const entry = isInstalled(installed[manifest.id]) ? installed[manifest.id] : undefined;
      const values = entry ? this.values(manifest.id) : {};
      const secrets = manifest.fields.filter((field) => field.sensitive).map((field) => values[field.env]).filter((value): value is string => Boolean(value));
      const fields = manifest.fields.map((field) => ({ key: field.key, label: field.label, sensitive: field.sensitive, required: field.required, configured: Boolean(values[field.env]), ...(!field.sensitive ? { value: secrets.some((secret) => values[field.env]?.includes(secret)) ? "" : values[field.env] ?? "" } : {}) }));
      const runtime = this.runtimes.get(manifest.id);
      const item = this.packages.get(manifest.id)!;
      const tools = this.packageTools(item).map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters, enabled: entry?.tools?.[tool.name] === true, available: Boolean(entry?.tools?.[tool.name] && entry?.enabled && runtime?.state === "connected") }));
      return { id: manifest.id, name: manifest.name, version: manifest.version, description: manifest.description, type: manifest.type, installed: Boolean(entry), enabled: entry?.enabled ?? false, state: runtime?.state ?? "disconnected", ...(runtime?.error ? { error: runtime.error } : {}), fields, managementPages: manifest.managementPages ?? [], skills: manifest.skills ?? [], tools };
    });
  }
  capabilityTargets(id: string) {
    this.item(id);
    if (!isInstalled(this.readInstalled()[id])) throw new ExtensionError("NOT_INSTALLED", 404);
    return this.runtimes.get(id)?.instance?.getCapabilityTargets?.() ?? [];
  }
  availableTools(): ToolDefinition[] {
    const state = this.readInstalled();
    return [...this.packages.values()].flatMap((item) => this.runtimes.get(item.manifest.id)?.state === "connected" ? this.packageTools(item).filter((tool) => this.toolEnabled(item, tool, state)) : []);
  }
  toolSignal(name: string): AbortSignal | undefined {
    const item = this.ownerOfTool(name);
    const tool = item && this.packageTools(item).find((candidate) => candidate.name === name);
    if (!item || !tool || !this.toolEnabled(item, tool, this.readInstalled())) return undefined;
    const runtime = this.runtimes.get(item.manifest.id);
    if (runtime?.state !== "connected" || !runtime.controller) return undefined;
    const key = `${item.manifest.id}:${name}`;
    let controller = this.toolControllers.get(key);
    if (!controller || controller.signal.aborted) { controller = new AbortController(); this.toolControllers.set(key, controller); }
    return AbortSignal.any([runtime.controller.signal, controller.signal]);
  }
  channelSignal(id: string): AbortSignal | undefined {
    const item = this.packages.get(id);
    const entry = this.readInstalled()[id];
    if (!item || item.manifest.type !== "channel" || !isInstalled(entry) || !entry?.enabled) return undefined;
    const runtime = this.runtimes.get(id);
    return runtime?.state === "connected" ? runtime.controller?.signal : undefined;
  }
  async executeTool(name: string, input: Readonly<ToolInput>, signal: AbortSignal): Promise<ToolResult> {
    const item = this.ownerOfTool(name);
    const tool = item && this.packageTools(item).find((candidate) => candidate.name === name);
    const lease = this.toolSignal(name);
    if (!tool || !lease || lease.aborted) return { status: "unavailable", code: "TOOL_DISABLED" };
    const validated = tool.validate(input);
    if (!validated) return { status: "unavailable", code: "INVALID_ARGUMENTS" };
    return tool.execute(validated, this.toolHost(), AbortSignal.any([signal, lease]));
  }
  availableTargets(): { channel: string; targets: MessageTarget[] }[] {
    const state = this.readInstalled();
    return [...this.packages.values()].filter((item) => item.manifest.type === "channel" && isInstalled(state[item.manifest.id]) && state[item.manifest.id]?.enabled && this.runtimes.get(item.manifest.id)?.state === "connected").map((item) => ({ channel: item.manifest.id, targets: this.runtimes.get(item.manifest.id)?.instance?.listMessageTargets?.() ?? [] })).filter((item) => item.targets.length > 0);
  }
  toolHost(): ToolHost {
    return {
      targets: (channel) => this.availableTargets().find((item) => item.channel === channel)?.targets ?? [],
      send: async (channel, target, content, signal): Promise<ChannelSendResult> => {
        const state = this.readInstalled()[channel];
        const runtime = this.runtimes.get(channel);
        if (!isInstalled(state) || !state?.enabled || runtime?.state !== "connected" || !runtime.instance?.sendMessage || signal.aborted) return { status: "unavailable", code: "CHANNEL_UNAVAILABLE" };
        const targets = runtime.instance.listMessageTargets?.() ?? [];
        const selected = targets.find((item) => item.id === target);
        if (!selected || Date.parse(selected.expiresAt) <= Date.now()) return { status: "unavailable", code: "TARGET_UNAVAILABLE" };
        if (targets.filter((item) => item.scope === selected.scope).length !== 1) return { status: "unavailable", code: "TARGET_AMBIGUOUS" };
        return runtime.instance.sendMessage(target, content, signal);
      },
    };
  }
  runCapabilityTest(id: string, input: CapabilityTestInput) {
    this.item(id);
    const state = this.readInstalled()[id];
    if (!isInstalled(state)) throw new ExtensionError("NOT_INSTALLED", 404);
    const runtime = this.runtimes.get(id);
    if (!state?.enabled || runtime?.state !== "connected" || !runtime.instance?.runCapabilityTest) throw new ExtensionError("EXTENSION_NOT_CONNECTED", 409);
    return runtime.instance.runCapabilityTest(input);
  }
  setToolEnabled(id: string, name: string, enabled: boolean): Promise<void> { return this.operation(id, "Tool 设置", () => {
    const item = this.item(id); const state = this.readInstalled(); const entry = state[id];
    if (!isInstalled(entry)) throw new ExtensionError("NOT_INSTALLED", 404);
    if (!this.packageTools(item).some((tool) => tool.name === name)) throw new ExtensionError("TOOL_NOT_FOUND", 404);
    entry!.tools = { ...entry!.tools, [name]: enabled }; this.writeInstalled(state);
    if (!enabled) { const key = `${id}:${name}`; this.toolControllers.get(key)?.abort(); this.toolControllers.delete(key); }
  }); }
  private exclusive<T>(action: () => T | Promise<T>): Promise<T> {
    const next = this.queue.then(() => { if (this.closed) throw new ExtensionError("SHUTTING_DOWN", 503); return action(); });
    this.queue = next.catch(() => undefined);
    return next;
  }
  private operation<T>(id: string, operation: string, action: () => T | Promise<T>): Promise<T> {
    return this.exclusive(action).then((result) => { this.logs.write("INFO", "extensions", `扩展${operation}成功。`, { code: this.packages.has(id) ? id : undefined }); return result; }, (error: unknown) => { this.logs.write("ERROR", "extensions", `扩展${operation}失败。`, { code: error instanceof ExtensionError ? error.code : "EXTENSION_FAILED" }); throw error; });
  }
  install(id: string): Promise<void> { return this.operation(id, "安装", () => { this.item(id); const state = this.readInstalled(); if (isInstalled(state[id])) throw new ExtensionError("ALREADY_INSTALLED", 409); state[id] = { ...state[id], installed: true, enabled: false }; this.writeInstalled(state); }); }
  saveConfig(id: string, input: unknown): Promise<void> { return this.operation(id, "配置保存", async () => {
    const item = this.item(id); const state = this.readInstalled(); if (!isInstalled(state[id])) throw new ExtensionError("NOT_INSTALLED", 404);
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
    const item = this.item(id); const state = this.readInstalled(); if (!isInstalled(state[id])) throw new ExtensionError("NOT_INSTALLED", 404);
    const values = this.values(id); if (item.manifest.fields.some((field) => field.required && !values[field.env])) throw new ExtensionError("NOT_CONFIGURED");
    if (!state[id]!.enabled) { state[id]!.enabled = true; this.writeInstalled(state); }
    if (!this.runtimes.get(id)?.instance) this.launch(item);
  }); }
  disable(id: string): Promise<void> { return this.operation(id, "停用", async () => { this.item(id); const state = this.readInstalled(); if (!isInstalled(state[id])) throw new ExtensionError("NOT_INSTALLED", 404); state[id]!.enabled = false; this.writeInstalled(state); await this.stop(id); }); }
  uninstall(id: string, deleteConfig: boolean): Promise<void> { return this.operation(id, "卸载", async () => {
    this.item(id); const state = this.readInstalled(); if (!isInstalled(state[id])) throw new ExtensionError("NOT_INSTALLED", 404);
    if (deleteConfig) {
      try { const env = this.directory(this.root, "env", false); const dir = env && this.directory(env, id, false); if (dir) { const path = join(dir, ".env"); this.safeFile(path); try { fs.unlinkSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } try { fs.rmdirSync(dir); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOTEMPTY") throw error; } } }
      catch { throw new ExtensionError("DELETE_CONFIG_FAILED", 500); }
    }
    if (deleteConfig) delete state[id]; else state[id] = { ...state[id]!, installed: false, enabled: false };
    this.writeInstalled(state); await this.stop(id); this.runtimes.delete(id);
  }); }
  restore(): Promise<void> { return this.exclusive(() => { const state = this.readInstalled(); for (const item of this.packages.values()) if (isInstalled(state[item.manifest.id]) && state[item.manifest.id]?.enabled && !this.runtimes.get(item.manifest.id)?.instance) this.launch(item); }); }
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
