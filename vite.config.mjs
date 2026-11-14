import { defineConfig } from "vite";
import { loadConfig, resolveConfig } from "./apps/server/dist/config.js";
import { loadCoreEnv } from "./apps/server/dist/env.js";

const server = resolveConfig(loadConfig(), loadCoreEnv()).server;
const host = server.host === "0.0.0.0" ? "127.0.0.1" : server.host === "::" ? "[::1]" : server.host.includes(":") ? `[${server.host}]` : server.host;
if (!["127.0.0.1", "localhost", "[::1]"].includes(host)) throw new Error("开发代理仅支持本机后端地址，请设置 STARDUST_HOST 为回环地址。");

export default defineConfig({
  root: "apps/web/src",
  plugins: [{
    name: "stardust-dev-entry",
    transformIndexHtml(html) {
      return html.replace('<link rel="stylesheet" href="/style.css" />', '')
        .replace('<script type="module" src="/main.js"></script>', '<script type="module">import "/style.css"; import "/main.ts";</script>');
    },
  }],
  server: {
    host: "127.0.0.1", port: 5173, strictPort: true,
    proxy: { "/api": { target: `http://${host}:${server.port}`, changeOrigin: false } },
  },
});
