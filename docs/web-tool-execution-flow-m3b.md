# Web Tool 执行图 M3-B

以进程环境变量 `STARDUST_WEB_TOOL_EXECUTION_FLOW=1` 启用，默认关闭。启用时同时启用 M3-A 可用性过滤；服务端测试或装配可通过 `AppOptions.toolExecutionFlow` 提供可信图。流程定义不来自浏览器。

`builtInWebToolExecutionFlow()` 的根图调用 Tool 组，组接口为输入「模型调用」与输出「返回模型」。组内依次为 `validate-stage`、`permission-stage`、`approval-stage`、`executor-stage` 和 `result-stage`；每个端口均为必需字符串。阶段值只表示允许到达下一阶段，不是参数校验结果、权限或批准凭证。Core 同时要求这些固定节点及连接完整，防止使用其他节点伪造阶段值或旁路审批。断线会给模型返回 `TOOL_EXECUTION_FLOW_INVALID`，不会执行 Tool。

每个模型 Tool Call 首先执行一次有界的路径检查，之后 ToolRuns 照常解析、验证参数、检查 M3-A 集合和当前权限。`search_history` 无需人工批准：原有限额和延迟后再次运行图，由 executor 节点调用现有受限检索；检索函数仍做参数和作用域校验。扩展 Tool 按原有 `validate`、`prepare` 和信号检查进入现有待审批状态；图不创建或决定审批。

批准时 ToolRuns 先以同步状态转换消费待审批记录，阻止并发重复决定，再次运行同一调用的图快照。executor 回调重新检查取消、权限、Tool 和渠道信号、截止时间，再调用 `ExtensionManager.executeTool`。拒绝或失效不会进入执行器。执行已开始但随后异常时返回 `unknown_outcome`，不自动重试。结果仍按原 ToolResult 路径返回模型。调用过程中图快照保持不变；下一次调用读取服务端新定义。

该设计不是持久工作流：审批仍仅驻内存，重启不恢复。普通图节点不会等待人工审批；取消是协作式的，已发出的副作用可能结果未知。M1 通用执行器默认不允许自行注册的副作用节点；本适配器的受信 executor 回调只能通过 Core 的实际调用路径获得。参数及权限检查和强制审批属于 ToolRuns/Core，不由图阶段字符串替代。只读 Tool 的审批阶段不等待人工确认。
