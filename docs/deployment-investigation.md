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

以下记录 U1-B 原有的准备流程；当前 CLI 已接入下文的受监督 staging 构建，不再直接发布候选。

独立入口 `scripts/updater/prepare.mjs` 只准备候选版本，不访问生产数据库、不修改 current、不控制服务。部署根目录必须是已存在的绝对真实目录，且构建进程不得以 root 运行。命令示例中的目录须由管理员先核实并授权：

```sh
node scripts/updater/prepare.mjs /已确认的部署根目录 main
# 可选：第三个参数为当前分支头的完整 40 位 SHA，第四个参数为单阶段超时毫秒数
node scripts/updater/prepare.mjs /已确认的部署根目录 main 40位完整SHA 900000
```

来源固定为 `https://github.com/SanwangNet/Stardust.git`；分支经过校验，若指定 SHA，必须等于检查时的分支头。固定目标后在 `releases/.staging/` 的独立目录执行 Git 初始化、按 SHA 获取、检出和校验；执行 `npm ci`、`npm run check`、`npm run build`，再以 `node --experimental-sqlite --test --test-concurrency=2` 运行全部 `tests/*.test.mjs`。这与当前 `npm test` 的构建及测试内容等价，同时限制测试并发。最后复核提交、已跟踪源码状态及服务器、扩展、Worker、Web 和依赖产物。

候选版本如果修改了 `npm test` 脚本，准备流程会拒绝继续，等待更新器适配，避免漏跑新增检查。

构建子进程只获得有限的系统环境、独立 HOME 和临时 `STARDUST_STORAGE_ROOT`，不会继承生产密钥或指向生产 shared；候选目录也不允许包含根目录的配置、env 或 data。环境清理不是沙箱：npm 生命周期脚本和仓库代码仍有构建用户的操作系统权限，因此必须使用非 root 用户，并确保该用户不能读取生产秘密。命令失败时的有界任务诊断见下文；每阶段默认超时 15 分钟。

全部成功后在同一文件系统发布 `releases/<SHA>`，写入 `.stardust-candidate.json`，记录来源、分支、SHA、时间、版本、阶段和产物；它仅表示已准备，不表示已部署。已存在目录会检查元数据、Git HEAD、源码状态及必要文件；未知或损坏目录拒绝覆盖。失败只清理本次创建的临时目录，不自动删除历史版本。每个 SHA 使用独立准备占位目录阻止并发；进程被强制终止可能留下 `.staging/<SHA>.lock`，管理员应先确认没有更新进程再人工处理。该占位不替代 U1-C 的部署锁或崩溃恢复。Linux 发布使用 GNU mv 的 no-clobber；其他平台没有经过生产验收。

## U1-C 实验性状态基础（未完成）

本节描述尚未通过生产验收的实现。统一入口在受信任配置、权限检查和主动监督探测均通过时，通过 systemd 启动真实非 root 构建；条件不足返回 `SUPERVISION_UNAVAILABLE`（退出码 24）。`prepare.mjs` CLI 转入同一入口。普通进程组不能证明所有 npm 后代进程已经退出，不能以锁释放或父进程退出作为清理、复用目录的证据。不要启用 timer，也不要在生产环境使用该实验性实现。

`node scripts/updater/status.mjs /已确认的部署根目录` 输出 JSON，并只读观察状态、锁、`current` 和运行版本；运行版本目前始终为 `unknown`。`node scripts/updater/update.mjs /已确认的部署根目录 main` 是实验性统一入口，额外参数 `--force` 只跳过退避，不能跳过锁或安全检查。执行入口要求 Linux `flock`，Windows 没有生产锁实现。部署根和 `updater` 必须是真实目录，Linux 下后者由协调用户持有且不允许组及其他用户访问；锁文件必须是该用户持有的私有普通文件，锁文件存在不表示锁被持有。锁作用域为单个部署根，更新器尝试以非阻塞方式取得锁，正常释放时不删除锁文件。目标环境已验证强杀后锁释放，直接 prepare CLI 遇到锁竞争时的行为仍待修复后复验。

状态位于 `updater/state.json`，版本为 1，包含任务 ID、阶段、触发方式、时间、远程和固定目标 SHA、已准备 SHA、失败信息以及分别针对远程检查和目标 SHA 的退避。`current` 是独立只读观察，不能据此判断生产进程版本。状态文件先写同目录私有临时文件并同步，再原子替换，Linux 再同步目录；内容损坏或版本未知不会自动重置。状态为 `CHECKING`、`PREPARING`、`VERIFYING` 时再次取得锁会记录 `INTERRUPTED` 并阻断后续任务，不自动删除临时目录、占位或恢复成功。管理员必须先确认所有原任务及后代已停止，再检查相关目录归属；当前没有自动解除中断状态的管理命令，不应手工随意删除文件。

远程检查失败和候选失败分别计数，退避为 60、120、300、600、1800 秒封顶；新 SHA 可以清除旧 SHA 的构建失败计数，但不会绕过远程检查退避。退出码为 0（`STAGED_NOT_PUBLISHED`，测试路径也可报告准备或复用）、10（退避）、11（锁忙）、20（检查失败）、21（构建失败）、22（状态或其他错误）、23（需人工处理的中断）、24（监督条件不足）。故障详细信息有意限制为错误代码，不记录子进程输出或完整环境。

后续实现需要一个能可靠界定和等待整个构建进程树的 Linux 监督边界，并在强杀协调进程、后代继续写入、服务重启和发布后未保存状态等场景下做真实多进程测试；仅有 `flock` 或 PID 检查不够。协调用户、非 root 构建用户和 Core 服务用户的具体权限尚待部署设计；构建用户不应读取生产 `shared`，不能以 root 运行 npm 生命周期脚本，也不能依赖 Core 服务运行。不得将该入口暴露给普通 Web、模型或 QQ 请求。

## U1-C-Fix：systemd 能力与待完成的集成

用户报告，已在目标 Debian 13.6 LXC 完成以下基础测试：PID 1 为 systemd，systemd 版本为 `257.13-1~deb13u1`，使用 cgroup v2（`cgroup2fs`），`systemd-run` 和 `flock` 分别为 `/usr/bin/systemd-run` 和 `/usr/bin/flock`。未为这些测试修改 PVE 宿主机配置，也未改用特权容器。

1. 以 `User=nobody`、`Type=exec`、`ExitType=cgroup`、`KillMode=control-group`、`RuntimeMaxSec=15s` 运行 `/usr/bin/true`：服务结果 `success`，运行约 37ms。
2. 相同服务属性下，运行 `setsid /bin/sleep 5 & exit 0`：主进程成功退出后，服务约 5.029 秒才成功结束，实测等待约 5.063 秒。
3. 设置 `RuntimeMaxSec=5s`、`TimeoutStopSec=2s`、`SendSIGKILL=yes`，运行 `setsid /bin/sleep 120 & exit 0`：服务结果为 `timeout`，运行约 5.210 秒，实测等待约 5.243 秒；主进程退出码仍为 0。

这些由用户提供的结果证明目标环境具备所测的基础能力，不证明 Updater 的锁竞争、任务关联、cgroup 排空、进程遗留保护或候选发布已通过验收。特别是测试三说明以后必须核验 systemd 的完整服务结果，而不能以 Worker 主进程退出码为成功依据。后续首次真实 Worker 构建的结果见下文，尚未通过。

预检只做环境调查或独立的监督探测。Coordinator 现已接入 systemd Build Worker；公开的 `prepareCandidate()` 仍直接拒绝执行，不能绕过监督限制。真实 Worker 复用 Git、npm 和验证步骤，只构建 staging，不运行旧的发布代码；Windows 内部测试的 npm 和远程仓库仍使用适配器。

`scripts/updater/systemd-evidence.mjs` 的证据判定已接入 Coordinator：从部署根和任务 ID 派生 unit 名，并要求 boot ID、invocation ID、unit、固定 slice 下的 cgroup、服务最终结果和 cgroup 排空证据相互匹配。`Result=timeout` 即使伴随主进程退出码 0 也不能判为成功；unit 被回收、结果缺失或身份不明则为不确定。证据本身不授权发布，现阶段判定测试为合成输入。

默认预检是只读的，不创建 unit、不访问数据库：

```sh
node scripts/updater/preflight.mjs /已确认的绝对部署根目录 构建测试用户 Core测试用户
```

提供 `--active` 才会主动创建测试 unit；应由具备管理测试 unit 权限的管理员在隔离的测试环境运行，并提供两个不同的非 root 测试用户：

```sh
node scripts/updater/preflight.mjs /已确认的绝对测试根目录 构建测试用户 Core测试用户 --active
```

主动探测只运行内嵌的测试程序，不运行候选代码。它使用随机 unit 名称和测试临时目录，指定 `system.slice` 并禁用命令参数的环境变量展开，请求 `Type=exec`、`ExitType=cgroup`、`KillMode=control-group`、`RuntimeMaxSec=25`、`TimeoutStopSec=3`、`SendSIGKILL=yes`、`Delegate=no`、`Restart=no`、`NoNewPrivileges=yes`、`ProtectControlGroups=yes`、空 `CapabilityBoundingSet` 及指定非 root `User`。探测要求观察到主进程退出后已调用 `setsid` 的测试后代仍写入、cgroup 为 populated，并在停止同一 invocation 后观察 cgroup 排空或消失。若无法确认归属或终止，保留测试目录并报告；不能因客户端返回而断言整个服务结束。探测不是系统超时、协调器强杀、发布安全或生产访问权限的完整测试。

预检输出的 `builderAccessToSecrets: unknown` 和 `permissionBoundary: not_verified` 是有意的：目录所有权和模式不能证明 ACL、补充组或其他访问路径安全。单独预检不能授予构建权限，`productionBuild` 为 `coordinator_checks_required`，CLI 固定返回 24；Coordinator 还要验证可信安装、用户和目录权限。Windows 返回不支持；不会以模拟结果替代 Linux 测试。

在真实 Linux systemd 测试机上，下面的命令执行当前已提供的专项测试。主动部分会创建并停止自己的随机测试 unit；两个账号必须提前由管理员准备，不能使用生产用户：

```sh
RUN_STARDUST_SYSTEMD_TESTS=1 \
STARDUST_TEST_BUILD_USER=构建测试用户 \
STARDUST_TEST_CORE_USER=Core测试用户 \
node --test tests/updater-systemd-linux.test.mjs
```

默认测试含真实独立进程 flock 竞争、不同根目录、直接 prepare CLI 与 SIGKILL 后释放；显式启用后增加 setsid 后代的 systemd 实测。真实 Worker、协调器强杀、真实 npm 构建与发布边界仍需 Linux 实测。无法确认时必须保留现场；不能根据状态文件中的任意 unit 名停止系统服务。完成这些验证和安全发布后，才能评估进入 U1-D。

## U1-C-Fix-2：隔离 Debian 验收

以下是供管理员在独立测试根目录执行的验收命令，不连接或修改未来生产部署。真实 Worker 构建尚未通过 Linux 验收；不要根据 Windows 测试推断真实构建已通过。Coordinator 必须以 root 运行以管理系统 unit，构建 unit 使用独立、无登录、非 root 构建用户；Core 测试用户也须为不同的非 root 用户。构建用户不得具有 sudo、systemd 管理或生产 `shared` 访问权限，且启动前不得已有该 UID 的其他进程。环境检查不能替代管理员核查全部 ACL、账号及宿主策略。

用户随后在 Debian 13.6 LXC、Node.js v24.22.1 上报告：主动预检为 `passed`，观察到脱离进程组的后代且 cgroup 排空，Worker UID 为 997，构建用户与 Core 用户不同；独立预检返回 24，符合契约。该轮 Linux 专项测试为 3 通过、1 失败、1 跳过：只读预检、强杀后内核锁释放和 systemd 后代监督通过；直接 prepare CLI 参与锁竞争的测试因 ESM 循环依赖中的顶层 await 未完成而退出 13，未达到预期的 `LOCK_BUSY`、退出码 11。共享准备逻辑与 CLI 入口随后已分离，并保留该 Linux 测试及退出码断言；用户报告的后续复验结果见下文。

用户进一步报告：在 commit `b6b934f7416cffa0d971671e45c7a2b2246c02ab` 上，ESM 修复已在 Debian 复验，Linux 专项测试 4 通过、1 个 Windows 专属测试跳过、0 失败；真实 flock、直接 prepare CLI 互斥、强杀后锁释放和脱离进程组后代监督通过。首次真实受监督构建执行到测试阶段后以 `PREPARE_FAILED`（21）、`TEST`、`UNIT_FAILED` 结束；systemd `Result=exit-code`，主进程状态 1，cgroup 为空。约耗时 178 秒，内存峰值约 408.2 MiB；锁释放、退避持久化，未切换 current 或发布候选。

用户在原 staging 以相同非 root 用户及近似隔离条件复跑测试，报告 390 项中 385 通过、3 失败、2 跳过，约 111.4 秒，内存峰值约 295.4 MiB、Swap 为 0。其中 `env.test.mjs` 的默认根目录断言与继承的 `STARDUST_STORAGE_ROOT` 直接冲突；另外两个临时应用启动测试也继承了该路径，其启动超时和提前退出是否完全由此导致，仍需修复后在 Debian 复验。测试现显式隔离临时应用的存储环境，并在独立进程验证默认和显式路径；初始化与扩展 HTTP 测试也各自使用临时扩展数据及会话数据库，避免多个夹具写入共同的默认根。没有改变 Worker 的临时 Storage Root 或 Core 路径契约。此次修复尚未经过 Debian 真实构建复验。

Coordinator 首先检查 root 拥有且仅 root 可读写的 `updater/config.json`、root 拥有且不可由组或其他用户修改的独立 updater 代码路径及系统可执行文件，然后运行主动 systemd 探测。启动前先保存状态和 `updater/intent.json`，后者记录任务 ID、目标 SHA、由任务派生的 unit、boot ID、staging 相对标识和随后取得的 invocation ID。Worker 的 unit 请求 `Type=exec`、`ExitType=cgroup`、`KillMode=control-group`、`RuntimeMaxSec=5400`、`TimeoutStopSec=10`、`SendSIGKILL=yes`、`Delegate=no`、`Restart=no`、`NoNewPrivileges=yes`、`ProtectControlGroups=yes`、`ProtectHome=yes`、`PrivateTmp=yes`、空能力集，对 `releases` 设为只读并屏蔽 systemd 管理 socket、用户运行目录和已知 shared。Worker 还检查自己的实际 cgroup。根目录应位于 `/srv` 或 `/opt` 等不会被 `PrivateTmp` 或 `ProtectHome` 隐藏的真实目录。

Worker 只在 `build-work/<任务ID>` 写入源码、独立 HOME、临时 Storage Root、进度和结果；不写 updater 状态、不修改 `current`、不发布正式候选。Coordinator 等待 unit 的完整结果，验证 invocation、boot ID 和 cgroup 排空，再检查结果标记及产物。该检查不冻结构建用户拥有的 staging，不能作为正式发布凭据；成功只记录 `STAGED_NOT_PUBLISHED`，不进入 READY，也不表示部署。所有 staging 和 unit 保留供审计；不自动清理。若启动结果不明、协调器退出、锁丢失、unit 被回收或证据不完整，下次获取锁后阻断并要求人工处理，不自动停止未知 unit。

以 root 在已审阅的本仓库根目录执行下列示例。示例用户是**专门的测试账号**，应先确认名称未被占用且不是生产账号；`useradd` 仅用于隔离验收，不是生产安装步骤。下面的变量只在该 shell 内有效：

```sh
SRC="$(pwd -P)"
BUILD_USER=stardust-build-test
CORE_USER=stardust-core-test
test -f "$SRC/scripts/updater/build-worker.mjs"
# 如账号不存在，由管理员创建并确认无特权组或其他权限：
useradd --system --user-group --no-create-home --shell /usr/sbin/nologin "$BUILD_USER"
useradd --system --user-group --no-create-home --shell /usr/sbin/nologin "$CORE_USER"
id "$BUILD_USER"
id "$CORE_USER"
command -v node npm git systemd-run flock runuser
node -p 'process.execPath'
node --version
npm --version
git --version

TEST_ROOT="$(mktemp -d /srv/stardust-u1c-test.XXXXXX)"
CODE="$(mktemp -d /usr/local/lib/stardust-updater-test.XXXXXX)"
chmod 0755 "$TEST_ROOT" "$CODE"
install -d -m 0700 "$TEST_ROOT/updater"
install -m 0644 "$SRC"/scripts/updater/*.mjs "$CODE/"
printf '{"buildUser":"%s","coreUser":"%s"}\n' "$BUILD_USER" "$CORE_USER" > "$TEST_ROOT/updater/config.json"
chmod 0600 "$TEST_ROOT/updater/config.json"
printf '测试根：%s\n可信代码：%s\n' "$TEST_ROOT" "$CODE"
```

确保 Node、npm、Git 和 updater 文件及其父目录由 root 管理，构建用户可读取和执行所需路径。不要使用位于 `/root` 的 Node 安装。测试不需要 QQ 凭据、模型密钥或生产数据库。以下主动预检命令的退出码仍为 24；需要查看 JSON 的 `active.result` 是否为 `passed`，并检查其余条件：

```sh
node "$CODE/preflight.mjs" "$TEST_ROOT" "$BUILD_USER" "$CORE_USER" --active
RUN_STARDUST_SYSTEMD_TESTS=1 STARDUST_TEST_BUILD_USER="$BUILD_USER" STARDUST_TEST_CORE_USER="$CORE_USER" \
  node --test "$SRC/tests/updater-systemd-linux.test.mjs"
node "$CODE/update.mjs" "$TEST_ROOT" main
node "$CODE/status.mjs" "$TEST_ROOT"
```

最后一条更新命令实际访问固定 GitHub 仓库，执行 npm ci、类型检查、构建与测试；首次验收应预留网络、磁盘和时间。如果条件检查失败会返回 24；创建 unit 后结果无法可靠确认会返回 23 并保留现场。查看状态和该次 unit 的日志：

```sh
cat "$TEST_ROOT/updater/intent.json"
UNIT="$(node -p "JSON.parse(require('node:fs').readFileSync(process.argv[1],'utf8')).unit" "$TEST_ROOT/updater/intent.json")"
systemctl show "$UNIT" -p Id -p InvocationID -p ActiveState -p SubState -p Result -p ControlGroup -p ExecMainCode -p ExecMainStatus
journalctl --no-pager -u "$UNIT" -n 100
cat /proc/sys/kernel/random/boot_id
```

Worker 捕获到命令失败时，会尽力在 `build-work/<任务ID>/failure.json` 写入单个诊断文件，包含阶段、失败原因、退出码或信号及标准输出和标准错误尾部。每个流最多保留最后 16 KiB 的原始输入并输出末尾 4096 个字符，超过时标记 `truncated`；另外有最多 2048 个字符的失败标题、断言或测试摘要行，避免长堆栈挤掉这些线索。整个任务只有一个该诊断文件，最大 64 KiB。默认不向 journal 输出原始子进程内容，Coordinator 不读取该文件，也不会把其内容写入可信状态。标记为密钥、令牌、密码的常见字段、认证头、部分 URL 凭据及敏感环境变量值会尽力遮盖，但不能保证识别所有秘密；对外分享前仍须人工检查。

确认该任务归属后，可用构建用户读取固定路径，避免以高权限跟随不可信链接。下例校验任务 ID、文件归属、类型、链接数和长度，使用 `O_NOFOLLOW`，并将 JSON 重新编码后输出；`TEST_ROOT` 和 `BUILD_USER` 须仍为上面的测试变量：

```sh
TASK_ID="$(node -p "JSON.parse(require('node:fs').readFileSync(process.argv[1],'utf8')).taskId" "$TEST_ROOT/updater/intent.json")"
printf '%s\n' "$TASK_ID" | grep -Eq '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' || { echo '任务 ID 无效'; exit 1; }
runuser -u "$BUILD_USER" -- node -e 'const fs=require("node:fs");const f=fs.openSync(process.argv[1],fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const s=fs.fstatSync(f);if(!s.isFile()||s.uid!==process.getuid()||s.nlink!==1||s.size>65536)throw Error("unsafe diagnostic");const b=Buffer.alloc(65537);const n=fs.readSync(f,b,0,b.length,0);if(n>65536)throw Error("diagnostic too large");console.log(JSON.stringify(JSON.parse(b.subarray(0,n).toString("utf8")),null,2).replace(/[\u202a-\u202e\u2066-\u2069]/g,""))}finally{fs.closeSync(f)}' "$TEST_ROOT/build-work/$TASK_ID/failure.json"
```

诊断为不可信的构建用户输出，只供排查，不作为候选成功依据。该文件在命令错误被 Worker 捕获后生成；如 Worker 被 SIGKILL、OOM 直接终止、日志路径遭占用或发生写入错误，文件可能不存在，此时仍需查看 unit 状态及 journal。旧版本 Worker 的历史 staging 不会自动补出诊断文件。

清理前，管理员须将 intent 中的 boot ID、invocation ID 和派生的 unit 身份与 `systemctl show` 对照，确认测试 unit 已结束且其 cgroup 已排空或销毁，并确认没有遗留写入者。对于身份不明或仍在运行的任务，保留目录，不要照搬清理命令。确认后才停止该**已核实的测试 unit**并移除该次创建的测试目录和可信代码副本；如有失败的 probe，也要先按其报告的随机 unit 和目录核对。不要删除或覆盖未知目录，也不要删除已有账号。以下命令依赖上述核验，并要求原 shell 中的变量仍指向本次创建的路径：

```sh
case "$TEST_ROOT" in /srv/stardust-u1c-test.*) ;; *) echo '测试根不匹配'; return 1 2>/dev/null || exit 1;; esac
case "$CODE" in /usr/local/lib/stardust-updater-test.*) ;; *) echo '代码目录不匹配'; return 1 2>/dev/null || exit 1;; esac
systemctl stop "$UNIT"
rm -rf --one-file-system -- "$TEST_ROOT" "$CODE"
```

真实 Linux 验收和受控正式发布完成前，不应进入 U1-D 或启用自动更新。

## 尚未实现的部分

当前没有正式候选发布、服务切换、systemd timer、自动备份或部署恢复流程。U1-C 的 systemd Worker 实现尚需 Linux 真实验收；后续阶段还需实现可靠的 SQLite 一致性备份、固定 commit 的就绪验证、最小权限的 systemd 控制，以及数据库可能迁移后的保守恢复。服务用户必须能够执行实际 Node 路径并访问应用与存储目录，不能假定 root 的 PATH 适用。生产服务器完成预检和实际验收之前，不应启用自动部署，也不应根据本文执行覆盖或回滚操作。
