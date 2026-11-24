# 部署调查（U0）

本文记录仓库事实和只读调查方法，不是安装或迁移步骤。用户报告的目标环境为 Proxmox LXC 100、Debian 13.6 x86_64、Node 24.22.1、npm 11.19.1、Git 2.47.3，尚无已发现的 Stardust systemd 服务；实际安装路径、服务用户和监听地址仍待部署时确认。

当前 `npm start` 执行 `node --experimental-sqlite apps/server/dist/main.js`，Node 要求至少 22.12；构建依次使用 `npm ci`、`npm run check`、`npm run build`、`npm test`，其中 test 已再次执行 build。构建产物为 `apps/server/dist`、`apps/web/dist`，运行时仍需要根目录及 node_modules，不能只复制单个 JS 文件。

代码和静态资源从 Application Root 加载；默认 Storage Root 与 Application Root 相同。启动进程时可设置 `STARDUST_STORAGE_ROOT` 为已存在、可读写的绝对真实目录，例如 `/opt/stardust/shared`；其值在启动时确定，不从 `.env` 读取，也不会在工作目录变化时改变。非法、缺失、不可写或自身为符号链接的目标会报错，不回退到应用目录。全新部署须先由管理员创建目录并赋予服务用户权限。

Storage Root 下的 `config.toml`、`.env`、`env/` 和整个 `data/` 都需保留；后者包括 conversations.sqlite、SQLite WAL/SHM、extensions.json 和 flow-publication.json（服务端流程草稿及发布版本）。浏览器本地流程画板草稿仍由浏览器存储管理。Web 和 CLI 初始化使用同一 Storage Root；服务默认会在需要时创建 data 等子目录。扩展的 `env/`、各扩展目录及凭据文件仍不能是符号链接，扩展 ID 的路径限制不变。`current` 可以指向应用 release；Storage Root 应为独立真实目录，不需要将 `env/` 链接到 release。示例路径仅展示契约，尚不是安装命令。

数据库在 ConversationService 初始化时增量迁移；服务关闭会触发 HTTP 关闭、扩展停止及上下文和工具资源清理，但不保证所有在途任务已排空。Global Context 启动时会恢复中断的综合任务。`GET /api/health` 只提供通用状态、包版本和时间，不证明数据库就绪，也不包含 commit SHA。

## 服务器只读调查

由管理员自行 SSH，先确认实际名称和目录；以下变量必须替换成已经核实的值，示例并非迁移命令：

```sh
systemctl list-units --type=service --all | grep -i stardust
systemctl list-unit-files --type=service | grep -i stardust
systemctl show '实际服务名.service' -p Id -p User -p Group -p WorkingDirectory -p FragmentPath -p ActiveState -p SubState
systemctl cat '实际服务名.service'
node --version
npm --version
git --version
df -h
```

`systemctl cat` 可能包含环境变量、凭据或私有路径；分享输出前先检查并删除秘密。查明部署目录后，可运行该仓库提供的只读脚本：

```sh
node scripts/updater/inspect.mjs /已确认的绝对部署路径 实际服务名.service
```

它只报告文件类型、Node 版本及指定 systemd 服务的部分属性，不读取配置或数据库内容，也不启动、停止或修改服务。请同时提供不含凭据的启动方式、Git 工作区是否有未提交修改、服务使用的 Node 版本，以及备份和恢复职责。切勿公开 `.env`、Token、数据库内容或 QQ 凭据。

可单独执行 `node scripts/updater/check.mjs` 只读检查公开仓库 main 的远程提交；可选参数为分支和已知的完整当前 SHA。该工具禁止交互式 Git 凭据，不下载源码、不写更新状态，也不会执行部署。远程 SHA 只是一份检查结果，尚不是持久化的部署计划。

## 候选版本准备（U1-B）

独立入口 `scripts/updater/prepare.mjs` 只准备候选版本，不访问生产数据库、不修改 current、不控制服务。部署根目录必须是已存在的绝对真实目录，且构建进程不得以 root 运行。命令示例中的目录须由管理员先核实并授权：

```sh
node scripts/updater/prepare.mjs /已确认的部署根目录 main
# 可选：第三个参数为当前分支头的完整 40 位 SHA，第四个参数为单阶段超时毫秒数
node scripts/updater/prepare.mjs /已确认的部署根目录 main 40位完整SHA 900000
```

来源固定为 `https://github.com/SanwangNet/Stardust.git`；分支经过校验，若指定 SHA，必须等于检查时的分支头。固定目标后在 `releases/.staging/` 的独立目录执行 Git 初始化、按 SHA 获取、检出和校验；执行 `npm ci`、`npm run check`、`npm run build`，再以 `node --experimental-sqlite --test --test-concurrency=2` 运行全部 `tests/*.test.mjs`。这与当前 `npm test` 的构建及测试内容等价，同时限制测试并发。最后复核提交、已跟踪源码状态及服务器、扩展、Worker、Web 和依赖产物。

候选版本如果修改了 `npm test` 脚本，准备流程会拒绝继续，等待更新器适配，避免漏跑新增检查。

构建子进程只获得有限的系统环境、独立 HOME 和临时 `STARDUST_STORAGE_ROOT`，不会继承生产密钥或指向生产 shared；候选目录也不允许包含根目录的配置、env 或 data。环境清理不是沙箱：npm 生命周期脚本和仓库代码仍有构建用户的操作系统权限，因此必须使用非 root 用户，并确保该用户不能读取生产秘密。子进程输出不写入日志，阶段结果和超时会报告；每阶段默认超时 15 分钟。

全部成功后在同一文件系统发布 `releases/<SHA>`，写入 `.stardust-candidate.json`，记录来源、分支、SHA、时间、版本、阶段和产物；它仅表示已准备，不表示已部署。已存在目录会检查元数据、Git HEAD、源码状态及必要文件；未知或损坏目录拒绝覆盖。失败只清理本次创建的临时目录，不自动删除历史版本。每个 SHA 使用独立准备占位目录阻止并发；进程被强制终止可能留下 `.staging/<SHA>.lock`，管理员应先确认没有更新进程再人工处理。该占位不替代 U1-C 的部署锁或崩溃恢复。Linux 发布使用 GNU mv 的 no-clobber；其他平台没有经过生产验收。

## 尚未实现的部分

当前没有服务切换、systemd timer、自动备份或部署恢复流程。U1-C 仍需实现可靠的 SQLite 一致性备份、固定 commit 的就绪验证、最小权限的 systemd 控制，以及数据库可能迁移后的保守恢复。服务用户必须能够执行实际 Node 路径并访问应用与存储目录，不能假定 root 的 PATH 适用。生产服务器完成预检和实际验收之前，不应启用自动部署，也不应根据本文执行覆盖或回滚操作。
