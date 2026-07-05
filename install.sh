#!/usr/bin/env bash
# ============================================================================
# PILOT 安装脚本
#
# 用法：
#   ./install.sh              正常安装
#   ./install.sh --dry-run    只打印将要执行的动作，不落任何改动
#   ./install.sh --skip-deps  跳过 npm install / playwright 下载（离线或调试用）
#
# 安装动作：
#   1. 检查依赖：node >= 20、npm、git（yt-dlp / ffmpeg 可选，仅视频轮需要）
#   2. 部署本仓内容到 ~/.pilot/app（若本仓已 clone 在 ~/.pilot/app 则原地使用）
#   3. cd ~/.pilot/app/tools && npm install && npx playwright install chromium
#   4. 注册 Skill：symlink ~/.claude/skills/pilot → ~/.pilot/app/skill
#   5. 打印后续步骤（.env 配 TIANDITU_KEY、cookie 导出、/pilot 试用）
#
# 路径覆盖（一般无需使用；测试注入用）：
#   PILOT_APP_DIR      默认 $HOME/.pilot/app
#   CLAUDE_SKILLS_DIR  默认 $HOME/.claude/skills
# ============================================================================
set -euo pipefail

APP_DIR="${PILOT_APP_DIR:-$HOME/.pilot/app}"
SKILLS_DIR="${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

DRY_RUN=0
SKIP_DEPS=0
for arg in "${@:-}"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --skip-deps) SKIP_DEPS=1 ;;
    -h|--help)
      sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    "") ;;
    *) echo "未知参数: $arg（支持 --dry-run / --skip-deps）" >&2; exit 1 ;;
  esac
done

log()  { echo "[pilot-install] $*"; }
plan() { if [[ $DRY_RUN -eq 1 ]]; then echo "[pilot-install] (dry-run) $*"; else echo "[pilot-install] $*"; fi; }
fail() { echo "[pilot-install] 错误：$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# 1. 依赖检查
# ---------------------------------------------------------------------------
log "检查依赖 ..."
command -v git  >/dev/null 2>&1 || fail "缺少 git，请先安装（https://git-scm.com）"
command -v node >/dev/null 2>&1 || fail "缺少 node，请安装 Node.js >= 20（https://nodejs.org）"
command -v npm  >/dev/null 2>&1 || fail "缺少 npm（随 Node.js 一起安装）"

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[[ "$NODE_MAJOR" -ge 20 ]] || fail "Node.js 版本过低（当前 $(node -v)，需要 >= 20）"
log "node $(node -v) / npm $(npm -v) / git OK"

for opt in yt-dlp ffmpeg; do
  if ! command -v "$opt" >/dev/null 2>&1; then
    log "提示：未安装 $opt（可选，仅视频游记理解需要；macOS 可 brew install $opt）"
  fi
done

# ---------------------------------------------------------------------------
# 2. 部署到 ~/.pilot/app
# ---------------------------------------------------------------------------
REPO_REAL="$(cd "$REPO_DIR" && pwd -P)"
if [[ -d "$APP_DIR" ]]; then
  APP_REAL="$(cd "$APP_DIR" && pwd -P)"
else
  APP_REAL="$APP_DIR"
fi

if [[ "$REPO_REAL" == "$APP_REAL" ]]; then
  log "本仓已位于安装位 ${APP_DIR}，原地使用（git pull 即可更新）"
else
  plan "复制仓库内容 → ${APP_DIR}（保留已存在的 .env / node_modules，不复制 .git）"
  if [[ $DRY_RUN -eq 0 ]]; then
    mkdir -p "$APP_DIR"
    rsync -a --delete \
      --exclude '.git/' \
      --exclude 'node_modules/' \
      --exclude '.env' \
      "$REPO_DIR/" "$APP_DIR/"
  fi
fi

# ---------------------------------------------------------------------------
# 3. 安装 tools 依赖 + playwright chromium
# ---------------------------------------------------------------------------
if [[ $SKIP_DEPS -eq 1 ]]; then
  log "跳过依赖安装（--skip-deps）"
elif [[ $DRY_RUN -eq 1 ]]; then
  plan "cd $APP_DIR/tools && npm install && npx playwright install chromium"
else
  log "安装 tools 依赖（npm install）..."
  (cd "$APP_DIR/tools" && npm install)
  log "下载 playwright chromium（抓取兜底 / PDF 导出用，首次约 150MB）..."
  (cd "$APP_DIR/tools" && npx playwright install chromium)
fi

# ---------------------------------------------------------------------------
# 4. 注册 Skill：~/.claude/skills/pilot → ~/.pilot/app/skill
# ---------------------------------------------------------------------------
SKILL_LINK="$SKILLS_DIR/pilot"
plan "注册 Skill：symlink $SKILL_LINK → $APP_DIR/skill"
if [[ $DRY_RUN -eq 0 ]]; then
  mkdir -p "$SKILLS_DIR"
  if [[ -L "$SKILL_LINK" ]]; then
    rm "$SKILL_LINK"
  elif [[ -e "$SKILL_LINK" ]]; then
    BACKUP="$SKILL_LINK.bak.$(date +%Y%m%d%H%M%S)"
    log "已存在非 symlink 的 ${SKILL_LINK}，备份为 ${BACKUP}"
    mv "$SKILL_LINK" "$BACKUP"
  fi
  ln -s "$APP_DIR/skill" "$SKILL_LINK"
fi

# ---------------------------------------------------------------------------
# 5. 后续步骤
# ---------------------------------------------------------------------------
echo
log "安装完成。后续步骤："
cat <<EOF

  1) 配置地图 key（可选但推荐，地图视图底图用）：
       在 $APP_DIR/.env 写入一行：
       TIANDITU_KEY=<你的天地图浏览器端 key>
     申请地址：https://console.tianditu.gov.cn/ （免费）

  2) 导出站点 cookie（可选，大幅提升游记抓取成功率）：
       npx tsx ~/.pilot/app/tools/cookies.ts setup
     引导式登录马蜂窝/知乎/穷游/小红书/B站，cookie 只保存在本机
     ~/.pilot/cookies/，绝不上传。详见 docs/guide-cookies.md

  3) 开始使用：新开一个 Claude Code 会话，输入：
       /pilot 十一云南自驾 6 天，两大人带娃

EOF
