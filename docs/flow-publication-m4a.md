# 可视化流程发布 M4-A

设置 `STARDUST_FLOW_EDITOR=1` 开启本机开发编辑器；还需设置至少 32 字符的 `STARDUST_ADMIN_TOKEN` 并在 Web 管理入口登录。编辑 API 同时要求回环地址、回环 Host、有效管理员会话与同源写入。编辑器不是面向公网的发布管理功能；当前其余管理接口也并未统一认证，正式对外部署前仍须完成认证与代理安全设计。

`STARDUST_WEB_CONTEXT_FLOW=1` 使发布的近期/全局连线控制 Web 上下文；`STARDUST_WEB_TOOL_FLOW=1` 使发布的 search_history 连线控制 Tool 可用性。`STARDUST_WEB_TOOL_EXECUTION_FLOW=1` 也会启用 Tool 可用性图，并保留现有调用审批图。未启用的部分会在画板显示“已保存但未生效”。M4-A 不修改审批执行图。

服务端只接受 `{recent, global, search}` 三个布尔字段，不接受浏览器提交节点、类型、端口、布局或执行代码。服务端将这些选择应用到内置可信图，读取 API 同时返回真实图供显示；画板的布局、缩放和展示节点不是执行契约。可编辑线只有近期→组装器、全局→组装器、search_history→过滤器；其他连线只读。点击可编辑线断开，从标记的输出端口拖到对应输入端口重连。移动节点不影响流程。

草稿保存与发布分开，保存只改变草稿；校验运行 M1/M2/M3-A 现有校验及模拟纯数据组装，发布时再次校验。每次操作携带服务端 revision，过期 revision 返回 409。发布保存独立版本 ID 和上一版本；恢复默认会创建草稿，仍须发布。一个 JSON 文件以同目录临时文件替换，重启时读取已发布状态；目前假设单 Server 写入，跨进程并发写入锁和多用户协作不在范围内。

Web 请求开始时读取一次已发布状态并构造私有图快照。进行中的请求使用该快照，新发布仅影响之后的请求。图错误不回退旧图；原有 Tool 权限、审批和作用域检查继续执行。历史检索 Tool 在启用时仍由模型自主选择，后台摘要综合不受全局上下文输入连线控制。

测试：`npm test` 含服务端版本与 Mock Web 请求测试；Windows Chrome 可执行 `node --experimental-sqlite tests/flow-browser-check.mjs` 验证本地无界面浏览器交互，必要时用 `STARDUST_TEST_CHROME` 指定浏览器路径。
