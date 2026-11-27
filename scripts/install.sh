#!/usr/bin/env bash
set -Eeuo pipefail
original_path=${PATH:-}
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
root=/opt/stardust
code=/usr/local/lib/stardust-lifecycle
unit=/etc/systemd/system
enable=true
refresh=false
port=80
port_set=false
fail(){ printf '安装失败：%s\n' "$*" >&2; exit 1; }
trap 'printf "安装失败：执行安装步骤时出错（第 %s 行），请检查上方输出。\\n" "$LINENO" >&2' ERR
while (($#)); do
  case $1 in
    --refresh-manager) refresh=true ;;
    --enable-management) enable=true ;;
    --disable-management) enable=false ;;
    --port) shift; (($#)) || fail '--port 需要端口号。'; port=$1; port_set=true ;;
    --port=*) port=${1#*=}; port_set=true ;;
    *) fail '用法：sudo bash install.sh [--port 端口] [--disable-management] [--refresh-manager]' ;;
  esac
  shift
done
[[ $port =~ ^[0-9]{1,5}$ ]] && ((10#$port >= 1 && 10#$port <= 65535)) || fail '端口必须在 1–65535 之间。'
port=$((10#$port))
if $refresh && { ! $enable || $port_set; }; then fail '--refresh-manager 必须单独使用。'; fi
[[ $(id -u) == 0 && $(uname -s) == Linux && $(uname -m) == x86_64 ]] || fail '需要以管理员身份在 Debian 13 x86_64 上运行。'
[[ -r /etc/os-release ]] || fail '无法识别操作系统。'
. /etc/os-release
[[ ${ID:-} == debian && ${VERSION_ID:-} == 13 ]] || fail '当前仅支持 Debian 13 x86_64。'
printf 'Stardust 安装将信任官方 GitHub Releases；软件管理启用后，管理员代码以 root 运行。\n'
printf '如缺少依赖，将从 Debian 软件源安装；如需 Node.js，将从 nodejs.org 下载官方运行环境。\n'
if ! $refresh && { [[ -e $root || -L $root || -e $code || -L $code || -e $unit/stardust.service || -L $unit/stardust.service ]]; }; then
  if [[ -f $root/management/config.json && -f $code/manage.mjs && -f $unit/stardust.service ]]; then
    printf '检测到已有 Stardust 安装，现有数据和配置未更改。请在 WebUI 中更新。\n数据位置：%s/shared\n' "$root"
    exit 0
  fi
  fail '检测到不完整或非标准的已有安装；请先检查现有文件和服务，安装器不会覆盖。'
fi
[[ -r /proc/1/comm ]] || fail '无法检查系统启动方式。'
read -r init_name < /proc/1/comm
[[ $init_name == systemd ]] || fail '系统未以 systemd 启动，请先启用 systemd。'
printf '[1/4] 检查运行环境…\n'
missing_packages=()
for pair in python3:python3 flock:util-linux getent:libc-bin useradd:passwd sha256sum:coreutils systemctl:systemd; do
  cmd=${pair%%:*}; package=${pair#*:}
  command -v "$cmd" >/dev/null || missing_packages+=("$package")
done
[[ -e /etc/ssl/certs/ca-certificates.crt ]] || missing_packages+=(ca-certificates)
if ((${#missing_packages[@]})); then
  command -v apt-get >/dev/null || fail '缺少 apt-get，无法安装系统依赖。'
  printf '正在安装缺少的系统依赖…\n'
  DEBIAN_FRONTEND=noninteractive apt-get update || fail '无法更新 Debian 软件源，请检查网络及软件源。'
  DEBIAN_FRONTEND=noninteractive apt-get install -y "${missing_packages[@]}" || fail '系统依赖安装失败，请检查上方 apt 错误。'
fi
systemctl show --property=Version --value >/dev/null 2>&1 || fail '无法连接 systemd，请检查系统服务。'
safe_path(){
  local p=$1
  while [[ $p != / ]]; do
    [[ ! -L $p && $(stat -c %u "$p") == 0 && $(( 8#$(stat -c %a "$p") & 0022 )) == 0 ]] || return 1
    p=$(dirname -- "$p")
  done
}
for p in /opt /usr/local /usr/local/lib /etc/systemd/system; do safe_path "$p" || fail "管理员控制的路径不安全：$p"; done
node=''
for candidate_path in "$(PATH="$original_path" type -P node || :)" "$(type -P node || :)"; do
  [[ -n $candidate_path ]] || continue
  candidate=$(readlink -f "$candidate_path" || :)
  if [[ $candidate =~ ^/[a-zA-Z0-9_./-]+$ ]] && safe_path "$candidate" && [[ $("$candidate" -p 'process.versions.node.split(".")[0]' 2>/dev/null || :) == 24 ]]; then node=$candidate; break; fi
done
if [[ -z $node ]] && [[ -e /usr/local/lib/stardust-node24 || -L /usr/local/lib/stardust-node24 ]]; then
  candidate=$(readlink -f /usr/local/lib/stardust-node24/bin/node || :)
  [[ $candidate =~ ^/[a-zA-Z0-9_./-]+$ ]] && safe_path "$candidate" && [[ $("$candidate" -p 'process.versions.node.split(".")[0]' 2>/dev/null || :) == 24 ]] || fail '现有 Stardust 运行环境不安全或不兼容，请检查 /usr/local/lib/stardust-node24。'
  node=$candidate
fi
if [[ -z $node ]]; then
  printf '正在准备 Stardust 运行环境…\n'
  node_packages=()
  for pair in curl:curl xz:xz-utils tar:tar; do
    cmd=${pair%%:*}; package=${pair#*:}
    command -v "$cmd" >/dev/null || node_packages+=("$package")
  done
  if ((${#node_packages[@]})); then
    command -v apt-get >/dev/null || fail '缺少 apt-get，无法安装运行环境所需依赖。'
    DEBIAN_FRONTEND=noninteractive apt-get update || fail '无法更新 Debian 软件源，请检查网络及软件源。'
    DEBIAN_FRONTEND=noninteractive apt-get install -y "${node_packages[@]}" || fail '运行环境依赖安装失败，请检查上方 apt 错误。'
  fi
  node_stage=$(mktemp -d /usr/local/lib/.stardust-node-XXXXXXXX)
  curl -fsSL --proto '=https' --proto-redir '=https' --retry 3 --connect-timeout 20 --max-time 120 https://nodejs.org/dist/index.json -o "$node_stage/index.json" || fail '无法下载运行环境版本列表，请检查网络。'
  node_version=$(python3 -c 'import json,re,sys; data=json.load(open(sys.argv[1])); print(next(x["version"] for x in data if re.fullmatch(r"v24\.[0-9]+\.[0-9]+",x.get("version", "")) and "linux-x64" in x.get("files",[])))' "$node_stage/index.json") || fail '无法确定受支持的运行环境版本。'
  node_archive="node-$node_version-linux-x64.tar.xz"
  curl -fsSL --proto '=https' --proto-redir '=https' --retry 3 --connect-timeout 20 --max-time 120 "https://nodejs.org/dist/$node_version/SHASUMS256.txt" -o "$node_stage/SHASUMS256.txt" || fail '无法获取运行环境校验信息。'
  curl -fsSL --proto '=https' --proto-redir '=https' --retry 3 --connect-timeout 20 --max-time 600 "https://nodejs.org/dist/$node_version/$node_archive" -o "$node_stage/$node_archive" || fail '无法下载运行环境，请检查网络。'
  expected=$(awk -v name="$node_archive" '$2==name {print $1}' "$node_stage/SHASUMS256.txt")
  [[ $expected =~ ^[0-9a-f]{64}$ ]] || fail '运行环境校验信息无效。'
  actual=$(sha256sum "$node_stage/$node_archive"); [[ ${actual%% *} == "$expected" ]] || fail '运行环境校验失败。'
  tar -xJf "$node_stage/$node_archive" -C "$node_stage" --no-same-owner || fail '运行环境解压失败。'
  [[ $("$node_stage/node-$node_version-linux-x64/bin/node" -p 'process.versions.node.split(".")[0]' 2>/dev/null || :) == 24 ]] || fail '下载的运行环境不可用。'
  mv -T "$node_stage/node-$node_version-linux-x64" /usr/local/lib/stardust-node24 || fail '无法安装运行环境。'
  node=/usr/local/lib/stardust-node24/bin/node
  rm -f -- "$node_stage/index.json" "$node_stage/SHASUMS256.txt" "$node_stage/$node_archive"; rmdir -- "$node_stage"
fi
safe_path "$node" || fail '运行环境文件权限不安全。'
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
  stage=$(mktemp -d /usr/local/lib/.stardust-lifecycle-XXXXXXXX)
  write_manager "$stage"
  chmod 0755 "$stage"
  for file in manage.mjs files.mjs running-port.mjs; do "$node" --check "$stage/$file"; done
  "$node" --input-type=module -e 'import {pathToFileURL} from "node:url"; import {join} from "node:path"; await import(pathToFileURL(join(process.argv[1],"manage.mjs")).href)' "$stage"
  /usr/bin/python3 -I -c 'import runpy,sys; assert callable(runpy.run_path(sys.argv[1])["exchange"])' "$stage/archive.py"
  /usr/bin/python3 -I -c 'import os,sys; p=sys.argv[1]; names=("manage.mjs","files.mjs","running-port.mjs","archive.py"); [(lambda fd: (os.fsync(fd),os.close(fd)))(os.open(os.path.join(p,n),os.O_RDONLY)) for n in names]; fd=os.open(p,os.O_RDONLY|os.O_DIRECTORY); os.fsync(fd); os.close(fd)' "$stage"
  # Exchange whole directories; stage becomes the retained previous manager.
  /usr/bin/python3 -I "$stage/archive.py" exchange "$code" "$stage" -
  /usr/bin/python3 -I -c 'import os; fd=os.open("/usr/local/lib",os.O_RDONLY|os.O_DIRECTORY); os.fsync(fd); os.close(fd)'
  # Repair status written by older managers under UMask=0077, while holding the lock.
  status_file=$root/management/status.json
  if [[ -e $status_file || -L $status_file ]]; then
    [[ ! -L $status_file && -f $status_file && $(stat -c '%u:%h' "$status_file") == 0:1 ]] || fail '状态文件不安全，请检查后重试。'
    chgrp stardust "$status_file"
    chmod 0640 "$status_file"
  fi
  printf '生命周期管理器已更新，现有 Core 及数据保持原样。\n'
  exit 0
fi
printf '[2/4] 检查端口并准备安装…\n'
python3 - "$port" <<'PYPORT' || fail "端口 $port 已被占用或不可用，请使用 --port 指定其他端口。"
import errno, socket, sys
port = int(sys.argv[1])
sockets = []
for family, address in ((socket.AF_INET, ('0.0.0.0', port)), (socket.AF_INET6, ('::', port))):
    try:
        sock = socket.socket(family, socket.SOCK_STREAM)
        if family == socket.AF_INET6:
            sock.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
        sock.bind(address)
        sockets.append(sock)
    except OSError as error:
        if family == socket.AF_INET6 and error.errno in (errno.EAFNOSUPPORT, errno.EPROTONOSUPPORT, errno.EADDRNOTAVAIL):
            continue
        raise
PYPORT
! getent passwd stardust >/dev/null && ! getent group stardust >/dev/null || fail '用户或组 stardust 已存在。'
useradd --system --user-group --no-create-home --shell /usr/sbin/nologin stardust
install -d -o root -g root -m 0755 "$root" "$root/releases"
install -d -o root -g root -m 0700 "$root/backups"
install -d -o stardust -g stardust -m 0700 "$root/shared"
if $port_set; then
  (umask 077; printf '[server]\nport = %s\n' "$port" > "$root/shared/config.toml")
  chown stardust:stardust "$root/shared/config.toml"
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
printf '[3/4] 安装 Stardust…\n'
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
local_release=false
if [[ -n ${STARDUST_INSTALLER_SHA:-} && -f $source_dir/stardust-linux-x64.tar.gz && -f $source_dir/stardust-release.json && -f $source_dir/SHA256SUMS ]]; then
  printf '发现同目录发行包，正在校验…\n'
  [[ $(stat -c %s "$source_dir/stardust-linux-x64.tar.gz") == "$STARDUST_INSTALLER_SIZE" && $STARDUST_INSTALLER_SIZE =~ ^[0-9]+$ && $STARDUST_INSTALLER_SIZE -le 2147483648 ]] || fail '本地发行包大小不正确。'
  local_dir=$root/management/private/install-release
  install -d -o root -g root -m 0700 "$local_dir"
  for file in stardust-linux-x64.tar.gz stardust-release.json SHA256SUMS; do
    [[ -f $source_dir/$file && ! -L $source_dir/$file ]] || fail '本地发行文件不安全。'
    install -o root -g root -m 0600 "$source_dir/$file" "$local_dir/$file" || fail '无法复制本地发行文件。'
  done
  python3 - "$local_dir" "$STARDUST_INSTALLER_SHA" "$STARDUST_INSTALLER_SEQUENCE" "$STARDUST_INSTALLER_DIGEST" "$STARDUST_INSTALLER_SIZE" <<'PYLOCAL' || fail '本地发行包与安装器不匹配或校验失败。'
import hashlib, json, pathlib, re, sys
p, sha, sequence, expected, size = sys.argv[1:]
p = pathlib.Path(p)
manifest = json.loads((p / 'stardust-release.json').read_text())
lines = (p / 'SHA256SUMS').read_text().splitlines()
if not re.fullmatch(r'[a-f0-9]{64}', expected) or lines != [expected + '  stardust-linux-x64.tar.gz']:
    raise ValueError('INVALID_CHECKSUM_FILE')
archive = p / 'stardust-linux-x64.tar.gz'
hash_ = hashlib.sha256()
with archive.open('rb') as stream:
    for chunk in iter(lambda: stream.read(1024 * 1024), b''):
        hash_.update(chunk)
if manifest.get('sha') != sha or manifest.get('sequence') != int(sequence) or manifest.get('archive') != archive.name or manifest.get('size') != int(size) or manifest.get('sha256') != expected or archive.stat().st_size != int(size) or hash_.hexdigest() != expected:
    raise ValueError('INVALID_LOCAL_RELEASE')
PYLOCAL
  local_release=true
fi
if $local_release; then
  STARDUST_INSTALL_LOCAL=1 STARDUST_INSTALL_SHA="$STARDUST_INSTALLER_SHA" STARDUST_INSTALL_SEQUENCE="$STARDUST_INSTALLER_SEQUENCE" STARDUST_INSTALL_DIGEST="$STARDUST_INSTALLER_DIGEST" STARDUST_INSTALL_SIZE="$STARDUST_INSTALLER_SIZE" /usr/bin/flock --no-fork "$root/management/private/lock" "$node" "$code/manage.mjs" install || fail '安装发行包失败，请检查上方错误及服务日志。'
  rm -f -- "$local_dir/stardust-linux-x64.tar.gz" "$local_dir/stardust-release.json" "$local_dir/SHA256SUMS"
  rmdir -- "$local_dir"
else
  /usr/bin/flock --no-fork "$root/management/private/lock" "$node" "$code/manage.mjs" install || fail '下载或安装发行包失败，请检查网络及服务日志。'
fi
printf '[4/4] 启动服务…\n'
systemctl enable stardust.service || fail '无法启用 Stardust 服务。'
if $enable; then systemctl enable --now stardust-lifecycle.path || fail '无法启用软件管理。'; fi
systemctl is-active --quiet stardust.service || fail 'Stardust 服务未能启动，请检查服务日志及端口占用。'
installed_version=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$root/current/version.json")
address=$(hostname -I 2>/dev/null || :); address=${address%% *}; address=${address:-127.0.0.1}
[[ $address == *:* ]] && address="[$address]"
printf '安装完成。\nStardust 版本：%s\n服务状态：运行中\nWebUI：http://%s:%s/\n数据位置：%s/shared\n' "$installed_version" "$address" "$port" "$root"
