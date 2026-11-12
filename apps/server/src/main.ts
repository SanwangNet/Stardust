import { createStardustServer } from "./app.js";
import { loadCoreEnv } from "./env.js";
import { resolveListenConfig } from "./config.js";

const { host, port } = resolveListenConfig(loadCoreEnv());
const server = createStardustServer();

server.on("error", () => {
  console.error("[Stardust] 服务启动失败，请检查监听配置。");
  process.exitCode = 1;
});

server.listen(port, host, () => {
  console.log("\n  Stardust v0.1.0");
  console.log("  ──────────────────────────────────");
  console.log("  已启动基础服务（尚无初始化、模型及 Agent）\n");
});

let closing = false;
function shutdown(signal: string): void {
  if (closing) return;
  closing = true;
  console.log(`[Stardust] 收到 ${signal}，正在关闭……`);
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


