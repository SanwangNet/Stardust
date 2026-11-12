import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import { AlreadyInitializedError, ConfigValidationError, validateConfigUpdate, type ConfigUpdate } from "./config.js";
import type { SetupService } from "./setup.js";

/** Interactive input can be supplied for tests; production calls this only for a TTY. */
export async function runSetupWizard(setup: SetupService, input: Readable, output: Writable): Promise<void> {
  const readline = createInterface({ input, output, terminal: Boolean((input as NodeJS.ReadStream).isTTY) });
  const abort = new AbortController();
  let completedElsewhere = false;
  let stopped = false;
  const stop = () => { if (!stopped) { stopped = true; abort.abort(); } };
  readline.on("SIGINT", stop);
  readline.on("close", stop);
  const timer = setInterval(() => {
    try {
      if (setup.getInitializationState().initialized) {
        completedElsewhere = true;
        stop();
      }
    } catch {
      output.write("\n无法读取初始化状态，已退出向导。\n");
      stop();
    }
  }, 1000);
  timer.unref();
  async function ask(prompt: string): Promise<string> {
    const answer = await readline.question(prompt, { signal: abort.signal });
    if (answer.trim() === ":q") { stop(); throw new Error("CANCELLED"); }
    return answer;
  }
  async function field(prompt: string, initial: string, makeUpdate: (value: string) => ConfigUpdate): Promise<string> {
    for (;;) {
      const value = (await ask(`${prompt} [${initial || "空"}]：`)) || initial;
      try {
        validateConfigUpdate(makeUpdate(value));
        return value;
      } catch (error) {
        if (!(error instanceof ConfigValidationError)) throw error;
        output.write(`${error.message}，请重新输入。\n`);
      }
    }
  }
  async function yesNo(prompt: string, defaultYes: boolean): Promise<boolean> {
    for (;;) {
      const choice = (await ask(prompt)).trim().toLowerCase();
      if (!choice) return defaultYes;
      if (["y", "yes"].includes(choice)) return true;
      if (["n", "no"].includes(choice)) return false;
      output.write("请输入 y 或 n。\n");
    }
  }
  try {
    await ask("");
    if (setup.getInitializationState().initialized) { completedElsewhere = true; return; }
    const initial = setup.getSetupConfig();
    output.write("\n欢迎使用 Stardust。（输入 :q 或按 Ctrl+C 取消）\n");
    const description = await field("服务描述", initial.service.description, (value) => ({ service: { description: value } }));
    const title = await field("WebUI 标题", initial.web.title, (value) => ({ web: { title: value } }));
    let host = initial.server.host;
    let port = initial.server.port;
    if (await yesNo("修改监听地址和端口？[y/N]：", false)) {
      host = await field("监听地址", host, (value) => ({ server: { host: value } }));
      const portValue = await field("端口", String(port), (value) => ({ server: { port: /^\d+$/.test(value) ? Number(value) : NaN } }));
      port = Number(portValue);
      output.write("监听地址和端口的更改将在重启后生效。\n");
    }
    output.write(`\n服务描述：${description}\nWebUI 标题：${title}\n监听地址：${host}\n端口：${port}\n`);
    while (await yesNo("确认完成初始化？[Y/n]：", true)) {
      try {
        await setup.completeInitialization({ service: { description }, server: { host, port }, web: { title } });
        output.write("初始化完成，服务继续运行。\n");
        return;
      } catch (error) {
        if (error instanceof AlreadyInitializedError) { output.write("初始化已由其他入口完成。\n"); return; }
        output.write("初始化保存失败，请重试或取消。\n");
      }
    }
    output.write("已取消初始化。\n");
  } catch (error) {
    if (!stopped) output.write("\n初始化向导已退出。\n");
    else if (!completedElsewhere) output.write("\n已取消初始化。\n");
  } finally {
    clearInterval(timer);
    readline.close();
    if (completedElsewhere) output.write("\n初始化已由其他入口完成。\n");
  }
}
