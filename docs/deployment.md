# 安装、运行和更新

当前安装与更新功能尚待在 Debian 13 的隔离环境中完整验收。请先在可丢弃的测试容器中按下面的命令验证，不要直接用于已有生产服务。需要 systemd、cgroup v2、Node.js 24、npm、Git、flock、tar 和 fuser；脚本检查依赖，不自动安装系统软件包。

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

WebUI 默认只监听服务器本机 `http://127.0.0.1:8347`。从自己的电脑访问，先建立 SSH 隧道：

```sh
ssh -L 8347:127.0.0.1:8347 用户@服务器
```

然后在自己电脑的浏览器打开 `http://127.0.0.1:8347`，在现有初始化界面完成配置。尚无统一账号认证，不应将 WebUI 直接暴露到公网。可在 `shared/config.toml` 的 `[server]` 中配置监听地址和端口，但局域网访问必须自行确保入口可信、受网络边界保护；更改端口后还需同步修改 `/opt/stardust/updater/config.json` 的 `healthPort`，并重启服务。

```sh
sudo systemctl status stardust.service
sudo systemctl start stardust.service
sudo systemctl stop stardust.service
sudo journalctl -u stardust.service -e
curl http://127.0.0.1:8347/api/health
```

健康接口中的 `runningSha` 是进程启动时读取的版本标识；开发环境缺少正式元数据时为 `development`。状态命令会通过本机健康接口观察运行 SHA，无法确认时显示 `unknown`。它与 `current` 的指向分别观察，避免只凭链接推断实际运行版本。

## 数据和手动更新

程序位于 `/opt/stardust/releases/<SHA>`，`current` 指向当前版本。配置、凭据、数据库和其他持久数据保存在 `/opt/stardust/shared`；服务通过 `STARDUST_STORAGE_ROOT` 使用它们。更新前的归档和校验清单位于 root 私有的 `/opt/stardust/backups`，包含敏感信息，不要公开。

```sh
sudo node /usr/local/lib/stardust-updater/update.mjs /opt/stardust main
sudo node /usr/local/lib/stardust-updater/status.mjs /opt/stardust
```

当目标 SHA 与已安装版本一致时，更新器检查已安装产物、服务配置和实际运行 SHA；正常则返回 `UP_TO_DATE`，不重新构建、停机或备份。异常返回 `INSTALLATION_UNHEALTHY`，需要管理员检查。`--force` 只跳过退避，不绕过完整性或监督检查，也不会强制重新安装相同版本。

有新版本时，旧服务在构建期间继续运行。新版本准备完成后，更新器停止服务，检查数据库使用情况，备份 `shared`，切换 `current`，再启动并检查运行 SHA。旧 release 保留。备份失败会尝试恢复旧服务；切换后失败不会自动回滚，因为新程序可能已经迁移数据库。管理员应检查状态、日志和备份，确认数据兼容性后再处理。更新期间其他程序不应写入 `shared`；符号链接、硬链接和特殊文件会使备份保守失败。

## 联合验收

在干净的隔离 Debian 容器运行首次安装，并通过 SSH 隧道完成初始化。记下健康接口的 `runningSha`，再执行一次手动更新：应返回 `UP_TO_DATE`，不产生备份。远程 `main` 出现新版本后再次更新，核对新 `runningSha`、持久数据以及新建的备份和校验清单。首次安装、真实更新、服务管理与备份路径均需实机验证；本项目不会连接或操作服务器。

WebUI 更新与备份页面、备份恢复、自动更新 timer 和 updater 自更新尚未实现。旧阶段的技术调查与用户提供的 Debian 基础测试记录保留在 [历史部署调查](deployment-investigation.md)。
