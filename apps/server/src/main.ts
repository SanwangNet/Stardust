import { createStardustServer } from "./app.js";
import { loadCoreEnv } from "./env.js";
import { loadConfig, resolveConfig } from "./config.js";
import { setupService } from "./setup.js";
import { runSetupWizard } from "./setup-cli.js";
import { ExtensionManager } from "./extension-manager.js";
import { bundledExtensions } from "./extensions/index.js";
import { logger } from "./logger.js";

let listenConfig: { host: string; port: number } | undefined;
try { listenConfig = resolveConfig(loadConfig(), loadCoreEnv()).server; }
catch { logger.write("ERROR", "server", "配置读取失败，服务无法启动。"); process.exitCode = 1; }

if (listenConfig) {
  const { host, port } = listenConfig;
  const extensions = new ExtensionManager(undefined, undefined, bundledExtensions);
  const server = createStardustServer({ extensionManager: extensions });

  server.on("error", () => {
    logger.write("ERROR", "server", "服务启动或运行失败，请检查监听配置。");
    process.exitCode = 1;
  });

  server.listen(port, host, () => {
    logger.write("INFO", "server", "Stardust 服务已启动。");
    const address = server.address();
    if (address && typeof address !== "string") {
      const listenHost = address.address.includes(":") ? `[${address.address}]` : address.address;
      logger.write("INFO", "server", `WebUI: http://${listenHost}:${address.port}`);
    }
    try {
      if (!setupService.getInitializationState().initialized) {
        logger.write("INFO", "server", "请在 WebUI 中完成初始化。");
        if (process.stdin.isTTY) {
          logger.write("INFO", "server", "或按下 Enter 在终端中继续。");
          void runSetupWizard(setupService, process.stdin, process.stdout);
        }
      }
    } catch { logger.write("ERROR", "server", "无法读取初始化状态。"); }
  });

  let closing = false;
  function shutdown(signal: string): void {
    if (closing) return;
    closing = true;
    logger.write("INFO", "server", `收到 ${signal}，正在关闭服务。`);
    void extensions.shutdown();
    server.close((error) => {
      if (error) {
        logger.write("ERROR", "server", "服务关闭失败。");
        process.exitCode = 1;
      } else logger.write("INFO", "server", "服务已关闭。");
    });
    server.closeAllConnections();
  }

  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}
