#!/usr/bin/env bash
# ============================================================================
# PILOT 安装脚本 —— unix 薄壳（Task 21：跨平台安装逻辑已迁移到 install.mjs）
#
# 本脚本只做一件事：找到 node，转手调用同目录的 install.mjs，透传全部参数。
# macOS / Linux 用户可以继续用惯的 `./install.sh`；Windows 用户没有 bash，
# 直接 `node install.mjs` 即可（见 README「三步安装」的 Windows 分支）。
#
# 用法：
#   ./install.sh              正常安装
#   ./install.sh --dry-run    只打印将要执行的动作，不落任何改动
#   ./install.sh --skip-deps  跳过 npm install / playwright 下载（离线或调试用）
#   ./install.sh --with-video 同时一键安装 yt-dlp/ffmpeg（跨平台静态二进制）
#   ./install.sh --yes        --with-video 等交互式确认全部默认 yes
#
# 全部实际逻辑见 install.mjs 顶部注释。
# ============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "[pilot-install] 错误：缺少 node，请安装 Node.js >= 20（https://nodejs.org）" >&2
  echo "[pilot-install] error: node not found, please install Node.js >= 20 (https://nodejs.org)" >&2
  exit 1
fi

exec node "$SCRIPT_DIR/install.mjs" "$@"
