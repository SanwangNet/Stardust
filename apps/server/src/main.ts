import { createStardustServer } from "./app.js";
import { loadCoreEnv } from "./env.js";
import { loadConfig, resolveConfig } from "./config.js";
import { setupService } from "./setup.js";
import { runSetupWizard } from "./setup-cli.js";
import { ExtensionManager } from "./extension-manager.js";
import { bundledExtensions } from "./extensions/index.js";

const { host, port } = resolveConfig(loadConfig(), loadCoreEnv()).server;
const extensions = new ExtensionManager(undefined, undefined, bundledExtensions);
const server = createStardustServer({ extensionManager: extensions });

server.on("error", () => {
  console.error("[Stardust] 服务启动失败，请检查监听配置。");
  process.exitCode = 1;
});

server.listen(port, host, () => {
  console.log("\nStardust\n服务已启动。");
  const address = server.address();
  if (address && typeof address !== "string") {
    const listenHost = address.address.includes(":") ? `[${address.address}]` : address.address;
    console.log(`WebUI: http://${listenHost}:${address.port}`);
  }
  if (!setupService.getInitializationState().initialized) {
    console.log("请在 WebUI 中完成初始化。");
    if (process.stdin.isTTY) {
      console.log("或按下 Enter 在终端中继续。");
      void runSetupWizard(setupService, process.stdin, process.stdout);
    }
  }
});

let closing = false;
function shutdown(signal: string): void {
  if (closing) return;
  closing = true;
  console.log(`[Stardust] 收到 ${signal}，正在关闭……`);
  void extensions.shutdown();
  server.close((error) => {
    if (error) {
      console.error("[Stardust] 关闭失败。");
      process.exitCode = 1;
    }
  });
  server.closeAllConnections();
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
