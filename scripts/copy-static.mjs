import { copyFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const webRoot = join(root, "apps", "web");
await mkdir(join(webRoot, "dist"), { recursive: true });
for (const filename of ["index.html", "style.css", "favicon.svg"]) {
  await copyFile(join(webRoot, "src", filename), join(webRoot, "dist", filename));
}
console.log("[Stardust] 前端静态文件已准备好");
