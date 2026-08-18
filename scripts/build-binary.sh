#!/bin/bash
# 构建 linear-cli 单文件二进制 + tar.gz 发布物。
#
# 发布物布局（解压后）：
#   linear                        # bun 编译的单文件二进制（含运行时，无需 Node）
#   skills/linear-cli/SKILL.md    # Agent 技能源，二进制从旁边读取
#
# 依赖：bun >= 1.4.0（1.3.x stable 编译产物在 macOS 27 上会 SIGKILL；
#       请用 `bun upgrade` 更新到 canary/1.4+）。
#
# 用法：./scripts/build-binary.sh          # 本机构架
#       ARCH=x86_64 ./scripts/build-binary.sh   # 交叉编译 Intel（需 bun 支持）
set -euo pipefail
cd "$(dirname "$0")/.."

BUN="${BUN:-$HOME/.bun/bin/bun}"
ARCH="${ARCH:-$(uname -m)}"

case "$ARCH" in
  arm64)  TARGET="bun-darwin-arm64" ;;
  x86_64) TARGET="bun-darwin-x64" ;;
  *) echo "unsupported arch: $ARCH (use arm64 or x86_64)" >&2; exit 1 ;;
esac

VERSION="$(node -p "require('./package.json').version")"
echo "==> linear-cli v$VERSION  target=$TARGET"

rm -rf dist-bin
mkdir -p dist-bin/staging/skills/linear-cli

"$BUN" build src/cli.ts --compile \
  --target="$TARGET" \
  --define=BUILD_VERSION="\"$VERSION\"" \
  --outfile dist-bin/staging/linear

cp skills/linear-cli/SKILL.md dist-bin/staging/skills/linear-cli/SKILL.md

tar -czf "dist-bin/linear-$ARCH.tar.gz" -C dist-bin/staging .

echo "==> OK: dist-bin/linear-$ARCH.tar.gz"
ls -lh dist-bin/linear-$ARCH.tar.gz
