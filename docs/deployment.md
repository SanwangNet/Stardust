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

## 现有 Debian 实例迁移

在 [GitHub Releases](https://github.com/SanwangNet/Stardust/releases) 下载包含新架构的 `install.sh`，确认旧更新没有运行后执行：

```sh
sudo bash install.sh --migrate --enable-management
```

如果希望继续关闭 WebUI 软件管理，省略 `--enable-management`。迁移复用现有 `stardust.service` 和服务用户，保留 `shared`、端口、低端口权限、可信代理、已有备份和旧版本目录。新包在旧服务运行期间下载并校验，停机后先备份，再切换。标准旧 oneshot、sudoers 规则和旧启用 drop-in 会移到管理员私有目录，便于核对。自定义文件保持原样，请由部署者检查。旧构建账号、源码 release、旧 Updater 文件和构建残留不会自动清理，避免删除实验性或仍有价值的文件。

若迁移已配置新单元但下载或部署失败，先查阅 `sudo journalctl -u stardust.service -e` 和终端错误。解决问题后，可以用同一套管理器重试安装：

```sh
sudo flock --no-fork /opt/stardust/management/private/lock "$(command -v node)" /usr/local/lib/stardust-lifecycle/manage.mjs install
```

重试前确认当前部署和备份状态。如果安装器中途退出且尚未写齐单元，请先检查创建到哪一步。切换后的健康检查失败会保留失败状态和更新前备份，由部署者决定如何恢复。

## 软件更新、备份与回滚

- 软件更新页面检查已发布的软件包。选中更新后，管理器再次确认目标 SHA、验证包并解压。旧服务继续运行到准备完成。服务停止后创建自动备份，再原子切换 `current`，启动并核对运行 SHA。
- 版本清理默认保留当前版本和最近两个可用版本。编辑 root 专用的 `/opt/stardust/management/config.json` 可将 `retainVersions` 和 `retainAutomaticBackups` 分别设置为 1–50。迁移首次运行会额外保留旧源码版本。未知目录由部署者自行检查。
- 回滚程序仅在两个发布版本声明相同数据兼容代数时开放。未来若修改数据兼容性，发布者须提高 `package.json` 的 `stardustDataFormat`。旧源码版本没有这个声明，必须通过对应的数据备份一起恢复。不提供 SQLite 逆向迁移。
- 备份页面可手动创建、下载、上传、恢复和删除备份。创建备份时短暂停止服务，`shared` 由 Stardust 独占管理。正常更新继续使用原有 `shared`。下载走受控接口，归档包含配置、凭据和所有持久化数据。
- 手动备份、上传备份和恢复前的安全副本不会随自动备份或程序版本清理。恢复会校验内容并先保存当前数据的安全副本，再替换 `shared`，启动备份对应程序。端口、代理设置及备份之后写入的数据都可能改变，WebUI 会要求确认。若发布版已从本机清理，管理器尝试按备份中的发布身份重新下载。
- 旧 UUID 命名的 tar.gz 和独立 JSON 清单可读取及下载。仅在校验匹配且对应旧程序仍存在时可恢复。单独上传旧 tar.gz 可以保留和下载，但缺少可信版本关联，不能从 WebUI 恢复。包含链接或特殊文件的归档不支持自动恢复。恢复到不包含管理页面的旧版后，请在服务器侧核对结果，状态仍在 `/opt/stardust/management/status.json`。所有旧归档会保留，直到用户明确删除。
- 备份上传和下载上限为 2 GiB，归档解压上限为 8 GiB。若通过代理上传，代理也需允许相应大小和请求时间。

## 发布和运行边界

`main` 推送触发 GitHub Actions。构建工作只读检查源码，执行 npm 安装、类型检查、编译和测试，再单独安装生产依赖。工作流将编译后的程序、静态资源、生产依赖、版本元数据和 SHA256 归档，并从解压目录独立启动验证。发布工作使用最小写权限，先创建草稿并上传完整产物，随后公开发布。发布身份包含工作流序号和完整 Commit SHA。已有发布产物不覆盖。失败留下草稿时，可由维护者检查并移除该草稿后重试同一运行。

Core 通过固定请求文件提交预定义操作，systemd.path 启动独立 oneshot。管理器使用 flock 串行处理请求。Core 可读取筛选后的状态及被授权下载的备份，本身没有系统服务启动授权。用户请求不携带命令、服务名、路径、仓库地址或下载 URL。管理器安装在管理员控制的 `/usr/local/lib/stardust-lifecycle`，普通 Core 更新只更换运行包。不兼容管理器契约的包需要管理员从审核过的发布下载安装入口，执行 `sudo bash install.sh --refresh-manager`。若发布说明要求修改 systemd 单元或其他部署契约，还需按该发布的说明手动迁移。没有自动调度、原生 HTTPS、ACME 或自动回滚。

状态和故障检查：

```sh
sudo systemctl status stardust.service stardust-lifecycle.path
sudo journalctl -u stardust-lifecycle.service -u stardust.service -e
```

在 Debian 13 / Proxmox LXC 验收时，应验证非 root Core 绑定 80、Caddy 访问、停机后请求继续执行、更新前备份、重启后运行 SHA、已填写配置及数据，以及一次受控的备份上传与恢复。历史源码构建方案仅作为记录，见 [旧部署调查](deployment-investigation.md)。
