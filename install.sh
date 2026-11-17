#!/bin/bash
set -euo pipefail

# 安装 dsh-computer-use-pip 到本机 DSH desktop profile。
# 用法：./install.sh [profile]
# 说明：只改 ~/.dsh 下的 profile 登记与软链，不动 DSH 安装目录。

PROFILE="${1:-desktop}"
PROFILE_DIR="$HOME/.dsh/profiles/$PROFILE"
TARGET="$HOME/.dsh/tools/dsh-computer-use-pip/0.1.0"
SRC="$(cd "$(dirname "$0")" && pwd)"

if [ ! -d "$PROFILE_DIR" ]; then
  echo "找不到 profile 目录：$PROFILE_DIR" >&2
  exit 1
fi

echo "==> 构建原生小窗"
bash "$SRC/overlay/build.sh"

if [ "$SRC" != "$TARGET" ]; then
  echo "==> 复制插件到 $TARGET"
  mkdir -p "$(dirname "$TARGET")"
  rm -rf "$TARGET"
  mkdir -p "$TARGET"
  cp -R "$SRC/." "$TARGET/"
fi

echo "==> 登记到 profile"
node - "$PROFILE_DIR" "$TARGET" <<'NODE'
const fs = require('fs')
const path = require('path')
const [profileDir, target] = process.argv.slice(2)
const pkgPath = path.join(profileDir, 'package.json')
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
pkg.dependencies = pkg.dependencies || {}
pkg.dependencies['dsh-computer-use-pip'] = 'link:' + target
pkg.dsh = pkg.dsh || {}
pkg.dsh.profile = pkg.dsh.profile || {}
const bundles = (pkg.dsh.profile.bundles ||= [])
if (!bundles.includes('dsh-computer-use-pip')) bundles.push('dsh-computer-use-pip')
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
const link = path.join(profileDir, 'node_modules', 'dsh-computer-use-pip')
fs.mkdirSync(path.join(profileDir, 'node_modules'), { recursive: true })
try { fs.unlinkSync(link) } catch {}
fs.symlinkSync(path.relative(path.dirname(link), target), link)
console.log('registered dsh-computer-use-pip ->', target)
NODE

echo
echo "完成。⌘Q 退出 DSH 再打开即可生效。"
echo "状态目录：~/.dsh/computer-use-pip"
