import { readRunningCommit } from "./app.js";

type Fetcher = typeof fetch;
export interface UpdateInfo {
  current: { version: string; sha: string };
  latest: { version: string | null; sha: string; message: string; url: string };
  updateAvailable: boolean | null;
}

/** Read-only, fixed repository lookup. No checkout, build, or privileged operation. */
export async function checkSoftwareUpdate(version: string, fetcher: Fetcher = fetch, currentSha = readRunningCommit()): Promise<UpdateInfo> {
  async function github(path: string): Promise<unknown> {
    const response = await fetcher(`https://api.github.com/repos/SanwangNet/Stardust/${path}`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "Stardust-update-check" },
      redirect: "error", signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error(`远程版本检查失败（HTTP ${response.status}）`);
    const text = await response.text();
    if (text.length > 262144) throw new Error("远程版本信息过大");
    try { return JSON.parse(text) as unknown; } catch { throw new Error("远程版本信息格式错误"); }
  }
  const data = await github("commits/main") as { sha?: unknown; commit?: { message?: unknown } };
  if (typeof data?.sha !== "string" || !/^[a-f0-9]{40}$/.test(data.sha) || typeof data.commit?.message !== "string") throw new Error("远程版本信息格式错误");
  const sha = data.sha;
  let latestVersion: string | null = null;
  try {
    const file = await github(`contents/package.json?ref=${sha}`) as { encoding?: unknown; content?: unknown };
    if (file.encoding === "base64" && typeof file.content === "string" && file.content.length <= 65536) {
      const pkg: unknown = JSON.parse(Buffer.from(file.content, "base64").toString("utf8"));
      if (pkg && typeof pkg === "object" && "version" in pkg && typeof pkg.version === "string" && /^[0-9A-Za-z.+-]{1,80}$/.test(pkg.version)) latestVersion = pkg.version;
    }
  } catch { /* Commit remains useful when version metadata is unavailable. */ }
  return { current: { version, sha: currentSha }, latest: { version: latestVersion, sha, message: data.commit.message.slice(0, 4096), url: `https://github.com/SanwangNet/Stardust/commit/${sha}` }, updateAvailable: /^[a-f0-9]{40}$/.test(currentSha) ? currentSha !== sha : null };
}
