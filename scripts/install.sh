#!/usr/bin/env bash
set -Eeuo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
root=/opt/stardust
code=/usr/local/lib/stardust-lifecycle
unit=/etc/systemd/system
migrate=false
enable=false
refresh=false
for option in "$@"; do
  case $option in
    --migrate) migrate=true ;;
    --refresh-manager) refresh=true ;;
    --enable-management) enable=true ;;
    *) printf '用法：sudo bash install.sh [--migrate] [--enable-management] [--refresh-manager]\n' >&2; exit 2 ;;
  esac
done
fail(){ printf '%s\n' "$*" >&2; exit 1; }
[[ $(id -u) == 0 && $(uname -s) == Linux && $(uname -m) == x86_64 ]] || fail '需要在 Linux x86_64 上以管理员身份安装。'
for cmd in node python3 systemctl flock runuser getent useradd install stat readlink; do command -v "$cmd" >/dev/null || fail "缺少 $cmd。Debian 系统依赖可用 apt install python3 systemd util-linux passwd coreutils 安装，并另行安装 Node.js 24。"; done
node=$(readlink -f "$(command -v node)")
[[ $node =~ ^/[a-zA-Z0-9_./-]+$ ]] || fail '无效的 Node.js 路径。'
for p in "$node" /opt /usr/local /usr/local/lib /etc/systemd/system; do
  while [[ $p != / ]]; do
    [[ ! -L $p && $(stat -c %u "$p") == 0 && $(( 8#$(stat -c %a "$p") & 0022 )) == 0 ]] || fail "管理员控制的路径不可用：$p"
    p=$(dirname -- "$p")
  done
done
[[ $("$node" -p 'process.versions.node.split(".")[0]') == 24 ]] || fail '需要 Node.js 24。'
if $refresh && { $enable || $migrate; }; then fail '--refresh-manager 必须单独使用。'; fi
safe_dir(){ [[ -d $1 && ! -L $1 && $(readlink -f "$1") == "$1" && $(stat -c %u "$1") == 0 && $(( 8#$(stat -c %a "$1") & 0022 )) == 0 ]]; }
write_manager(){
# The generated release installer defines this function with the reviewed manager embedded.
if declare -F install_manager >/dev/null; then
  install_manager "$1"
else
  source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/lifecycle" && pwd -P)
  install -o root -g root -m 0644 "$source_dir"/{manage,files,running-port}.mjs "$source_dir/archive.py" "$1/"
fi
}
if $refresh; then
  for p in "$root" "$root/management" "$root/management/private" "$code"; do safe_dir "$p" || fail "安装路径不安全：$p"; done
  exec 8>"$root/management/private/lock"
  flock -n 8 || fail '软件管理操作正在进行，请稍后重试。'
  stage=$(mktemp -d /usr/local/lib/.stardust-lifecycle.XXXXXXXX)
  write_manager "$stage"
  for file in manage.mjs files.mjs running-port.mjs archive.py; do
    install -o root -g root -m 0644 "$stage/$file" "$code/$file.new"
  done
  for file in manage.mjs files.mjs running-port.mjs archive.py; do
    mv -f -- "$code/$file.new" "$code/$file"
    unlink "$stage/$file"
  done
  rmdir -- "$stage"
  printf '生命周期管理器已更新，现有 Core 及数据保持原样。\n'
  exit 0
fi
if ! $migrate && $enable && [[ -f $root/management/config.json ]]; then
  for p in "$root" "$root/backups" "$root/management" "$root/management/private" "$code"; do safe_dir "$p" || fail "安装路径不安全：$p"; done
  /usr/bin/flock --no-fork "$root/management/private/lock" "$node" "$code/manage.mjs" enable
  install -d -o root -g stardust -m 0770 "$root/management/inbox"
  chgrp stardust "$root/backups"
  chmod 0750 "$root/backups"
  shopt -s nullglob
  for p in "$root/backups"/*.tar.gz; do
    [[ ${p##*/} =~ ^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}\.tar\.gz$ && -f $p && ! -L $p && $(stat -c '%u:%h' "$p") == 0:1 ]] || continue
    chgrp stardust "$p"
    chmod 0640 "$p"
  done
  printf '[Service]\nRuntimeDirectory=stardust-core\nRuntimeDirectoryMode=0700\nEnvironment=STARDUST_MANAGED_ENDPOINT=1\nEnvironment=STARDUST_MANAGEMENT_ENABLED=1\n' > "$unit/stardust.service.d/lifecycle.conf"
  systemctl daemon-reload
  systemctl enable --now stardust-lifecycle.path
  systemctl restart stardust.service
  exit 0
fi
if $migrate; then
  for p in "$root" "$root/releases" "$root/backups"; do safe_dir "$p" || fail "不支持的旧安装路径：$p"; done
  [[ -d $root/shared && ! -L $root/shared && -L $root/current ]] || fail '未找到完整的旧安装。'
  [[ $(systemctl show stardust.service -p User --value) == stardust && $(systemctl show stardust.service -p WorkingDirectory --value) == "$root/current" ]] || fail '旧服务配置与标准部署不匹配。'
  if [[ -d $root/updater && ! -L $root/updater ]]; then
    safe_dir "$root/updater" || fail '旧 updater 状态目录不安全。'
    if [[ -e $root/updater/update.lock || -L $root/updater/update.lock ]]; then
      [[ ! -L $root/updater/update.lock && -f $root/updater/update.lock && $(stat -c '%u:%h' "$root/updater/update.lock") == 0:1 ]] || fail '旧更新锁不安全。'
    fi
    (umask 077; touch "$root/updater/update.lock")
    exec 9<"$root/updater/update.lock"
    flock -n 9 || fail '旧更新任务仍在运行，请等它结束。'
  fi
  if systemctl is-active --quiet stardust-web-update.service; then fail '旧 WebUI 更新仍在运行。'; fi
  if [[ -e $root/management || -L $root/management || -e $code || -L $code ]]; then fail '检测到生命周期管理器已安装或安装未完成，请检查现有配置。'; fi
else
  [[ ! -e $root && ! -L $root && ! -e $code && ! -L $code && ! -e $unit/stardust.service && ! -L $unit/stardust.service ]] || fail '已有安装，请使用 --migrate。'
  ! getent passwd stardust >/dev/null && ! getent group stardust >/dev/null || fail '用户或组 stardust 已存在。'
  useradd --system --user-group --no-create-home --shell /usr/sbin/nologin stardust
  install -d -o root -g root -m 0755 "$root" "$root/releases"
  install -d -o root -g root -m 0700 "$root/backups"
  install -d -o stardust -g stardust -m 0700 "$root/shared"
fi
uid=$(id -u stardust)
gid=$(getent group stardust | cut -d: -f3)
[[ $uid != 0 && $(stat -c %u "$root/shared") == "$uid" ]] || fail '持久化目录必须由 Stardust 服务用户持有。'
install -d -o root -g root -m 0755 "$code"
write_manager "$code"
install -d -o root -g stardust -m 0750 "$root/management"
install -d -o root -g root -m 0700 "$root/management/private"
if $enable; then
  install -d -o root -g stardust -m 0770 "$root/management/inbox"
  chgrp stardust "$root/backups"
  chmod 0750 "$root/backups"
  shopt -s nullglob
  for p in "$root/backups"/*.tar.gz; do
    [[ ${p##*/} =~ ^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}\.tar\.gz$ && -f $p && ! -L $p && $(stat -c '%u:%h' "$p") == 0:1 ]] || continue
    chgrp stardust "$p"
    chmod 0640 "$p"
  done
else
  install -d -o root -g root -m 0700 "$root/management/inbox"
fi
(umask 077; printf '{"uid":%s,"gid":%s,"enabled":%s,"retainVersions":3,"retainAutomaticBackups":3}\n' "$uid" "$gid" "$enable" > "$root/management/config.json")
# Use the old deployment lock while disabling its exact installed rule.
if $migrate; then
  if [[ -f $unit/stardust-web-update.service && ! -L $unit/stardust-web-update.service ]] &&
    grep -Fq '/usr/local/lib/stardust-updater/web-update.mjs' "$unit/stardust-web-update.service"; then
    if systemctl is-active --quiet stardust-web-update.service; then fail '旧 WebUI 更新仍在运行。'; fi
    systemctl disable stardust-web-update.service
    mv -- "$unit/stardust-web-update.service" "$root/management/private/legacy-web-update.service"
  fi
  old_rule=/etc/sudoers.d/stardust-web-update
  if [[ -f $old_rule && ! -L $old_rule ]] && grep -Fxq 'stardust ALL=(root) NOPASSWD: /usr/bin/systemctl start --no-block stardust-web-update.service' "$old_rule" &&
    [[ $(wc -l < "$old_rule") == 1 ]]; then
    mv -- "$old_rule" "$root/management/private/legacy-sudoers"
  fi
  old_drop="$unit/stardust.service.d/web-update.conf"
  if [[ -f $old_drop && ! -L $old_drop ]] && cmp -s "$old_drop" <(printf '[Service]\nEnvironment=STARDUST_WEB_UPDATE_ENABLED=1\n'); then
    mv -- "$old_drop" "$root/management/private/legacy-web-update.conf"
  fi
else
  cat > "$unit/stardust.service" <<EOF
[Unit]
Description=Stardust
After=network.target
[Service]
User=stardust
Group=stardust
WorkingDirectory=$root/current
Environment=STARDUST_STORAGE_ROOT=$root/shared
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
ExecStart=$node --experimental-sqlite apps/server/dist/main.js
KillMode=control-group
Delegate=no
Restart=on-failure
[Install]
WantedBy=multi-user.target
EOF
fi
install -d -m 0755 "$unit/stardust.service.d"
printf '[Service]\nRuntimeDirectory=stardust-core\nRuntimeDirectoryMode=0700\nEnvironment=STARDUST_MANAGED_ENDPOINT=1\nEnvironment=STARDUST_MANAGEMENT_ENABLED=%s\n' "$($enable && printf 1 || printf 0)" > "$unit/stardust.service.d/lifecycle.conf"
cat > "$unit/stardust-lifecycle.path" <<EOF
[Unit]
Description=Watch Stardust management requests
[Path]
PathExists=$root/management/inbox/request.json
[Install]
WantedBy=multi-user.target
EOF
cat > "$unit/stardust-lifecycle.service" <<EOF
[Unit]
Description=Stardust Lifecycle Manager
[Service]
Type=oneshot
UMask=0077
TimeoutStartSec=3h
ExecStart=/usr/bin/flock --no-fork $root/management/private/lock $node $code/manage.mjs consume
ExecStopPost=/usr/bin/flock --no-fork $root/management/private/lock $node $code/manage.mjs interrupted
EOF
systemctl daemon-reload
/usr/bin/flock --no-fork "$root/management/private/lock" "$node" "$code/manage.mjs" install
systemctl enable stardust.service
if $enable; then systemctl enable --now stardust-lifecycle.path; fi
printf 'Stardust 已安装。请在可信网络中打开 http://服务器IP/，已有实例沿用原地址。\n'
