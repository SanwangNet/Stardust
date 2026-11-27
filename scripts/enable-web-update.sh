#!/usr/bin/env bash
set -Eeuo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
[[ $(id -u) == 0 ]] || { printf '请使用 sudo 运行。\n' >&2; exit 1; }
for tool in node sudo visudo systemctl install readlink getent stat cmp mktemp; do command -v "$tool" >/dev/null || { printf '缺少 %s；请先安装 sudo 及 Node.js 24。\n' "$tool" >&2; exit 1; }; done
NODE=$(readlink -f "$(command -v node)")
[[ $NODE =~ ^/[a-zA-Z0-9_./-]+$ ]] || { printf 'Node 路径无效。\n' >&2; exit 1; }
[[ $($NODE -p 'Number(process.versions.node.split(".")[0])') == 24 ]] || { printf '需要 Node.js 24。\n' >&2; exit 1; }
getent passwd stardust >/dev/null && getent group stardust >/dev/null || { printf '未找到 stardust 服务用户或用户组。\n' >&2; exit 1; }
CODE=/usr/local/lib/stardust-updater
UNIT=/etc/systemd/system/stardust-web-update.service
POLICY=/etc/sudoers.d/stardust-web-update
DROP=/etc/systemd/system/stardust.service.d/web-update.conf
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
[[ -d $CODE && ! -L $CODE && -f $CODE/update.mjs && ! -L $CODE/update.mjs && $(stat -c %u "$CODE") == 0 && $(( 8#$(stat -c %a "$CODE") & 0022 )) == 0 && -d /opt/stardust/shared ]] || { printf '未找到现有 Stardust 安装。\n' >&2; exit 1; }
for path in "$UNIT" "$POLICY" "$DROP"; do [[ ! -e $path && ! -L $path ]] || { printf '配置已存在：%s；请先检查，未覆盖。\n' "$path" >&2; exit 1; }; done
[[ -f "$SCRIPT_DIR/updater/web-update.mjs" ]] || { printf '缺少可信安装源码中的 web-update.mjs。\n' >&2; exit 1; }
node_path=$NODE
while :; do
  [[ ! -L $node_path && $(stat -c %u "$node_path") == 0 && $(( 8#$(stat -c %a "$node_path") & 0022 )) == 0 ]] || { printf 'Node 路径不安全：%s\n' "$node_path" >&2; exit 1; }
  [[ $node_path == / ]] && break
  node_path=$(dirname -- "$node_path")
done
for path in / /usr /usr/local /usr/local/lib "$CODE" "$CODE"/*.mjs; do
  [[ ! -L $path && $(stat -c %u "$path") == 0 && $(( 8#$(stat -c %a "$path") & 0022 )) == 0 ]] || { printf '路径不安全：%s\n' "$path" >&2; exit 1; }
done
if [[ -e "$CODE/web-update.mjs" || -L "$CODE/web-update.mjs" ]]; then
  [[ ! -L "$CODE/web-update.mjs" ]] && cmp -s "$SCRIPT_DIR/updater/web-update.mjs" "$CODE/web-update.mjs" || { printf '已存在不同的 web-update.mjs，未覆盖。\n' >&2; exit 1; }
else
  install -o root -g root -m 0644 "$SCRIPT_DIR/updater/web-update.mjs" "$CODE/web-update.mjs"
fi
install -d -o root -g root -m 0755 /etc/systemd/system/stardust.service.d
cat > "$UNIT" <<EOF
[Unit]
Description=Stardust Web Update
After=network-online.target

[Service]
Type=oneshot
User=root
Group=stardust
UMask=0027
RuntimeDirectory=stardust-web-update
RuntimeDirectoryMode=0750
RuntimeDirectoryPreserve=yes
TimeoutStartSec=2h
ExecStart=$NODE $CODE/web-update.mjs
EOF
printf '[Service]\nEnvironment=STARDUST_WEB_UPDATE_ENABLED=1\n' > "$DROP"
chmod 0644 "$UNIT" "$DROP"
TMP_POLICY=$(mktemp /etc/sudoers.d/.stardust-web-update.XXXXXX)
trap 'rm -f -- "$TMP_POLICY"' EXIT
printf 'stardust ALL=(root) NOPASSWD: /usr/bin/systemctl start --no-block stardust-web-update.service\n' > "$TMP_POLICY"
chmod 0440 "$TMP_POLICY"
visudo -cf "$TMP_POLICY" >/dev/null
mv -- "$TMP_POLICY" "$POLICY"
systemctl daemon-reload
printf 'WebUI 更新已配置。已有服务请执行：sudo systemctl restart stardust.service\n'
