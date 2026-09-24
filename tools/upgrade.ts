import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { downloadFile, downloadText } from "./setup-video";
import {
  RELEASES_API,
  RELEASE_PUBKEY_B64,
  isNewer,
  isPubkeyConfigured,
  normalizeVersion,
  pickReleaseAssets,
  verifyRelease,
  type ReleaseAsset,
} from "./lib/release";

// ---------------------------------------------------------------------------
// PILOT upgrade.ts —— 自升级编排（v5.0 红线 6 + UX 红线「禁止静默长跑」）
//
// 用法：
//   npx tsx tools/upgrade.ts check              # 只查版本，打印结果，exit 0
//   npx tsx tools/upgrade.ts run [--yes] [--check-only]
//
// 安全顺序（硬性约束，不得调换）：
//   查新版本 → 公钥未接线则**不下载**直接降级 → 下载 → Ed25519 验签 →
//   解压到临时目录 → 校验 VERSION + skill/SKILL.md → 迁移用户状态
//   （.env / tools/node_modules，rename 不复制）→ 改名交换 → 校验新版可读 →
//   失败回滚 → 清理旧 .prev
//
// 「替换」= 改名而非覆盖删除：
//   ~/.pilot/app → ~/.pilot/app.prev-<旧版本>
//   <tmp>/new    → ~/.pilot/app
// 任何一步失败都能退回旧版；用户状态按原相对路径搬回原位。
//
// 安装拓扑（见公开仓 install.mjs）：
//   ~/.pilot/app/{skill,tools,shared,config,VERSION}
//   ~/.claude/skills/pilot -> ~/.pilot/app/skill（路径不变，无需重注册）
// install.mjs 的 SYNC_EXCLUDES 保留用户 .env 与 tools/node_modules，故升级时
// **必须**把它们带到新目录，否则会丢掉天地图 key 与已装的 playwright/chromium。
//
// 降级策略（约束 4）：网络失败 / API 限流**不阻塞**调用方——打印提示 + 手动命令，
// exit 0。仅「验签失败 / 解压校验失败 / 交换失败」这类真实错误才 exit 1。
// ---------------------------------------------------------------------------

const UPGRADE_TMP_DIRNAME = ".upgrade-tmp";
const PREV_PREFIX = "app.prev-";
const FAILED_PREFIX = ".upgrade-failed-";

/** 用户状态（install.mjs 会跨版本保留的相对路径），升级时 rename 迁移到新目录 */
const USER_STATE_RELS = [".env", path.join("tools", "node_modules")];

export class CliError extends Error {}

/** tar 子进程 stdout/stderr 缓冲上限（发布包只有几 MB，64MB 足够且不至于失控） */
const TAR_MAX_BUFFER = 64 * 1024 * 1024;

export type UpgradeReason =
  | "upgraded"
  | "already-latest"
  | "check-only"
  | "pubkey-not-configured"
  | "network-error"
  | "download-failed";

export interface UpgradeResult {
  action: "check" | "run";
  local: string;
  remote: string | null;
  newer: boolean;
  upgraded: boolean;
  reason: UpgradeReason;
}

/** 可注入依赖（测试注入假下载/假目录，绝不触网、绝不碰真实 ~/.pilot） */
export interface UpgradeDeps {
  pilotHome?: string;
  downloadText?: (url: string) => Promise<string>;
  downloadFile?: (url: string, destPath: string) => Promise<void>;
  extract?: (tarballPath: string, destDir: string) => void;
  verify?: (tarball: Buffer, signatureB64: string, pubkeyRawB64: string) => boolean;
  /** 替换后校验钩子（默认校验 <app>/VERSION 可读且等于目标版本）；测试可注入失败以覆盖回滚 */
  verifyInstalled?: (appDir: string, expectedVersion: string) => boolean;
  pubkey?: string;
  log?: (line: string) => void;
  now?: () => number;
}

interface GithubRelease {
  tag_name?: string;
  assets?: ReleaseAsset[];
}

function defaultPilotHome(): string {
  return process.env.PILOT_HOME || path.join(homedir(), ".pilot");
}

function defaultLog(line: string): void {
  process.stdout.write(`${line}\n`);
}

/** 读本地版本：<app>/VERSION，缺失/为空报可读错误 */
export function readLocalVersion(appDir: string): string {
  const versionFile = path.join(appDir, "VERSION");
  if (!existsSync(versionFile)) {
    throw new CliError(
      `未找到本地版本文件 ${versionFile}——PILOT 可能未安装（可用 PILOT_HOME 覆盖安装根目录）`
    );
  }
  const version = normalizeVersion(readFileSync(versionFile, "utf-8"));
  if (!version) throw new CliError(`本地版本文件为空: ${versionFile}`);
  return version;
}

/** 默认「替换后校验」：新 <app>/VERSION 可读且等于目标版本 */
export function verifyInstalledVersion(appDir: string, expectedVersion: string): boolean {
  try {
    return normalizeVersion(readFileSync(path.join(appDir, "VERSION"), "utf-8")) === normalizeVersion(expectedVersion);
  } catch {
    return false;
  }
}

/**
 * 在解压结果里定位 app 根目录（含 VERSION 与 skill/SKILL.md）。
 * 兼容两种打包布局：根即 app 根，或外面套一层 `pilot-skill-<version>/`。
 * 找不到返回 null（防空包/错包，由调用方报错）。
 */
export function resolveAppRoot(extractDir: string): string | null {
  const isAppRoot = (dir: string): boolean =>
    existsSync(path.join(dir, "VERSION")) && existsSync(path.join(dir, "skill", "SKILL.md"));
  if (isAppRoot(extractDir)) return extractDir;
  for (const entry of readdirSync(extractDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(extractDir, entry.name);
    if (isAppRoot(candidate)) return candidate;
  }
  return null;
}

/**
 * 解压 tar.gz（平台原生 tar：macOS bsdtar / Linux GNU tar / Windows 10+ tar.exe）。
 * 不复用 setup-video 的 extractArchive——后者只支持 zip / tar.xz。
 */
export function extractTarball(tarballPath: string, destDir: string): void {
  mkdirSync(destDir, { recursive: true });
  // 调用形态刻意回避「盘符」：用 `-f -` 把包体从 stdin 喂进去，并把 -C 传成
  // **相对**路径（cwd = 包所在目录）。
  // 原因：Windows 上 Git for Windows 提供的是 GNU tar，它会把 `-f C:\...` 里的
  // `C:` 当成远程主机名（实测报错 "Cannot connect to C: resolve failed"）；而
  // bsdtar 不支持 `--force-local`（实测 "Option --force-local is not supported"），
  // 无法用该开关兜底。相对路径 + stdin 对 GNU tar / bsdtar / Windows tar.exe
  // 三种实现都安全。
  const cwd = path.dirname(tarballPath);
  const relDest = path.relative(cwd, destDir) || ".";
  if (path.isAbsolute(relDest)) {
    throw new CliError(
      `解压目标与包体不在同一卷下，无法以相对路径调用 tar（避免 Windows 盘符被 GNU tar 误判为远程主机）: ${destDir}`,
    );
  }
  const result = spawnSync("tar", ["-xzf", "-", "-C", relDest], {
    cwd,
    input: readFileSync(tarballPath),
    maxBuffer: TAR_MAX_BUFFER,
  });
  if (result.status !== 0) {
    const stderr = result.stderr ? result.stderr.toString() : "";
    throw new CliError(`解压失败（tar -xzf，退出码 ${result.status ?? "null"}）: ${stderr}`.trim());
  }
}

/** 列出安装根下所有 app.prev-* 目录 */
function listPrevDirs(pilotHome: string): string[] {
  if (!existsSync(pilotHome)) return [];
  return readdirSync(pilotHome, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith(PREV_PREFIX))
    .map((e) => path.join(pilotHome, e.name));
}

export interface ResolvedDeps {
  pilotHome: string;
  downloadText: (url: string) => Promise<string>;
  downloadFile: (url: string, destPath: string) => Promise<void>;
  extract: (tarballPath: string, destDir: string) => void;
  verify: (tarball: Buffer, signatureB64: string, pubkeyRawB64: string) => boolean;
  verifyInstalled: (appDir: string, expectedVersion: string) => boolean;
  pubkey: string;
  log: (line: string) => void;
  now: () => number;
}

function resolveDeps(deps: UpgradeDeps): ResolvedDeps {
  return {
    pilotHome: deps.pilotHome ?? defaultPilotHome(),
    downloadText: deps.downloadText ?? downloadText,
    downloadFile: deps.downloadFile ?? downloadFile,
    extract: deps.extract ?? extractTarball,
    verify: deps.verify ?? verifyRelease,
    verifyInstalled: deps.verifyInstalled ?? verifyInstalledVersion,
    pubkey: deps.pubkey ?? RELEASE_PUBKEY_B64,
    log: deps.log ?? defaultLog,
    now: deps.now ?? Date.now,
  };
}

export async function main(argv: string[], injected: UpgradeDeps = {}): Promise<UpgradeResult> {
  const d = resolveDeps(injected);
  const [cmd, ...rest] = argv;
  if (cmd !== "check" && cmd !== "run") {
    throw new CliError(`未知子命令: ${cmd ?? "(空)"}（支持 check/run）`);
  }
  const checkOnly = cmd === "check" || rest.includes("--check-only");
  const appDir = path.join(d.pilotHome, "app");

  d.log(`[upgrade] 本地安装: ${appDir}`);
  const local = readLocalVersion(appDir);
  d.log(`[upgrade] 当前版本: ${local}`);

  let remote: string;
  let release: GithubRelease;
  d.log("[upgrade] 查询最新版本 ...");
  try {
    const raw = await d.downloadText(RELEASES_API);
    release = JSON.parse(raw) as GithubRelease;
    if (!release || typeof release.tag_name !== "string" || release.tag_name.length === 0) {
      throw new CliError("GitHub Release 响应缺少 tag_name");
    }
    remote = normalizeVersion(release.tag_name);
  } catch (err) {
    // 约束 4：网络失败 / API 限流不阻塞调用方，降级为提示 + 手动命令
    const message = err instanceof Error ? err.message : String(err);
    d.log(`[upgrade] 无法查询最新版本（网络失败或 API 限流）: ${message}`);
    d.log("[upgrade] 已降级：稍后可手动执行 `npx tsx tools/upgrade.ts run` 重试");
    return { action: cmd, local, remote: null, newer: false, upgraded: false, reason: "network-error" };
  }

  d.log(`[upgrade] 远端最新: ${remote}`);
  const newer = isNewer(local, remote);
  if (!newer) {
    d.log(`[upgrade] 已是最新版本（本地 ${local} ≥ 远端 ${remote}），无需升级`);
    return { action: cmd, local, remote, newer: false, upgraded: false, reason: "already-latest" };
  }
  d.log(`[upgrade] 发现新版本: ${local} → ${remote}`);
  if (checkOnly) {
    d.log("[upgrade] --check-only：仅检查，不下载不替换");
    return { action: cmd, local, remote, newer: true, upgraded: false, reason: "check-only" };
  }

  // 公钥未接线：不下载、不替换，安全降级（不是失败，exit 0）
  if (!isPubkeyConfigured(d.pubkey)) {
    d.log("[upgrade] 发布公钥未接线，无法验签，已跳过自动升级（当前版本保持不变）");
    d.log("[upgrade] 手动升级请访问 https://github.com/twisker/pilot-skill/releases");
    return { action: cmd, local, remote, newer: true, upgraded: false, reason: "pubkey-not-configured" };
  }

  const { tarball, signature } = pickReleaseAssets({ tag_name: release.tag_name, assets: release.assets ?? [] }, remote);
  if (!tarball || !signature) {
    const missing = [!tarball ? `pilot-skill-${remote}.tar.gz` : null, !signature ? `pilot-skill-${remote}.tar.gz.sig` : null]
      .filter(Boolean)
      .join(" / ");
    throw new CliError(`发布资产缺失: ${missing}——发布不完整，已中止升级（当前版本保持不变）`);
  }

  // 临时目录放在安装根下的同盘目录：改名交换才可能是原子且廉价的操作
  const tmpDir = path.join(d.pilotHome, UPGRADE_TMP_DIRNAME);
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });
  const tarballPath = path.join(tmpDir, path.basename(tarball.name));
  const sigPath = path.join(tmpDir, path.basename(signature.name));

  try {
    d.log(`[upgrade] 下载发布物 ${tarball.name} ...`);
    try {
      await d.downloadFile(tarball.browser_download_url, tarballPath);
      await d.downloadFile(signature.browser_download_url, sigPath);
    } catch (err) {
      // 下载失败仍属网络问题：不阻塞、不替换，保留当前版本
      const message = err instanceof Error ? err.message : String(err);
      d.log(`[upgrade] 下载失败: ${message}`);
      d.log("[upgrade] 已降级：当前版本保持不变，稍后可手动重试");
      return { action: cmd, local, remote, newer: true, upgraded: false, reason: "download-failed" };
    }

    d.log("[upgrade] 验签（Ed25519 detached）...");
    const ok = d.verify(readFileSync(tarballPath), readFileSync(sigPath, "utf-8"), d.pubkey);
    if (!ok) {
      // 红线 6：验签失败一律拒用，绝不解压执行，保留当前版本
      d.log("[upgrade] 验签失败——拒绝使用该发布物，绝不解压，当前版本保持不变");
      throw new CliError("发布物验签失败——拒绝使用该发布物，当前版本保持不变");
    }
    d.log("[upgrade] 验签通过");

    const extractDir = path.join(tmpDir, "extract");
    d.log("[upgrade] 解压到临时目录 ...");
    d.extract(tarballPath, extractDir);
    const newRoot = resolveAppRoot(extractDir);
    if (!newRoot) {
      throw new CliError("解压结果缺少 VERSION 或 skill/SKILL.md——疑似空包/错包，已中止（当前版本保持不变）");
    }

    // 迁移用户状态到新目录（rename 同盘廉价；install.mjs 会跨版本保留它们）
    const migratedRels: string[] = [];
    for (const rel of USER_STATE_RELS) {
      const src = path.join(appDir, rel);
      if (!existsSync(src)) continue;
      const dest = path.join(newRoot, rel);
      rmSync(dest, { recursive: true, force: true });
      mkdirSync(path.dirname(dest), { recursive: true });
      renameSync(src, dest);
      migratedRels.push(rel);
    }
    if (migratedRels.length > 0) {
      d.log(`[upgrade] 迁移用户状态: ${migratedRels.join(", ")}`);
    }

    /** 把用户状态从 fromDir 按原相对路径搬回 appDir（回滚用） */
    const moveUserStateBack = (fromDir: string): void => {
      for (const rel of migratedRels) {
        const src = path.join(fromDir, rel);
        if (!existsSync(src)) continue;
        const dest = path.join(appDir, rel);
        rmSync(dest, { recursive: true, force: true });
        mkdirSync(path.dirname(dest), { recursive: true });
        renameSync(src, dest);
      }
    };

    // 改名交换（不是覆盖删除，保证任何一步失败都能退回旧版）
    const prevDir = path.join(d.pilotHome, `${PREV_PREFIX}${local}`);
    rmSync(prevDir, { recursive: true, force: true });
    d.log(`[upgrade] 改名交换: app → ${path.basename(prevDir)}，新版本就位 ...`);
    let swapped = false;
    try {
      renameSync(appDir, prevDir);
      swapped = true;
      renameSync(newRoot, appDir);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (swapped) {
        // 旧版已挪走但新版没就位：改回来 + 用户状态回原位
        renameSync(prevDir, appDir);
      }
      moveUserStateBack(newRoot);
      throw new CliError(`替换失败，已保留当前版本 ${local}: ${message}`);
    }

    // 替换后校验；失败则回滚
    d.log("[upgrade] 校验新版本 ...");
    if (!d.verifyInstalled(appDir, remote)) {
      d.log(`[upgrade] 新版本校验失败，正在回滚到 ${local} ...`);
      const failedDir = path.join(d.pilotHome, `${FAILED_PREFIX}${d.now()}`);
      rmSync(failedDir, { recursive: true, force: true });
      renameSync(appDir, failedDir);
      renameSync(prevDir, appDir);
      moveUserStateBack(failedDir);
      rmSync(failedDir, { recursive: true, force: true });
      d.log(`[upgrade] 已回滚到 ${local}（用户 .env / tools/node_modules 已归位）`);
      throw new CliError(`新版本校验失败（VERSION 不可读或版本号不符），已回滚到 ${local}`);
    }

    // 保留最近 1 个 .prev（刚创建的这个），更早的清理
    for (const dir of listPrevDirs(d.pilotHome)) {
      if (path.resolve(dir) !== path.resolve(prevDir)) rmSync(dir, { recursive: true, force: true });
    }

    d.log(`[upgrade] 升级完成: ${local} → ${remote}`);
    d.log("[upgrade] 提示：~/.claude/skills/pilot 指向 ~/.pilot/app/skill，路径未变，无需重注册");
    return { action: cmd, local, remote, newer: true, upgraded: true, reason: "upgraded" };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result)}\n`);
      process.exit(0);
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`${JSON.stringify({ error: message })}\n`);
      process.exit(1);
    });
}
