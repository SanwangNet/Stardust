#!/usr/bin/env bash
set -Eeuo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
unset STARDUST_STORAGE_ROOT
ROOT=/opt/stardust
CODE=/usr/local/lib/stardust-updater
UNIT=/etc/systemd/system/stardust.service
BUILD_USER=stardust-build
CORE_USER=stardust

fail() { printf '安装停止：%s\n' "$*" >&2; exit 1; }
trap 'printf "安装未完成，已保留现场。请检查 /opt/stardust/updater/state.json 和 journalctl -u stardust.service。\n" >&2' ERR
[[ $(id -u) == 0 ]] || fail '请使用 sudo bash scripts/install.sh'
[[ $(uname -s) == Linux ]] || fail '仅支持 Debian Linux'
[[ -d /run/systemd/system ]] && systemctl show --property=Version >/dev/null || fail 'systemd 系统管理器不可用'
for tool in node npm git systemctl systemd-run flock tar fuser chown chmod mv ps getent useradd install readlink; do
  command -v "$tool" >/dev/null || fail "缺少 $tool，请先安装依赖"
done
NODE=$(readlink -f "$(command -v node)")
[[ $NODE =~ ^/[a-zA-Z0-9_./-]+$ ]] || fail 'Node 路径包含不支持的字符'
[[ $($NODE -p 'Number(process.versions.node.split(".")[0])') == 24 ]] || fail '需要 Node.js 24'
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
[[ -f "$SCRIPT_DIR/updater/update.mjs" ]] || fail '未找到可信 updater 代码'
if [[ -e $ROOT || -L $ROOT ]]; then
  printf '检测到已有或未完成的安装：%s。未修改任何文件。\n' "$ROOT"
  [[ ! -L $ROOT/current ]] || printf 'current: %s\n' "$(readlink "$ROOT/current")"
  systemctl is-active stardust.service || true
  printf '查看服务：systemctl status stardust.service\n更新：sudo node %s/update.mjs %s main\n' "$CODE" "$ROOT"
  exit 1
fi
[[ ! -e $CODE && ! -L $CODE && ! -e $UNIT && ! -L $UNIT ]] || fail 'updater 目录或服务文件已存在，请先人工检查'
if systemctl cat stardust.service >/dev/null 2>&1; then fail '已有同名 systemd 服务'; fi
if getent passwd "$BUILD_USER" >/dev/null || getent passwd "$CORE_USER" >/dev/null || getent group "$BUILD_USER" >/dev/null || getent group "$CORE_USER" >/dev/null; then fail '服务用户或用户组已存在，请先人工检查'; fi
mkdir -- "$ROOT"
chmod 0755 "$ROOT"
useradd --system --user-group --no-create-home --shell /usr/sbin/nologin "$BUILD_USER"
useradd --system --user-group --no-create-home --shell /usr/sbin/nologin "$CORE_USER"
install -d -o root -g root -m 0755 "$ROOT/releases" "$CODE"
install -d -o root -g root -m 0700 "$ROOT/updater" "$ROOT/backups"
install -d -o "$CORE_USER" -g "$CORE_USER" -m 0700 "$ROOT/shared"
install -o root -g root -m 0644 "$SCRIPT_DIR"/updater/*.mjs "$CODE/"
printf '{"buildUser":"%s","coreUser":"%s","healthPort":80}\n' "$BUILD_USER" "$CORE_USER" > "$ROOT/updater/config.json"
chmod 0600 "$ROOT/updater/config.json"
printf '正在通过受监督的非 root Worker 构建初始版本……\n'
"$NODE" "$CODE/prepare.mjs" "$ROOT" main
SHA=$("$NODE" -e 'const s=require(process.argv[1]);if(s.status!=="READY"||!/^[a-f0-9]{40}$/.test(s.preparedSha))process.exit(1);process.stdout.write(s.preparedSha)' "$ROOT/updater/state.json")
[[ -d $ROOT/releases/$SHA && ! -L $ROOT/releases/$SHA ]] || fail '初始版本未发布'
ln -s "releases/$SHA" "$ROOT/current"
cat > "$UNIT" <<EOF
[Unit]
Description=Stardust
After=network.target

[Service]
Type=simple
User=$CORE_USER
WorkingDirectory=$ROOT/current
Environment=STARDUST_STORAGE_ROOT=$ROOT/shared
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
ExecStart=$NODE --experimental-sqlite apps/server/dist/main.js
KillMode=control-group
Delegate=no
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=multi-user.target
EOF
chmod 0644 "$UNIT"
systemctl daemon-reload
systemctl enable --now stardust.service
"$NODE" --input-type=module - "$SHA" <<'JS'
const expected = process.argv[2];
const until = Date.now() + 30000;
while (Date.now() < until) {
  try {
    const response = await fetch('http://127.0.0.1:80/api/health', {signal: AbortSignal.timeout(2000), redirect: 'error'});
    if (response.ok) { const value = await response.json(); if (value.status === 'ok' && value.service === 'Stardust' && value.runningSha === expected) process.exit(0); }
  } catch {}
  await new Promise(resolve => setTimeout(resolve, 1000));
}
console.error('服务未就绪或运行版本不匹配，请查看 journalctl -u stardust.service'); process.exit(1);
JS
printf '\n安装完成。WebUI 默认监听 0.0.0.0:80，可通过 http://服务器IP/ 访问。\n'
printf '当前没有统一账号认证，请仅在可信网络中访问。\n'
printf '状态：systemctl status stardust.service\n日志：journalctl -u stardust.service -e\n'
printf '更新：sudo %s %s/update.mjs %s main\n' "$NODE" "$CODE" "$ROOT"
