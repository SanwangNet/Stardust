import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const children = new Set();
// A fresh private proof binds this launch's loopback Vite proxy to its backend; it is not user authentication.
const devProxyProof = randomBytes(32).toString("base64url");
let stopping = false;
function start(script, args = [], nodeArgs = []) {
  const child = spawn(process.execPath, [...nodeArgs, script, ...args], { cwd: root, stdio: "inherit", env: { ...process.env, STARDUST_DEV_PROXY_PROOF: devProxyProof, STARDUST_HOST: process.env.STARDUST_HOST ?? "127.0.0.1", STARDUST_PORT: process.env.STARDUST_PORT ?? "8347" } });
  children.add(child);
  child.once("exit", (code, signal) => {
    children.delete(child);
    if (!stopping) stop(code || (signal ? 1 : 0));
  });
  child.once("error", (error) => { console.error(error.message); stop(1); });
  return child;
}
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) child.kill();
}
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());

const compiler = spawn(process.execPath, ["node_modules/typescript/bin/tsc", "-p", "apps/server/tsconfig.json"], { cwd: root, stdio: "inherit" });
children.add(compiler);
compiler.once("error", (error) => { console.error(error.message); stop(1); });
compiler.once("exit", (code) => {
  children.delete(compiler);
  if (stopping) return;
  if (code !== 0) { stop(code || 1); return; }
  start("apps/server/dist/main.js", [], ["--experimental-sqlite"]);
  start("node_modules/vite/bin/vite.js", ["--config", "vite.config.mjs"]);
});
