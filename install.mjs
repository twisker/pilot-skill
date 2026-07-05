#!/usr/bin/env node
// ============================================================================
// PILOT 安装脚本（跨平台，Node 单文件） / PILOT installer (cross-platform, single Node file)
//
// 用法 / usage：
//   node install.mjs                正常安装 / normal install
//   node install.mjs --dry-run      只打印将要执行的动作，不落任何改动 / print planned actions only
//   node install.mjs --skip-deps    跳过 npm install / playwright 下载 / skip npm install & playwright download
//   node install.mjs --with-video   同时一键安装 yt-dlp/ffmpeg（跨平台静态二进制）/ also install video deps
//   node install.mjs --yes          --with-video 等交互式确认全部默认 yes（非交互环境用）/ auto-yes for prompts
//
// 支持平台 / supported platforms：macOS (darwin) / Linux / Windows (win32)。
// Windows 下用户可 clone 后直接 `node install.mjs` 运行，无需 bash / WSL。
// On Windows, clone the repo then run `node install.mjs` directly — no bash/WSL needed.
//
// 安装动作 / install actions：
//   1. 检查依赖：node >= 20、git / Check deps: node >= 20, git
//   2. 部署本仓内容到 ~/.pilot/app（若本仓已 clone 在该位置则原地使用）
//      Deploy repo content to ~/.pilot/app (or use in place if already cloned there)
//   3. cd <app>/tools && npm install && npx playwright install chromium
//   4. 注册 Skill：unix 用 symlink；Windows 无特权时用目录 junction（不需要管理员），
//      两者都失败则退化为整份复制 + 提示后续更新方式
//      Register skill: symlink on unix; directory junction on Windows (no admin
//      required); falls back to a plain copy (with an update-instructions note)
//      if both fail.
//   5. 可选 --with-video：一键装 yt-dlp/ffmpeg 静态二进制到 ~/.pilot/bin
//      Optional --with-video: one-shot install yt-dlp/ffmpeg static binaries
//   6. 打印后续步骤 / print next steps
//
// 路径覆盖（一般无需使用；测试注入用）/ path overrides (test injection only)：
//   PILOT_APP_DIR      默认 <homedir>/.pilot/app
//   CLAUDE_SKILLS_DIR  默认 <homedir>/.claude/skills
// ============================================================================

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  copyFileSync,
  rmSync,
  symlinkSync,
  lstatSync,
  readlinkSync,
  unlinkSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PLATFORM = process.platform; // "darwin" | "linux" | "win32" | ...
const HOME = os.homedir();

const APP_DIR = process.env.PILOT_APP_DIR || path.join(HOME, ".pilot", "app");
const SKILLS_DIR = process.env.CLAUDE_SKILLS_DIR || path.join(HOME, ".claude", "skills");
const REPO_DIR = __dirname;

// ---------------------------------------------------------------------------
// CLI 参数 / args
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const flags = { dryRun: false, skipDeps: false, withVideo: false, yes: false, help: false };
  for (const arg of argv) {
    if (arg === "--dry-run") flags.dryRun = true;
    else if (arg === "--skip-deps") flags.skipDeps = true;
    else if (arg === "--with-video") flags.withVideo = true;
    else if (arg === "--yes" || arg === "-y") flags.yes = true;
    else if (arg === "-h" || arg === "--help") flags.help = true;
    else if (arg === "") continue;
    else throw new InstallError(`未知参数: ${arg}（支持 --dry-run/--skip-deps/--with-video/--yes）`, `unknown argument: ${arg}`);
  }
  return flags;
}

export class InstallError extends Error {
  constructor(zh, en) {
    super(`${zh} / ${en}`);
    this.zh = zh;
    this.en = en;
  }
}

function log(msg) {
  console.log(`[pilot-install] ${msg}`);
}

function plan(dryRun, msg) {
  console.log(`[pilot-install] ${dryRun ? "(dry-run) " : ""}${msg}`);
}

function fail(zh, en) {
  console.error(`[pilot-install] 错误 / error：${zh} / ${en}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 1. 依赖检查 / dependency check
// ---------------------------------------------------------------------------

function commandVersion(cmd, args) {
  const result = spawnSync(cmd, args, { encoding: "utf-8", shell: PLATFORM === "win32" });
  if (result.status !== 0 || result.error) return null;
  return (result.stdout || "").trim();
}

export function checkPrerequisites({ platform = PLATFORM } = {}) {
  const problems = [];

  const gitVersion = commandVersion("git", ["--version"]);
  if (!gitVersion) {
    problems.push({
      zh: "缺少 git，请先安装（https://git-scm.com）",
      en: "git not found, please install it first (https://git-scm.com)",
    });
  }

  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (!(nodeMajor >= 20)) {
    problems.push({
      zh: `Node.js 版本过低（当前 ${process.version}，需要 >= 20）`,
      en: `Node.js version too low (current ${process.version}, need >= 20)`,
    });
  }

  return { ok: problems.length === 0, problems, nodeVersion: process.version, gitVersion, platform };
}

// ---------------------------------------------------------------------------
// 2. 部署到 ~/.pilot/app（跨平台递归同步，替代 rsync --delete）
//    Deploy to ~/.pilot/app (cross-platform recursive sync, replaces rsync --delete)
// ---------------------------------------------------------------------------

const SYNC_EXCLUDES = new Set([".git", "node_modules", ".env"]);

function realpathOrSelf(p) {
  try {
    return path.resolve(p);
  } catch {
    return p;
  }
}

/**
 * 递归同步 src → dest：拷贝 src 独有/更新的文件，删除 dest 中 src 没有的多余文件
 * （SYNC_EXCLUDES 内的目录/文件名永远跳过，保留用户已有的 node_modules/.env，
 * 不管它们出现在哪一层——例如 tools/node_modules 是 npm install 在子目录里
 * 产生的，并非仓库根）。
 *
 * 修复记录（Task 21 review Important）：早期实现只在 isRoot（递归第一层，即
 * APP_DIR 顶层）生效排除，进入子目录递归后 isRoot 变 false，排除判断被跳过。
 * 结果是 tools/node_modules（比根深一层）在「删除 dest 多余文件」那一步被当作
 * 「src 没有所以是多余文件」直接 rmSync 删掉；而 --skip-deps 重跑 install 又
 * 不会重新 npm install，用户会发现依赖凭空消失且无法自愈。现在排除判断按
 * 「目录/文件基础名匹配」在任意深度都生效，isRoot 参数随之废弃。
 */
export function syncDir(src, dest, { dryRun = false, excludes = SYNC_EXCLUDES } = {}) {
  if (!dryRun) mkdirSync(dest, { recursive: true });
  const srcEntries = new Set();

  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (excludes.has(entry.name)) continue;
    srcEntries.add(entry.name);
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      if (!dryRun) syncDir(srcPath, destPath, { dryRun, excludes });
    } else if (entry.isFile()) {
      if (!dryRun) {
        mkdirSync(path.dirname(destPath), { recursive: true });
        copyFileSync(srcPath, destPath);
      }
    }
  }

  if (existsSync(dest) && !dryRun) {
    for (const entry of readdirSync(dest, { withFileTypes: true })) {
      if (excludes.has(entry.name)) continue;
      if (!srcEntries.has(entry.name)) {
        rmSync(path.join(dest, entry.name), { recursive: true, force: true });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 4. 注册 Skill：symlink（unix）/ junction（win32 无需管理员）/ 复制降级
//    Register skill: symlink (unix) / junction (win32, no admin) / copy fallback
// ---------------------------------------------------------------------------

function copyRecursive(src, dest) {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) copyRecursive(srcPath, destPath);
    else copyFileSync(srcPath, destPath);
  }
}

/**
 * 返回注册方式与理由（纯逻辑，便于单测；实际 fs 操作在 registerSkill 里做）。
 */
export function skillRegistrationStrategy(platform = PLATFORM) {
  if (platform === "win32") return ["junction", "copy"]; // 依次尝试
  return ["symlink", "copy"];
}

export function registerSkill({ appDir = APP_DIR, skillsDir = SKILLS_DIR, platform = PLATFORM, dryRun = false } = {}) {
  const target = path.join(appDir, "skill");
  const link = path.join(skillsDir, "pilot");
  const strategies = skillRegistrationStrategy(platform);

  plan(dryRun, `注册 Skill / register skill：${link} → ${target}（尝试顺序 / try order: ${strategies.join(" → ")}）`);
  if (dryRun) return { method: "dry-run" };

  mkdirSync(skillsDir, { recursive: true });

  // 已存在的旧注册：symlink/junction 直接删；普通目录/文件备份
  if (existsSync(link) || (() => { try { lstatSync(link); return true; } catch { return false; } })()) {
    try {
      const st = lstatSync(link);
      if (st.isSymbolicLink()) {
        unlinkSync(link);
      } else {
        const backup = `${link}.bak.${Date.now()}`;
        log(`已存在非 symlink/junction 的 ${link}，备份为 ${backup} / existing non-link path backed up to ${backup}`);
        rmSync(backup, { recursive: true, force: true });
        copyRecursive(link, backup);
        rmSync(link, { recursive: true, force: true });
      }
    } catch {
      // link 不存在，忽略
    }
  }

  for (const method of strategies) {
    try {
      if (method === "symlink") {
        symlinkSync(target, link, "dir");
      } else if (method === "junction") {
        symlinkSync(target, link, "junction");
      } else if (method === "copy") {
        copyRecursive(target, link);
        log(
          "已用【复制】方式注册 skill（symlink/junction 均不可用，常见于受限权限环境）。" +
            "以后仓库更新需要重新运行 node install.mjs 以同步最新内容，不会像 symlink 那样自动跟随。" +
            " / Skill registered by COPYING files (symlink/junction unavailable). " +
            "Future updates require re-running `node install.mjs`; it will not auto-follow repo changes like a symlink.",
        );
      }
      return { method };
    } catch (err) {
      log(`${method} 注册失败（${err.message}），尝试下一种方式 / ${method} failed, trying next strategy`);
    }
  }
  fail("Skill 注册全部方式均失败", "all skill registration strategies failed");
}

// ---------------------------------------------------------------------------
// 主流程 / main
// ---------------------------------------------------------------------------

function printHelp() {
  console.log(`PILOT 安装脚本 / PILOT installer

用法 / usage: node install.mjs [选项/options]

  --dry-run     只打印将要执行的动作 / print planned actions only
  --skip-deps   跳过 npm install / playwright 下载 / skip npm install & playwright download
  --with-video  一键安装 yt-dlp/ffmpeg 静态二进制 / one-shot install video deps
  --yes, -y     交互式确认全部默认 yes / auto-yes for interactive prompts
  -h, --help    显示本帮助 / show this help
`);
}

async function promptYesNo(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${question} [y/N] `, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help) {
    printHelp();
    return;
  }

  log(`平台 / platform: ${PLATFORM}；安装位 / install dir: ${APP_DIR}`);

  // 1. 依赖检查
  log("检查依赖 / checking prerequisites ...");
  const check = checkPrerequisites();
  if (!check.ok) {
    for (const p of check.problems) fail(p.zh, p.en);
  }
  log(`node ${check.nodeVersion} / git ${check.gitVersion} OK`);

  for (const opt of ["yt-dlp", "ffmpeg"]) {
    if (!commandVersion(opt, [opt === "ffmpeg" ? "-version" : "--version"])) {
      log(
        `提示 / note：未检测到全局 ${opt}（可选，仅视频游记理解需要；可用 --with-video 一键安装，` +
          `或稍后手动运行 npx tsx tools/setup-video.ts install --yes）`,
      );
    }
  }

  // 2. 部署
  const repoReal = realpathOrSelf(REPO_DIR);
  const appReal = existsSync(APP_DIR) ? realpathOrSelf(APP_DIR) : path.resolve(APP_DIR);
  if (repoReal === appReal) {
    log(`本仓已位于安装位 ${APP_DIR}，原地使用（git pull 即可更新）/ already at install dir, using in place`);
  } else {
    plan(
      flags.dryRun,
      `复制仓库内容 → ${APP_DIR}（保留已存在的 .env / node_modules，不复制 .git）/ ` +
        `copy repo → ${APP_DIR} (.env/node_modules preserved, .git excluded)`,
    );
    syncDir(REPO_DIR, APP_DIR, { dryRun: flags.dryRun });
  }

  // 3. 安装 tools 依赖 + playwright chromium
  const toolsDir = path.join(APP_DIR, "tools");
  if (flags.skipDeps) {
    log("跳过依赖安装（--skip-deps）/ skipping dependency install (--skip-deps)");
  } else if (flags.dryRun) {
    plan(true, `cd ${toolsDir} && npm install && npx playwright install chromium`);
  } else {
    log("安装 tools 依赖（npm install）... / installing tools deps (npm install) ...");
    runOrFail("npm", ["install"], toolsDir, "npm install 失败", "npm install failed");
    log("下载 playwright chromium（首次约 150MB）... / downloading playwright chromium (first run ~150MB) ...");
    runOrFail(
      "npx",
      ["playwright", "install", "chromium"],
      toolsDir,
      "playwright chromium 下载失败",
      "playwright chromium download failed",
    );
  }

  // 4. 注册 Skill
  registerSkill({ dryRun: flags.dryRun });

  // 5. 可选：视频依赖一键安装
  if (!flags.dryRun && !flags.skipDeps) {
    let doVideo = flags.withVideo;
    if (!flags.withVideo && !flags.yes && process.stdin.isTTY) {
      doVideo = await promptYesNo(
        "是否现在一键安装视频依赖（yt-dlp/ffmpeg，用于 B 站等视频游记理解）？/ Install video deps (yt-dlp/ffmpeg) now?",
      );
    }
    if (doVideo) {
      log("安装视频依赖 / installing video deps ...");
      runOrFail(
        "npx",
        ["tsx", "setup-video.ts", "install", "--yes"],
        toolsDir,
        "视频依赖安装失败（不影响主链路，可稍后重跑 npx tsx tools/setup-video.ts install）",
        "video deps install failed (does not block main flow, retry later with `npx tsx tools/setup-video.ts install`)",
      );
    }
  } else if (flags.dryRun && (flags.withVideo || flags.yes)) {
    plan(true, `cd ${toolsDir} && npx tsx setup-video.ts install --yes`);
  }

  // 6. 后续步骤
  console.log();
  log("安装完成 / install complete。后续步骤 / next steps：");
  console.log(`
  1) 配置地图 key（可选但推荐）/ configure map key (optional, recommended)：
       在 ${path.join(APP_DIR, ".env")} 写入一行 / add this line：
       TIANDITU_KEY=<你的天地图浏览器端 key / your Tianditu browser-side key>
     申请地址 / apply at：https://console.tianditu.gov.cn/ （免费 / free）

  2) 导出站点 cookie（可选，大幅提升游记抓取成功率）/ export site cookies (optional, improves scraping success rate)：
       npx tsx ${path.join(APP_DIR, "tools", "cookies.ts")} setup

  3) 开始使用 / start using：新开一个 Claude Code 会话，输入 / open a new Claude Code session and type：
       /pilot 十一云南自驾 6 天，两大人带娃
`);
}

function runOrFail(cmd, args, cwd, zh, en) {
  const result = spawnSync(cmd, args, { cwd, stdio: "inherit", shell: PLATFORM === "win32" });
  if (result.status !== 0 || result.error) {
    fail(zh, en);
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isMain) {
  main().catch((err) => {
    if (err instanceof InstallError) {
      fail(err.zh, err.en);
    } else {
      fail(err.message, err.message);
    }
  });
}
