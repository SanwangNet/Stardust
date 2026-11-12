# Stardust / 星尘

独立 TypeScript 后端和 WebUI，支持单个 OpenAI-compatible 模型，以及项目内提供的 QQ 官方机器人渠道扩展。

## 环境要求

- Node.js 22 或更高版本（推荐当前受支持的 LTS）
- npm（随 Node.js 提供）

## 运行

```powershell
npm install
npm run dev
```

打开 **http://127.0.0.1:8347**，网页会自动请求真实的后端 `GET /api/health`，展示连接状态、版本、运行时间和最近检查时间。

首次启动时，在浏览器打开终端显示的 WebUI 地址并按步骤完成初始化；也可在交互式终端按 Enter 开始向导，直接按 Enter 使用默认值，输入 `:q` 或按 Ctrl+C 取消。两种入口使用同一份配置，先完成的一方生效；初始化后服务继续运行。修改监听地址或端口需要重启，环境变量仍优先于保存的配置。

初始化后可在页面配置 OpenAI-compatible Chat Completions 的 API Base URL（例如服务的 `/v1` 地址）、模型 ID、超时时间和可选 API Key，保存后测试连接并发送单轮消息。每次请求只发送当前消息；页面对话不持久化，连接测试也会发起一次模型请求，可能产生费用。

「模型 → 日志」展示 Server、模型服务和扩展的近期运行日志，通过 SSE 接收新记录。可暂停页面更新、复制或清空当前显示；清空页面不会删除服务端缓冲区。日志只保存在内存中，最多保留最近 1000 条，Server 重启后清空；断线期间如果缓冲区已淘汰旧记录，页面会提示。

在「扩展 → 已安装扩展」添加 QQ 官方机器人，填写 QQ 开放平台的 AppID 和 AppSecret，保存后启用。连接状态显示在扩展页面；账号需要获得 QQ 平台的私聊及群聊机器人相应权限。向机器人发送私聊文本或在群中 @ 机器人后，扩展将消息交给当前模型，并使用原消息 ID 被动回复。模型调用可能产生费用，回复不包含对话历史。

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

- 可将根目录 `.env.example` 复制为 `.env` 设置 Core 的监听地址；进程环境变量优先于文件。不要提交真实 `.env`。
- 普通设置可写入项目根目录的 `config.toml`（可参考 `config.example.toml`）；文件不存在时使用内置默认值，不会自动创建。监听设置优先级为进程环境变量 > 根 `.env` > `config.toml` > 内置默认值。
- 产品名称固定为 Stardust；旧配置中的 `service.name` 读取时会被忽略，下次保存配置时移除。服务描述和 WebUI 标题仍可配置。
- 程序内部可使用 `loadConfig()` 读取配置、`resolveConfig()` 合并环境变量，以及 `saveConfig()` 校验并保存配置。保存使用同目录临时文件替换原文件，不保留手写 TOML 注释；`server.host` 和 `server.port` 修改后需重启生效。仅支持已定义的普通配置字段，密钥、Token 等敏感信息应保存在 `.env` 中。
- 模型普通配置保存在 `config.toml` 的 `[model]` 表；API Key 单独保存在根目录 `.env` 的 `STARDUST_MODEL_API_KEY` 中，进程环境变量优先。页面留空密钥会保留文件中已有的值，勾选清除会移除文件中的值；进程变量存在时页面会提示覆盖。保存两份文件并非跨文件事务，若第二步失败，界面会报告部分修改可能已保存，需重新加载核对。
- 模型地址支持 HTTPS 和仅限本机的 HTTP；不跟随上游重定向。可在模型设置中选择流式上游请求（默认关闭），服务端收齐回复后显示；连接测试使用同一模式。对话不包含历史消息。服务默认仅绑定本机，没有认证，不应开放到不可信网络。
- `SetupService` 为 CLI、WebUI 和初始化 API 提供同一份状态。缺少文件或 `initialized` 字段时视为未初始化；服务启动不会自动初始化。普通设置保存不能更改初始化状态。
- 扩展配置位于可选的 `env/<extension-id>/.env`，各扩展独立读取；目录或文件缺失时视为未配置，读取时不会创建它们。扩展 ID 使用小写字母、数字及连接符。
- 扩展包通过 Manifest 声明配置字段。安装状态和启用状态保存在 `data/extensions.json`，保存配置时才创建扩展目录；禁用保留配置，卸载时可选择删除或保留。项目只加载随项目提供并已安装的可信扩展。
- QQ 扩展的 AppID 和 AppSecret 分别保存在 `env/qq-bot/.env`，敏感字段不会回传浏览器。QQ 扩展仅处理私聊文本和群聊 @文本，过滤重复事件、近期回复的回声及平台标记为机器人的发送者；处理队列最多 20 条，串行处理，每个会话每分钟最多接收 5 条。SDK 对部分事件不提供可靠的发送者机器人标记，无法完全识别所有其他机器人。消息由现有模型服务处理，尚无 Agent Runtime。
- 提供 `GET /api/health` 以及首次初始化用的状态和提交接口；页面没有伪造 Agent、记忆和模型数据。

## 目录

```text
apps/server/src/    TypeScript HTTP Server 和健康检查接口
apps/server/src/extensions/  随项目提供的渠道扩展
apps/web/src/       TypeScript 前端、CSS 和 HTML
scripts/            构建辅助脚本
tests/              HTTP 行为测试
```

## 后续路线（未实现）

长期记忆、多 Agent、扩展沙盒及工具系统尚未实现。

Git 的 `add / commit / push` 由项目拥有者自行执行。

