# Web Tool 可用性图 M3-A

进程环境变量 `STARDUST_WEB_TOOL_FLOW=1` 启用，默认关闭。定义位于 `builtInWebToolFlow()`；服务端装配也可通过 `AppOptions.toolAvailabilityFlow` 注入可信定义。没有 HTTP 或画板配置入口。修改图后需重新构建并重启。

根图输入进入「Tool 可用性」子图，接口元数据分别标记「模型请求准备」和「提供给模型」。`registered-search` 输出现有 `searchTool.function` 定义；`registered-extensions` 输出 ExtensionManager 当前已安装、启用且连接的 Tool 定义；`tool-filter` 对已连接的可选来源求并集并按 Core 当前策略过滤；`tool-output` 输出 Tool 定义集合，并非 ToolResult。移除 `search.value → filter.search` 后，执行计划跳过 search 节点。扩展 Tool 目前作为一个整体来源，未提供逐个 Tool 的图节点。

图输出仅用于生成当前请求的候选名称快照。实际模型定义始终来自现有可信注册项，ToolRuns 在构造每次模型请求、分发调用和处理审批时继续执行既有检查；当前 Agent、Web 渠道或扩展状态撤销时仍会拒绝。未注册类型会校验失败；图无法通过节点名称、端口、配置或定义提供新的 Tool 能力。search_history 仍只在模型主动调用时检索，原有范围、参数、次数和返回结果处理不变。

图校验失败、执行失败或取消时，Web 请求返回明确错误，不启动 Tool Run，不回退旧路径。图关闭时保持旧路径。已启动的 Tool Run 生命周期沿用当前实现。

M3-B 可以复用此次候选集合、实时权限检查、Tool 注册表和节点组接口元数据，但候选集合不是授权凭证。需要副作用的 Tool 仍须经过 Core 的参数验证、权限与审批；删除图中的审批节点不构成批准，也不能放行执行。M3-A 不改变 send_message 的执行或审批，也不提供 Skill Runtime、第三方星核执行或流程发布。
