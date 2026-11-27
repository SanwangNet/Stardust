# 安装、更新与备份

Stardust 发布包面向 Debian 13、Linux x86_64 和 Node.js 24。生产机器还需要 Python 3、systemd 和 util-linux。可以先安装 Debian 依赖，再通过可信的软件源安装 Node.js 24：

```sh
sudo apt update
sudo apt install python3 systemd util-linux passwd coreutils ca-certificates
node --version
```

在 [GitHub Releases](https://github.com/SanwangNet/Stardust/releases) 下载已发布版本的 `install.sh`，核对仓库来源并审核后执行：

```sh
sudo bash install.sh
```

若希望首次安装同时启用 WebUI 软件管理，使用 `sudo bash install.sh --enable-management`。使用新架构安装后，也可以用同一个脚本和选项启用。安装器会获取最新完整发布，校验软件包 SHA256，解压到 `/opt/stardust/releases/<SHA>`，并启动独立非 root 用户的服务。Core 默认在 `0.0.0.0:80` 监听，低端口绑定权限仍由它的 systemd 单元提供。通过可信网络打开服务器 IP 完成初始化。已有端口覆盖优先，页面保存的端口在下次重启时生效。

私有仓库需要先用有权访问该仓库的账号下载安装入口。若服务器也需要凭据，请将只读、仅该仓库的 GitHub Contents 凭据以 root 所有、`0600` 权限保存在 `/etc/stardust/github-token`。例如先执行 `sudo install -d -m 0700 /etc/stardust`，再执行 `sudo install -m 0600 /dev/null /etc/stardust/github-token` 并使用 `sudoedit` 填写。公开仓库无需凭据。凭据由管理器读取，不进入 Core、浏览器或软件包。下载重定向不携带凭据。

## WebUI 与可信代理

软件管理默认关闭。启用后，所有能够访问该 WebUI 的用户都能更新、下载包含凭据和私人历史的备份，以及恢复或删除数据。请仅在受控网络中启用。Host、Origin、跨站检查和可信代理配置继续生效，这些检查不识别用户身份。

独立 Caddy 需要保留原始 Host 并发送 `X-Forwarded-Proto`。若 Caddy 到 Core 的实际 TCP 源地址为 `192.168.30.23`，可以通过已有服务 drop-in 配置：

```ini
[Service]
Environment=STARDUST_TRUSTED_PROXIES=192.168.30.23
```

执行 `sudo systemctl daemon-reload && sudo systemctl restart stardust.service` 生效。已有可信代理设置会原样保留。Caddy 与 Stardust 部署在不同主机时可以分别监听各自的 80 端口。

若首次安装已配置 systemd 单元但下载或部署失败，检查日志并解决问题后，可重试安装：

```sh
sudo flock --no-fork /opt/stardust/management/private/lock "$(command -v node)" /usr/local/lib/stardust-lifecycle/manage.mjs install
```

## 软件更新、备份与回滚

- 软件更新页面检查已发布的软件包。选中更新后，管理器再次确认目标 SHA、验证包并解压。旧服务继续运行到准备完成。服务停止后创建自动备份，再原子切换 `current`，启动并核对运行 SHA。
- 版本清理默认保留当前版本和最近两个可用版本。编辑 root 专用的 `/opt/stardust/management/config.json` 可将 `retainVersions` 和 `retainAutomaticBackups` 分别设置为 1–50。未知目录由部署者自行检查。
- 回滚程序仅在两个发布版本声明相同数据兼容代数时开放。未来若修改数据兼容性，发布者须提高 `package.json` 的 `stardustDataFormat`。不提供 SQLite 逆向迁移。
- 备份页面可手动创建、下载、上传、恢复和删除备份。创建备份时短暂停止服务，`shared` 由 Stardust 独占管理。正常更新继续使用原有 `shared`。下载走受控接口，归档包含配置、凭据和所有持久化数据。
- 手动备份、上传备份和恢复前的安全副本不会随自动备份或程序版本清理。恢复会校验内容并先保存当前数据的安全副本，再替换 `shared`，启动备份对应程序。端口、代理设置及备份之后写入的数据都可能改变，WebUI 会要求确认。若发布版已从本机清理，管理器尝试按备份中的发布身份重新下载。
- 旧 UUID 命名的 tar.gz 和独立 JSON 清单可读取及下载。仅在校验匹配且对应旧程序仍存在时可恢复。单独上传旧 tar.gz 可以保留和下载，但缺少可信版本关联，不能从 WebUI 恢复。包含链接或特殊文件的归档不支持自动恢复。所有旧归档会保留，直到用户明确删除。
- 备份上传和下载上限为 2 GiB，归档解压上限为 8 GiB。若通过代理上传，代理也需允许相应大小和请求时间。

## 发布和运行边界

`main` 推送触发 GitHub Actions。构建工作只读检查源码，执行 npm 安装、类型检查、编译和测试，再单独安装生产依赖。工作流将编译后的程序、静态资源、生产依赖、版本元数据和 SHA256 归档，并从解压目录独立启动验证。发布工作使用最小写权限，先创建草稿并上传完整产物，随后公开发布。发布身份包含工作流序号和完整 Commit SHA。已有发布产物不覆盖。失败留下草稿时，可由维护者检查并移除该草稿后重试同一运行。

Core 通过固定请求文件提交预定义操作，systemd.path 启动独立 oneshot。管理器使用 flock 串行处理请求。Core 可读取筛选后的状态及被授权下载的备份，本身没有系统服务启动授权。用户请求不携带命令、服务名、路径、仓库地址或下载 URL。每个正式发布包同时包含 Core 和配套管理器。更新时，运行中的管理器下载并校验发布包，在启动新版 Core 并检查健康状态后，原子交换整个管理器目录；本次任务仍由旧进程完成，下一次任务使用新代码。普通程序回滚和备份恢复不会降级管理器。若发布说明要求修改 systemd 单元或其他部署契约，仍需按说明手动处理。

**发布渠道信任边界：**部署者信任官方 SanwangNet/Stardust GitHub Releases，包括其中以 root 运行的管理器代码。HTTPS 和同源 SHA256 校验传输完整性，并不提供独立签名认证；若官方仓库、发布工作流、GitHub 账号或发布渠道被攻陷，攻击者可能发布恶意代码并获得服务器 root 权限。请保护发布账号和工作流。

检查与下载发布资源时，管理器对临时连接故障最多尝试三次，每个资源共用 120 秒期限；认证、发布元数据及校验错误不会作为临时网络故障重试。

已安装的旧管理器没有自升级能力，需要一次性从正式发布下载安装脚本并执行 `sudo bash install.sh --refresh-manager`，此后正常更新无需手动刷新。该入口也可用于修复管理器，且与任务共用锁。每次交换会保留前一套完整管理器在 `/usr/local/lib/.stardust-lifecycle-*`；如新管理器无法运行，可使用可信发布的安装脚本重新执行刷新。交换异常时保留目录也可能是尚未启用的新代码，请先检查再操作。保留目录不会自动删除，可在确认不再需要后由管理员清理。管理器服务仍使用 `UMask=0077`。

状态和故障检查：

```sh
sudo systemctl status stardust.service stardust-lifecycle.path
sudo journalctl -u stardust-lifecycle.service -u stardust.service -e
```

在 Debian 13 / Proxmox LXC 验收时，应验证非 root Core 绑定 80、Caddy 访问、停机后请求继续执行、更新前备份、重启后运行 SHA、已填写配置及数据，以及一次受控的备份上传与恢复。历史源码构建方案仅作为记录，见 [旧部署调查](deployment-investigation.md)。
