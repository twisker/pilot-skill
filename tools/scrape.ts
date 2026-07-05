import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium, type Browser, type BrowserContextOptions } from "playwright";
import { readJson, writeJson, tripDir, atomicWriteFileSync } from "./lib/workspace";
import { reportProgress, truncateForLog } from "./lib/progress";
import { mafengwoSite } from "./lib/sites/mafengwo";
import { xhsSite, isXhsUrl, hasXhsCookie } from "./lib/sites/xhs";
import { zhihuSite } from "./lib/sites/zhihu";
import { qyerSite } from "./lib/sites/qyer";
import { genericSite } from "./lib/sites/generic";
import { cookieFilePath } from "./lib/sites/cookies";
import type { SiteAdapter } from "./lib/sites/types";

// ---------------------------------------------------------------------------
// PILOT scrape.ts —— playwright 本地抓取 + 站点适配层
//
// 消费 raw/pick.json 中 method=scrape 或 status=fetch_failed 的条目，逐个用
// playwright chromium 抓取正文，产出 raw/<sha1(url)>.{html,txt,meta.json}，
// 并把结果状态回写 pick.json。任一 URL 失败不中断整体：exit 0，逐条记录
// meta.status。只有参数/trip 级错误才 exit 1。
// ---------------------------------------------------------------------------

export class CliError extends Error {}

type PickStatus = "pending" | "fetched" | "fetch_failed" | "scraped" | "failed";

interface PickEntry {
  url: string;
  source: string;
  media_type_guess: string;
  method: "webfetch" | "scrape";
  status: PickStatus;
}

interface RawMeta {
  url: string;
  fetched_at: string;
  status: "full" | "partial" | "failed";
  title: string;
  reason?: string;
}

const ATTEMPT_TIMEOUT_MS = 45000;
const PARTIAL_THRESHOLD = 500; // 正文字数低于此判定 partial，为 0 判定 failed
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function sha1(input: string): string {
  return createHash("sha1").update(input).digest("hex");
}

function shouldProcess(entry: PickEntry): boolean {
  return entry.method === "scrape" || entry.status === "fetch_failed";
}

function selectAdapter(url: string): { adapter: SiteAdapter } | { failReason: string } {
  // xhs 域名但无 cookie：直接判失败，不跌落到 generic 兜底硬抓登录墙/信息流页
  if (isXhsUrl(url) && !hasXhsCookie()) {
    return { failReason: "no-cookie" };
  }
  for (const site of [mafengwoSite, xhsSite, zhihuSite, qyerSite]) {
    if (site.match(url)) return { adapter: site };
  }
  return { adapter: genericSite };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`超时（${ms}ms）`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

interface ScrapeOutcome {
  title: string;
  text: string;
  html: string;
}

export async function scrapeOnce(browser: Browser, url: string, adapter: SiteAdapter): Promise<ScrapeOutcome> {
  const contextOptions: BrowserContextOptions = {
    userAgent: USER_AGENT,
    locale: "zh-CN",
    viewport: { width: 1280, height: 800 },
  };
  // 全站点 cookie 支持：适配器声明了 cookieFile 且对应文件存在时加载为
  // storageState；不存在则正常无 cookie 抓取，不视为失败（xhs 的硬门控
  // 在 selectAdapter 里单独处理，走不到这里就已经被判 failed）。
  if (adapter.cookieFile) {
    const cookiePath = cookieFilePath(adapter.cookieFile);
    if (existsSync(cookiePath)) {
      contextOptions.storageState = JSON.parse(
        readFileSync(cookiePath, "utf-8"),
      ) as BrowserContextOptions["storageState"];
    }
  }

  const context = await browser.newContext(contextOptions);
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });

  try {
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: ATTEMPT_TIMEOUT_MS });
    await adapter.prepare(page);
    const { title, text } = await adapter.extract(page);
    const html = await page.content();
    return { title, text, html };
  } finally {
    await context.close();
  }
}

async function scrapeWithRetry(
  browser: Browser,
  url: string,
  adapter: SiteAdapter,
): Promise<ScrapeOutcome | { error: string }> {
  let lastError = "未知错误";
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await withTimeout(scrapeOnce(browser, url, adapter), ATTEMPT_TIMEOUT_MS);
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  return { error: lastError };
}

function writeMeta(tripId: string, hash: string, meta: RawMeta): void {
  writeJson(tripId, `raw/${hash}.meta.json`, meta);
}

function writeRawArtifact(tripId: string, hash: string, ext: "html" | "txt", content: string): void {
  const filePath = path.join(tripDir(tripId), "raw", `${hash}.${ext}`);
  atomicWriteFileSync(filePath, content);
}

export interface ScrapeResult {
  processed: number;
  full: number;
  partial: number;
  failed: number;
  skipped_no_cookie: number;
}

export async function runScrape(
  tripId: string,
  opts: { only?: string; site?: string } = {},
): Promise<ScrapeResult> {
  // 校验 trip 存在（不存在会抛出，属于 trip 级错误，CLI 层 exit 1）
  tripDir(tripId);

  const pick = readJson<PickEntry[]>(tripId, "raw/pick.json");
  const targets = pick.filter((e) => {
    if (!shouldProcess(e)) return false;
    if (opts.only && e.url !== opts.only) return false;
    if (opts.site) {
      try {
        const host = new URL(e.url).hostname.toLowerCase();
        if (!host.includes(opts.site.toLowerCase())) return false;
      } catch {
        return false;
      }
    }
    return true;
  });

  const result: ScrapeResult = { processed: 0, full: 0, partial: 0, failed: 0, skipped_no_cookie: 0 };
  if (targets.length === 0) return result;

  // 仅在存在需要真正发起浏览器请求的目标时才启动 chromium
  // （xhs 无 cookie 的条目直接判失败，不应触发浏览器启动/导航）
  const needsBrowser = targets.some((e) => !("failReason" in selectAdapter(e.url)));
  const browser: Browser | null = needsBrowser
    ? await chromium.launch({
        headless: true,
        args: ["--disable-blink-features=AutomationControlled"],
      })
    : null;

  try {
    for (const entry of targets) {
      result.processed++;
      reportProgress(tripId, {
        stage: "fetch",
        current: result.processed,
        total: targets.length,
        message: `抓取中: ${truncateForLog(entry.url)}`,
      });
      const hash = sha1(entry.url);
      const selection = selectAdapter(entry.url);

      if ("failReason" in selection) {
        result.skipped_no_cookie++;
        entry.status = "failed";
        writeMeta(tripId, hash, {
          url: entry.url,
          fetched_at: new Date().toISOString(),
          status: "failed",
          title: "",
          reason: selection.failReason,
        });
        writeJson(tripId, "raw/pick.json", pick);
        continue;
      }

      // 到这里 selection 已确定是 { adapter }（非 no-cookie 跳过分支），
      // browser 必然已按 needsBrowser 逻辑启动
      const outcome = await scrapeWithRetry(browser as Browser, entry.url, selection.adapter);
      const fetchedAt = new Date().toISOString();

      if ("error" in outcome) {
        result.failed++;
        entry.status = "failed";
        writeMeta(tripId, hash, {
          url: entry.url,
          fetched_at: fetchedAt,
          status: "failed",
          title: "",
          reason: outcome.error,
        });
        writeJson(tripId, "raw/pick.json", pick);
        continue;
      }

      const textLen = outcome.text.trim().length;
      const status: RawMeta["status"] = textLen === 0 ? "failed" : textLen < PARTIAL_THRESHOLD ? "partial" : "full";

      if (status !== "failed") {
        writeRawArtifact(tripId, hash, "html", outcome.html);
        writeRawArtifact(tripId, hash, "txt", outcome.text);
      }
      writeMeta(tripId, hash, {
        url: entry.url,
        fetched_at: fetchedAt,
        status,
        title: outcome.title,
      });

      if (status === "failed") {
        result.failed++;
        entry.status = "failed";
      } else {
        if (status === "full") result.full++;
        else result.partial++;
        entry.status = "scraped";
      }
      writeJson(tripId, "raw/pick.json", pick);
    }
  } finally {
    if (browser) await browser.close();
  }

  writeJson(tripId, "raw/pick.json", pick);
  return result;
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
  if (!flags.trip) throw new CliError("--trip 是必填参数");
  const tripId = flags.trip;

  switch (cmd) {
    case "run":
      return runScrape(tripId, {
        only: flags.only || undefined,
        site: flags.site || undefined,
      });
    default:
      throw new CliError(`未知子命令: ${cmd ?? "(空)"}`);
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (result) => {
      process.stdout.write(`${JSON.stringify(result)}\n`);
      process.exit(0);
    },
    (err) => {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`${JSON.stringify({ error: message })}\n`);
      process.exit(1);
    },
  );
}
