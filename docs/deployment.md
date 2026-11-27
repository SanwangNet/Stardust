# 安装、运行和更新

当前安装与更新功能尚待在 Debian 13 的隔离环境中完整验收。请先在可丢弃的测试容器中按下面的命令验证，不要直接用于已有生产服务。需要 systemd、cgroup v2、Node.js 24、npm、Git、flock、tar、gzip 和 psmisc 提供的 fuser；脚本检查依赖，不自动安装系统软件包。

## 首次安装

从可信仓库取得已经包含本安装脚本的版本，然后执行：

```sh
git clone https://github.com/SanwangNet/Stardust.git
cd Stardust
sudo bash scripts/install.sh
```

脚本创建 `stardust` 服务用户和独立的 `stardust-build` 构建用户，安装独立 updater，并通过 systemd 监督非 root 构建。首次安装从固定 GitHub 仓库的 `main` 获取并固定版本，执行 `npm ci`、`npm run build` 和运行产物检查，再发布、启动并核对健康接口中的运行 SHA。它不会要求输入模型或 QQ 凭据。系统工具和 Node 必须位于 root 管理的可信路径；用户目录中的 Node 安装通常不满足此要求。

若 `/opt/stardust`、相应用户、updater 目录或同名服务已存在，安装会停止并保留现场，不清空已有数据或备份。失败时查看屏幕输出、`sudo cat /opt/stardust/updater/state.json` 和 `sudo journalctl -u stardust.service -e`。构建失败的有界诊断位于 `/opt/stardust/build-work/<任务ID>/failure.json`；日志可能包含敏感信息，只供管理员查看。安装中断后的目录和账号不会自动删除，重新尝试前需要管理员检查。

## 打开和管理服务

全新安装默认监听所有 IPv4 接口的 80 端口，可在可信网络通过 `http://服务器IP/` 打开初始化界面。当前没有统一账号认证，请不要直接暴露到公网；安装器不会修改防火墙。服务以独立的非 root 用户运行，systemd 只为该服务授予 `CAP_NET_BIND_SERVICE`。80 被 Caddy 等服务占用时，必须为其中一个服务选择其他端口。

Web 服务设置只提供端口号，保存写入 `shared/config.toml`，当前进程不换端口、不自动重启；页面同时显示运行端口。重启后新端口生效。进程环境或 shared/.env 中的 `STARDUST_PORT` 优先于保存值；界面会提示覆盖。旧配置的 `server.host` 保留且仍生效，旧端口和环境覆盖也保持原值；没有旧值时才使用新默认值。`STARDUST_HOST` 仍可用于部署或开发覆盖。

Caddy 使用 HTTPS 时保留原始 Host 并设置 `X-Forwarded-Proto`（Caddy 的 reverse_proxy 默认如此），同源校验仍生效；其他只允许本机的管理操作仍受原有限制。shared 目录须由服务用户读写，保存错误会在初始化界面显示。

```sh
sudo systemctl status stardust.service
sudo journalctl -u stardust.service -e
curl http://127.0.0.1:80/api/health  # 根据实际运行端口调整
```

## 已安装实例迁移

先检查当前运行端口、Caddy 端口占用和 `/opt/stardust/shared/config.toml`、`/opt/stardust/shared/.env`。已有明确设置原样保留；若旧实例依赖原先隐含的 8347 默认值而需要继续使用它，请在更新前将 `[server]` 下的 `port = 8347` 写入配置（不要重复创建已有表）。修改配置前先备份。配置原先有 `host = "127.0.0.1"` 时会继续仅监听本机。新默认 80 与 Caddy 冲突时不能同时绑定同一地址和端口。

在包含本次修改的可信源码目录中执行以下命令，安装新版 updater 和 systemd drop-in，然后运行更新器。它不重新安装，也不覆盖 shared。更新器会重启服务：

```sh
sudo install -d -m 0755 /etc/systemd/system/stardust.service.d
printf '[Service]\nAmbientCapabilities=CAP_NET_BIND_SERVICE\nCapabilityBoundingSet=CAP_NET_BIND_SERVICE\n' | sudo tee /etc/systemd/system/stardust.service.d/bind-port.conf >/dev/null
sudo systemctl daemon-reload
sudo install -o root -g root -m 0644 scripts/updater/*.mjs /usr/local/lib/stardust-updater/
sudo node /usr/local/lib/stardust-updater/update.mjs /opt/stardust main
```

若更新器报告同版本跳过，运行 `sudo systemctl restart stardust.service` 使 drop-in 生效。检查 `systemctl status stardust.service` 和实际端口的健康接口。当前更新器通过 systemd 主进程的监听 socket 查找实际端口并核对健康响应的运行 SHA，同版本检查和部署检查不依赖旧的 `healthPort`；服务重启前后均检查当前进程。若容器 root 无权读取该进程的 `/proc/<PID>/fd`，检查会尝试以 systemd 配置的非 root 服务用户读取，避免额外授予 `CAP_SYS_PTRACE`；仍无法确认时部署检查失败。状态命令在无法读取 systemd 进程时会尝试旧的 `healthPort`，否则报告 `unknown`。

健康接口中的 `runningSha` 是进程启动时读取的版本标识；开发环境缺少正式元数据时为 `development`。状态命令会通过本机健康接口观察运行 SHA，无法确认时显示 `unknown`。它与 `current` 的指向分别观察，避免只凭链接推断实际运行版本。

## 独立反向代理与访问边界

Stardust 以可信局域网为部署前提，同源校验和控制会话令牌用于防止跨站请求，并不是用户身份认证；能够访问 WebUI 的网络用户可以使用业务功能并审批 Tool。不要把服务或代理直接暴露到不可信网络，也不要只依靠转发头或同源检查来保护系统更新、备份下载等管理操作；更新器仍仅通过服务器上的管理员 CLI 执行。服务不会自动修改防火墙。Tool 的明确批准、参数摘要、来源与权限规则继续生效。

默认不信任任何反向代理。使用独立 Caddy 时，在已有服务器上创建 systemd drop-in，填写 Caddy **连接 Stardust 时的实际源 IP**（多个地址用逗号分隔；仅支持精确 IPv4/IPv6，不支持网段、主机名或通配符）：

```sh
sudo install -d -m 0755 /etc/systemd/system/stardust.service.d
printf '[Service]\nEnvironment=STARDUST_TRUSTED_PROXIES=192.168.30.23\n' | sudo tee /etc/systemd/system/stardust.service.d/trusted-proxy.conf >/dev/null
sudo systemctl daemon-reload
sudo systemctl restart stardust.service
```

Caddy 的 reverse_proxy 应保留浏览器原始 Host 并设置单个 `X-Forwarded-Proto`；其默认行为满足此要求。该 IP 是 Stardust 看到的 TCP 对端地址，容器 NAT 存在时可能不同，应以实际连接为准。只为受控代理配置地址，并限制任何其他人不能使用该地址或经其转发任意 Host；不要信任客户端自带的转发头。直连使用服务器 IP，例如 `http://192.168.30.22/`，通过代理使用 `https://bot.lan.tenqui.ink`。直接访问时 Host 须为连接的服务端 IP（本机可使用 localhost），避免 DNS 重绑定；代理的 Host 由受信 Caddy 的站点配置限制。

`STARDUST_TRUSTED_PROXIES` 也可写在 `/opt/stardust/shared/.env`；进程环境变量优先。配置非法时服务拒绝启动。不要同时在 drop-in 与 .env 中设置不同值。更改后重启生效，查看 `sudo systemctl status stardust.service` 和日志排查。

Debian 精简环境可先安装完整依赖：

```sh
sudo apt update && sudo apt install -y git nodejs npm systemd util-linux tar gzip psmisc coreutils procps passwd libc-bin
```

`psmisc` 提供 `fuser`。发行版自带 Node.js 不一定满足版本要求，还需自行提供可信系统路径中的 Node.js 24 和 npm。升级期间备份前先停止服务并检查数据库文件是否仍被使用；如容器权限导致检查无法确认，更新会失败，不会忽略检查。

## 数据和手动更新

程序位于 `/opt/stardust/releases/<SHA>`，`current` 指向当前版本。配置、凭据、数据库和其他持久数据保存在 `/opt/stardust/shared`；服务通过 `STARDUST_STORAGE_ROOT` 使用它们。更新前的归档和校验清单位于 root 私有的 `/opt/stardust/backups`，包含敏感信息，不要公开。

```sh
sudo node /usr/local/lib/stardust-updater/update.mjs /opt/stardust main
sudo node /usr/local/lib/stardust-updater/status.mjs /opt/stardust
```

当目标 SHA 与已安装版本一致时，更新器检查已安装产物、服务配置和实际运行 SHA；正常则返回 `UP_TO_DATE`，不重新构建、停机或备份。异常返回 `INSTALLATION_UNHEALTHY`，需要管理员检查。`--force` 只跳过退避，不绕过完整性或监督检查，也不会强制重新安装相同版本。

有新版本时，旧服务在构建期间继续运行。新版本准备完成后，更新器停止服务，检查数据库使用情况，备份 `shared`，切换 `current`，再启动并检查运行 SHA。候选 release 已发布且完整性、归属和 SHA 校验通过时，重试可直接复用，无需重建。部署命令失败时，CLI 输出命令名、有限的脱敏 stderr 和退出码，诊断写入 root 私有的 updater 目录。旧 release 保留。备份失败会尝试恢复旧服务；切换后失败不会自动回滚，因为新程序可能已经迁移数据库。管理员应检查状态、日志和备份，确认数据兼容性后再处理。更新期间其他程序不应写入 `shared`；符号链接、硬链接和特殊文件会使备份保守失败。

## 联合验收

在干净的隔离 Debian 容器运行首次安装，并通过可信网络完成初始化。记下健康接口的 `runningSha`，再执行一次手动更新：应返回 `UP_TO_DATE`，不产生备份。远程 `main` 出现新版本后再次更新，核对新 `runningSha`、持久数据以及新建的备份和校验清单。首次安装、真实更新、服务管理与备份路径均需实机验证；本项目不会连接或操作服务器。

WebUI 更新与备份页面、备份恢复、自动更新 timer 和 updater 自更新尚未实现。旧阶段的技术调查与用户提供的 Debian 基础测试记录保留在 [历史部署调查](deployment-investigation.md)。
