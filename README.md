# Stardust / 星尘

**第一个可运行的项目骨架。** 独立 TypeScript 后端 + 简单 TypeScript WebUI；不包含 TenBot 旧代码，也不实现初始化、模型、Agent、数据库或 QQ。

## 环境要求

- Node.js 22 或更高版本（推荐当前受支持的 LTS）
- npm（随 Node.js 提供）

## 运行

```powershell
npm install
npm run dev
```

打开 **http://127.0.0.1:8347**，网页会自动请求真实的后端 `GET /api/health`，展示连接状态、版本、运行时间和最近检查时间。

- `npm run build`：TypeScript 编译并复制前端静态文件
- `npm start`：运行已构建的后端（需要先构建）
- `npm run check`：TypeScript 类型检查
- `npm test`：编译并运行基础 HTTP 测试

目前 `dev` 是**构建一次后启动**，修改前端后请重新执行。为了保持骨架简单，尚未加入热更新、React、Vite 或后台文件监视。未来引入 React/Vite 时只需替换 `apps/web`，保留服务端 API 和模块边界。

## 运行约束

- 默认绑定 `127.0.0.1`，端口 `8347`，**没有登录认证，不能直接开放到不可信网络**。
- 可用 `STARDUST_PORT` / `STARDUST_HOST` 临时修改监听地址，例如 PowerShell：

```powershell
$env:STARDUST_PORT = '8350'
npm run dev
```

- 可将根目录 `.env.example` 复制为 `.env` 设置 Core 的监听地址；进程环境变量优先于文件。扩展配置位于 `env/<extension-id>/.env`，各扩展独立读取，缺失时视为未配置。ID 仅支持小写字母、数字及连接符，例如 `qq-bot`。不要提交真实 `.env`。
- 不会自动读旧 TenBot 的配置或平台账户，QQ 示例仅提供配置项。
- 默认仅提供一个真实 API：`GET /api/health`。页面没有伪造 Agent、记忆和模型数据。

## 目录

```text
apps/server/src/    TypeScript HTTP Server 和健康检查接口
apps/web/src/       TypeScript 前端、CSS 和 HTML
scripts/            构建辅助脚本
tests/              HTTP 行为测试
```

## 后续路线（未实现）

完成本版手动验收后，再决定是否将 WebUI 升级为 React + Vite，然后按既定计划逐项增加 CLI/Web 双入口初始化、配置与应用生命周期。当前仅负责**最小的前后端连通闭环**。

Git 的 `add / commit / push` 由项目拥有者自行执行。

