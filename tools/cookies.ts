import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import readline from "node:readline";
import { chromium, type BrowserContext } from "playwright";
import { getPilotHome, cookieFilePath } from "./lib/sites/cookies";

// ---------------------------------------------------------------------------
// PILOT cookies.ts —— 引导式 cookie 导出工具（Task 17）
//
// 取代手工逐条敲 `npx playwright open ...` 的旧流程：
//   setup [--site <name>]  headed chromium 打开登录页 → 轮询检测登录标志
//                          cookie → 检测到即存为 storageState → 自动进入下一站
//   status                 表格汇报各站 cookie 文件现状（是否存在/标志 cookie
//                          是否在/最早过期时间）
//
// setup 是交互式工具，是本仓库 CLI 契约的唯一例外：进度信息走 stderr（人类
// 阅读），最终逐站结果汇总的 JSON 走 stdout（便于脚本化/留痕）。
// ---------------------------------------------------------------------------

export class CliError extends Error {}

export interface SiteDef {
  key: string;
  label: string;
  loginUrl: string;
  cookieFile: string;
  /** 已知的登录标志 cookie 名；null 表示无稳定已知标志，走「数量显著增加 + 用户回车确认」兜底 */
  markerCookie: string | null;
}

// 站点标志 cookie 表：调研未能确认马蜂窝/穷游的稳定登录标志 cookie（两站登录后
// 设置的 cookie 因账号/AB 实验差异较大，无法可靠断言单一 cookie 名），按 brief
// 要求对这两站使用兜底策略；知乎/小红书/B站标志 cookie 已通过公开资料确认。
export const SITES: SiteDef[] = [
  { key: "mafengwo", label: "马蜂窝", loginUrl: "https://www.mafengwo.cn", cookieFile: "mafengwo.json", markerCookie: null },
  { key: "zhihu", label: "知乎", loginUrl: "https://www.zhihu.com", cookieFile: "zhihu.json", markerCookie: "z_c0" },
  { key: "qyer", label: "穷游", loginUrl: "https://bbs.qyer.com", cookieFile: "qyer.json", markerCookie: null },
  { key: "xhs", label: "小红书", loginUrl: "https://www.xiaohongshu.com", cookieFile: "xhs.json", markerCookie: "web_session" },
  { key: "bilibili", label: "B站", loginUrl: "https://www.bilibili.com", cookieFile: "bilibili.json", markerCookie: "SESSDATA" },
];

export const POLL_INTERVAL_MS = 2000;
export const SITE_TIMEOUT_MS = 5 * 60 * 1000;
// 无已知标志 cookie 的站点（马蜂窝/穷游）判定登录成功的兜底阈值：相对进入登录页
// 时的基线 cookie 数量，需显著增加（而不仅仅是 +1 两个的噪声波动）
export const FALLBACK_COOKIE_INCREASE_THRESHOLD = 5;

export function findSite(key: string): SiteDef {
  const site = SITES.find((s) => s.key === key);
  if (!site) {
    throw new CliError(`未知站点: "${key}"（支持：${SITES.map((s) => s.key).join("/")}）`);
  }
  return site;
}

function ensureCookiesDir(): void {
  mkdirSync(path.join(getPilotHome(), "cookies"), { recursive: true });
}

// ---------------------------------------------------------------------------
// status —— 纯函数部分（可单测，不触碰浏览器/网络）
// ---------------------------------------------------------------------------

export interface StorageStateCookieLite {
  name: string;
  expires: number; // -1 = session cookie（playwright 约定）
}

export interface StorageStateLite {
  cookies: StorageStateCookieLite[];
}

export interface SiteStatus {
  key: string;
  label: string;
  exists: boolean;
  /** null = 该站点无已知标志 cookie（启发式站点，无法判定） */
  markerPresent: boolean | null;
  earliestExpiry: string | null;
}

export function hasMarkerCookie(cookies: StorageStateCookieLite[], marker: string): boolean {
  return cookies.some((c) => c.name === marker);
}

/**
 * 取 cookies[].expires 中最小的非 -1（非 session）值，转为 ISO8601 日期字符串。
 * 全部是 session cookie 或数组为空 → null。
 */
export function earliestExpiryIso(cookies: StorageStateCookieLite[]): string | null {
  const positive = cookies
    .map((c) => c.expires)
    .filter((e): e is number => typeof e === "number" && e !== -1 && e > 0);
  if (positive.length === 0) return null;
  return new Date(Math.min(...positive) * 1000).toISOString();
}

export function computeSiteStatus(site: SiteDef, storageState: StorageStateLite | null): SiteStatus {
  if (!storageState) {
    return { key: site.key, label: site.label, exists: false, markerPresent: site.markerCookie ? false : null, earliestExpiry: null };
  }
  const markerPresent = site.markerCookie ? hasMarkerCookie(storageState.cookies, site.markerCookie) : null;
  return {
    key: site.key,
    label: site.label,
    exists: true,
    markerPresent,
    earliestExpiry: earliestExpiryIso(storageState.cookies),
  };
}

export function runStatus(): SiteStatus[] {
  return SITES.map((site) => {
    const filePath = cookieFilePath(site.cookieFile);
    if (!existsSync(filePath)) return computeSiteStatus(site, null);
    const storageState = JSON.parse(readFileSync(filePath, "utf-8")) as StorageStateLite;
    return computeSiteStatus(site, storageState);
  });
}

export function formatStatusTable(rows: SiteStatus[]): string {
  const header = ["站点", "cookie文件", "标志cookie", "最早过期时间"];
  const cells = rows.map((r) => [
    r.label,
    r.exists ? "存在" : "缺失",
    r.markerPresent === null ? "未知(启发式站点)" : r.markerPresent ? "在" : "不在",
    r.earliestExpiry ?? "-",
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...cells.map((row) => row[i].length)));
  const renderRow = (cols: string[]) => cols.map((c, i) => c.padEnd(widths[i], " ")).join("  ");
  return [renderRow(header), ...cells.map(renderRow)].join("\n");
}

// ---------------------------------------------------------------------------
// setup —— 交互式浏览器登录引导（不做自动化测试，见人工验证路径）
// ---------------------------------------------------------------------------

export type SetupOutcome = "success" | "skipped" | "timeout" | "error";

export interface SetupResult {
  key: string;
  label: string;
  outcome: SetupOutcome;
  cookieFile?: string;
  error?: string;
}

/**
 * 轮询 + 回车监听，直到判定成功/用户跳过/超时。
 * - 有已知标志 cookie 的站点：轮询检测到标志 cookie 即自动判定成功，无需用户操作。
 * - 无已知标志 cookie 的站点（马蜂窝/穷游）：轮询只更新基线计数，不自动判定成功，
 *   必须用户按回车触发一次检查，检查时若 cookie 数量相对基线显著增加才判定成功，
 *   否则视为用户主动跳过。
 * - 任意站点，用户随时按回车都会触发一次检查（标志 cookie 命中→成功；否则→跳过）。
 */
export function waitForLogin(site: SiteDef, context: BrowserContext): Promise<SetupOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    let baselineCount: number | null = null;

    const rl = readline.createInterface({ input: process.stdin });

    const finish = (result: SetupOutcome) => {
      if (settled) return;
      settled = true;
      clearInterval(pollTimer);
      clearTimeout(timeoutTimer);
      rl.removeAllListeners();
      rl.close();
      resolve(result);
    };

    rl.on("line", () => {
      void (async () => {
        try {
          const cookies = await context.cookies();
          if (baselineCount === null) baselineCount = cookies.length;
          const success = site.markerCookie
            ? hasMarkerCookie(cookies, site.markerCookie)
            : cookies.length >= baselineCount + FALLBACK_COOKIE_INCREASE_THRESHOLD;
          finish(success ? "success" : "skipped");
        } catch {
          finish("skipped");
        }
      })();
    });

    const pollTimer = setInterval(() => {
      void (async () => {
        try {
          const cookies = await context.cookies();
          if (baselineCount === null) baselineCount = cookies.length;
          if (site.markerCookie && hasMarkerCookie(cookies, site.markerCookie)) {
            finish("success");
          }
        } catch {
          // 浏览器窗口可能已被用户手动关闭
          finish("skipped");
        }
      })();
    }, POLL_INTERVAL_MS);

    const timeoutTimer = setTimeout(() => finish("timeout"), SITE_TIMEOUT_MS);
  });
}

// 中断信号处理（Ctrl-C / kill）：Node 默认收到 SIGINT 会立即终止进程，不会给
// 已注册的 try/finally 执行机会，导致临时 profile 目录残留。这里维护「当前活跃
// profile 目录 + context」的模块级引用，注册信号处理器做最佳努力清理后再退出。
let activeProfileDir: string | null = null;
let activeContext: BrowserContext | null = null;
let signalHandlersRegistered = false;

function registerSignalCleanup(): void {
  if (signalHandlersRegistered) return;
  signalHandlersRegistered = true;
  const handler = () => {
    process.stderr.write("\n收到中断信号，正在清理临时浏览器 profile…\n");
    void (async () => {
      try {
        if (activeContext) await activeContext.close();
      } catch {
        // 忽略：context 可能已经处于关闭中
      }
      if (activeProfileDir && existsSync(activeProfileDir)) {
        try {
          rmSync(activeProfileDir, { recursive: true, force: true });
        } catch {
          // 忽略：目录可能已被清理
        }
      }
      process.exit(130);
    })();
  };
  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);
}

export async function runSetup(siteKeys: string[]): Promise<SetupResult[]> {
  ensureCookiesDir();
  registerSignalCleanup();
  const results: SetupResult[] = [];

  for (const key of siteKeys) {
    const site = findSite(key);
    const timeoutMin = Math.round(SITE_TIMEOUT_MS / 60000);
    process.stderr.write(
      `\n请在浏览器中登录 ${site.label}…（检测到登录后自动保存并进入下一站；按回车确认/跳过本站；${timeoutMin} 分钟未完成自动跳过）\n`,
    );

    const profileDir = mkdtempSync(path.join(tmpdir(), `pilot-cookies-${site.key}-`));
    activeProfileDir = profileDir;
    let outcome: SetupOutcome = "skipped";
    let errorMessage: string | undefined;

    try {
      const context = await chromium.launchPersistentContext(profileDir, { headless: false });
      activeContext = context;
      try {
        const page = context.pages()[0] ?? (await context.newPage());
        await page.goto(site.loginUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
        outcome = await waitForLogin(site, context);
        if (outcome === "success") {
          const storageState = await context.storageState();
          const destPath = cookieFilePath(site.cookieFile);
          writeFileSync(destPath, JSON.stringify(storageState, null, 2));
          process.stderr.write(`已保存：${site.label} → ${destPath}\n`);
        } else {
          process.stderr.write(`已跳过：${site.label}（${outcome === "timeout" ? "超时" : "用户跳过"}）\n`);
        }
      } finally {
        await context.close().catch(() => {});
        activeContext = null;
      }
    } catch (err) {
      outcome = "error";
      errorMessage = err instanceof Error ? err.message : String(err);
      process.stderr.write(`出错：${site.label} —— ${errorMessage}\n`);
    } finally {
      rmSync(profileDir, { recursive: true, force: true });
      activeProfileDir = null;
    }

    results.push({
      key: site.key,
      label: site.label,
      outcome,
      ...(outcome === "success" ? { cookieFile: site.cookieFile } : {}),
      ...(errorMessage ? { error: errorMessage } : {}),
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): { cmd: string | undefined; flags: Record<string, string> } {
  const [cmd, ...rest] = argv;
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i];
    if (!key || !key.startsWith("--")) {
      throw new CliError(`参数格式错误: ${key ?? "(缺失)"}`);
    }
    flags[key.slice(2)] = rest[i + 1] ?? "";
  }
  return { cmd, flags };
}

export async function main(argv: string[]): Promise<unknown> {
  const { cmd, flags } = parseArgs(argv);

  switch (cmd) {
    case "setup": {
      if (flags.site) {
        findSite(flags.site); // 校验站点名合法，非法直接抛错，不进入浏览器流程
        return runSetup([flags.site]);
      }
      return runSetup(SITES.map((s) => s.key));
    }
    case "status":
      return runStatus();
    default:
      throw new CliError(`未知子命令: ${cmd ?? "(空)"}（支持 setup/status）`);
  }
}

if (require.main === module) {
  const cmd = process.argv[2];
  main(process.argv.slice(2))
    .then((result) => {
      if (cmd === "status") {
        process.stdout.write(`${formatStatusTable(result as SiteStatus[])}\n`);
      } else {
        process.stdout.write(`${JSON.stringify(result)}\n`);
      }
      process.exit(0);
    })
    .catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`${JSON.stringify({ error: message })}\n`);
      process.exit(1);
    });
}
