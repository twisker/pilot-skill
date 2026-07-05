import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { createServer, type Server, type IncomingMessage } from "node:http";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { createTrip, readJson, writeJson } from "../lib/workspace";
import { runScrape, scrapeOnce, main, CliError } from "../scrape";
import { extractFromHtml, extractTitle } from "../lib/extract";
import { extractPaginated } from "../lib/sites/mafengwo";
import { extractPaginated as extractPaginatedQyer, isQyerUrl, qyerSite } from "../lib/sites/qyer";
import { isZhihuUrl, zhihuSite } from "../lib/sites/zhihu";
import { isXhsUrl, hasXhsCookie } from "../lib/sites/xhs";
import type { SiteAdapter } from "../lib/sites/types";

function sha1(s: string): string {
  return createHash("sha1").update(s).digest("hex");
}

function getUnusedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

const PAGES: Record<string, string> = {
  "/full.html": `<!doctype html><html><head><title>禾木喀纳斯9天自驾游记</title></head><body>
    <nav>首页 关于我们 联系方式</nav>
    <article>
      <h1>禾木喀纳斯9天自驾游记</h1>
      <p>${"第一天从乌鲁木齐出发，沿着独库公路一路向北，途经天山天池，晚上抵达赛里木湖畔露营看星空。".repeat(6)}</p>
      <p>${"第二天从赛里木湖出发前往禾木村，路上经过果子沟大桥，风景极佳，晚上入住禾木村民宿听篝火。".repeat(6)}</p>
    </article>
    <footer>版权所有 2026</footer>
  </body></html>`,
  "/thin.html": `<!doctype html><html><head><title>短文</title></head><body><p>太短了</p></body></html>`,
  "/page1.html": `<!doctype html><html><head><title>分页游记 第1页</title></head><body>
    <div class="vc_article"><p>${"第一页正文内容，介绍行程第一天的安排与沿途见闻细节。".repeat(5)}</p></div>
    <a href="/page2.html">下一页</a>
  </body></html>`,
  "/page2.html": `<!doctype html><html><head><title>分页游记 第2页</title></head><body>
    <div class="vc_article"><p>${"第二页正文内容，介绍行程第二天的安排与沿途见闻细节。".repeat(5)}</p></div>
  </body></html>`,
};

let server: Server;
let baseUrl: string;

function cookieEchoBody(req: IncomingMessage): string {
  const cookieHeader = req.headers.cookie ?? "none";
  return `<!doctype html><html><head><title>cookie 回显</title></head><body>
    <article><p>${"用于验证 cookie 是否随请求携带的固定长度中文占位正文内容".repeat(3)}COOKIE_VALUE:${cookieHeader}</p></article>
  </body></html>`;
}

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server = createServer((req, res) => {
      if (req.url === "/cookie-echo.html") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(cookieEchoBody(req));
        return;
      }
      const body = PAGES[req.url ?? ""];
      if (body) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(body);
      } else {
        res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
        res.end("<html><body>404</body></html>");
      }
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

let testPilotHome: string;
let tripId: string;

beforeEach(() => {
  testPilotHome = mkdtempSync(path.join(tmpdir(), "pilot-scrape-test-"));
  process.env.PILOT_HOME = testPilotHome;
  const tripPath = createTrip("scrape-test");
  tripId = path.basename(tripPath);
});

afterEach(() => {
  delete process.env.PILOT_HOME;
  if (existsSync(testPilotHome)) {
    rmSync(testPilotHome, { recursive: true });
  }
});

function seedPick(entries: unknown[]): void {
  writeJson(tripId, "raw/pick.json", entries);
}

describe("scrape: generic 兜底路径", () => {
  it("产出 html/txt/meta 三件套，过滤导航文本，pick.json 状态回写为 scraped", async () => {
    const url = `${baseUrl}/full.html`;
    seedPick([{ url, source: "test", media_type_guess: "text", method: "scrape", status: "pending" }]);

    const result = await runScrape(tripId);

    expect(result.processed).toBe(1);
    expect(result.full + result.partial).toBe(1);
    expect(result.failed).toBe(0);

    const hash = sha1(url);
    const rawDir = path.join(testPilotHome, "workspace", tripId, "raw");
    expect(existsSync(path.join(rawDir, `${hash}.html`))).toBe(true);
    expect(existsSync(path.join(rawDir, `${hash}.txt`))).toBe(true);
    expect(existsSync(path.join(rawDir, `${hash}.meta.json`))).toBe(true);

    const txt = readFileSync(path.join(rawDir, `${hash}.txt`), "utf-8");
    expect(txt).toContain("禾木村");
    expect(txt).not.toContain("首页 关于我们 联系方式");

    const meta = readJson<{ status: string; title: string; url: string }>(tripId, `raw/${hash}.meta.json`);
    expect(["full", "partial"]).toContain(meta.status);
    expect(meta.title).toContain("禾木喀纳斯");
    expect(meta.url).toBe(url);

    const pick = readJson<{ status: string }[]>(tripId, "raw/pick.json");
    expect(pick[0].status).toBe("scraped");
  }, 30000);

  it("--only 仅处理指定 URL，其余条目状态不变", async () => {
    const url1 = `${baseUrl}/full.html`;
    const url2 = `${baseUrl}/thin.html`;
    seedPick([
      { url: url1, source: "a", media_type_guess: "text", method: "scrape", status: "pending" },
      { url: url2, source: "b", media_type_guess: "text", method: "scrape", status: "pending" },
    ]);

    const result = await runScrape(tripId, { only: url1 });
    expect(result.processed).toBe(1);

    const pick = readJson<{ url: string; status: string }[]>(tripId, "raw/pick.json");
    expect(pick.find((p) => p.url === url1)?.status).toBe("scraped");
    expect(pick.find((p) => p.url === url2)?.status).toBe("pending");
  }, 30000);
});

describe("scrape: 不可达 URL", () => {
  it("meta.status=failed，pick.json 回写 failed，函数正常 resolve（对应 CLI exit 0）", async () => {
    const port = await getUnusedPort();
    const url = `http://127.0.0.1:${port}/dead`;
    seedPick([{ url, source: "test", media_type_guess: "text", method: "scrape", status: "pending" }]);

    const result = await runScrape(tripId);
    expect(result.failed).toBe(1);

    const hash = sha1(url);
    const meta = readJson<{ status: string; reason?: string }>(tripId, `raw/${hash}.meta.json`);
    expect(meta.status).toBe("failed");
    expect(meta.reason).toBeTruthy();

    const pick = readJson<{ status: string }[]>(tripId, "raw/pick.json");
    expect(pick[0].status).toBe("failed");
  }, 30000);
});

describe("extract.ts 正文抽取（fixture HTML，无需浏览器）", () => {
  it("过滤导航/页脚样板，合并 <p> 段落作为正文", () => {
    const { title, text } = extractFromHtml(PAGES["/full.html"]);
    expect(title).toBe("禾木喀纳斯9天自驾游记");
    expect(text).toContain("赛里木湖");
    expect(text).toContain("禾木村");
    expect(text).not.toContain("首页 关于我们 联系方式");
    expect(text).not.toContain("版权所有");
    expect(text.length).toBeGreaterThan(200);
  });

  it("正文很短时仍返回能抓到的文本而非清空为空", () => {
    const { text } = extractFromHtml(PAGES["/thin.html"]);
    expect(text).toBe("太短了");
  });

  it("extractTitle 优先 h1，其次 title 标签", () => {
    expect(extractTitle(`<html><head><title>Title标签</title></head><body><h1>H1标题</h1></body></html>`)).toBe(
      "H1标题",
    );
    expect(extractTitle(`<html><head><title>只有Title</title></head><body></body></html>`)).toBe("只有Title");
    expect(extractTitle(`<html><body>都没有</body></html>`)).toBe("");
  });
});

describe("mafengwo: 分页游记全量拼接", () => {
  let browser: Browser;

  beforeEach(async () => {
    browser = await chromium.launch({ headless: true });
  });

  afterEach(async () => {
    await browser.close();
  });

  it("沿下一页链接拼接全部页面正文，无更多下一页时停止", async () => {
    const page = await browser.newPage();
    await page.goto(`${baseUrl}/page1.html`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".vc_article", { timeout: 8000 });

    const { title, text } = await extractPaginated(page);

    expect(title).toBe("分页游记 第1页");
    expect(text).toContain("第一页正文内容");
    expect(text).toContain("第二页正文内容");
  }, 30000);

  it("maxPages 限制页数上限：上限 1 时只抓第一页", async () => {
    const page = await browser.newPage();
    await page.goto(`${baseUrl}/page1.html`, { waitUntil: "domcontentloaded" });

    const { text } = await extractPaginated(page, { maxPages: 1 });

    expect(text).toContain("第一页正文内容");
    expect(text).not.toContain("第二页正文内容");
  }, 30000);
});

describe("xhs: cookie 门控", () => {
  it("干净 PILOT_HOME 下无 cookie 文件：域名判定为真，但 hasXhsCookie 为假", () => {
    expect(isXhsUrl("https://www.xiaohongshu.com/explore/abc")).toBe(true);
    expect(isXhsUrl(`${baseUrl}/full.html`)).toBe(false);
    expect(hasXhsCookie()).toBe(false);
  });

  it("无 cookie 的小红书 URL 直接判 failed（reason: no-cookie），不落到 generic 兜底硬抓", async () => {
    const url = "https://www.xiaohongshu.com/explore/dead-url-should-not-be-fetched";
    seedPick([{ url, source: "小红书", media_type_guess: "text", method: "scrape", status: "pending" }]);

    const result = await runScrape(tripId);
    expect(result.skipped_no_cookie).toBe(1);
    expect(result.processed).toBe(1);

    const hash = sha1(url);
    const meta = readJson<{ status: string; reason?: string }>(tripId, `raw/${hash}.meta.json`);
    expect(meta.status).toBe("failed");
    expect(meta.reason).toBe("no-cookie");

    const pick = readJson<{ status: string }[]>(tripId, "raw/pick.json");
    expect(pick[0].status).toBe("failed");
  }, 15000);
});

describe("scrape: 全站点 cookieFile 通用支持", () => {
  let browser: Browser;

  beforeEach(async () => {
    browser = await chromium.launch({ headless: true });
  });

  afterEach(async () => {
    await browser.close();
  });

  function fakeAdapterWithCookie(cookieFile: string): SiteAdapter {
    return {
      match: () => true,
      async prepare(page) {
        try {
          await page.waitForLoadState("networkidle", { timeout: 5000 });
        } catch {
          // 继续用当前渲染结果
        }
      },
      async extract(page) {
        return extractFromHtml(await page.content());
      },
      cookieFile,
    };
  }

  it("cookie 文件存在时，请求携带 storageState 中的 Cookie header", async () => {
    const cookiesDir = path.join(testPilotHome, "cookies");
    mkdirSync(cookiesDir, { recursive: true });
    const storageState = {
      cookies: [
        {
          name: "pilot_session",
          value: "abc123",
          domain: "127.0.0.1",
          path: "/",
          expires: -1,
          httpOnly: false,
          secure: false,
          sameSite: "Lax" as const,
        },
      ],
      origins: [],
    };
    writeFileSync(path.join(cookiesDir, "test-site.json"), JSON.stringify(storageState), "utf-8");

    const url = `${baseUrl}/cookie-echo.html`;
    const outcome = await scrapeOnce(browser, url, fakeAdapterWithCookie("test-site.json"));
    expect(outcome.text).toContain("pilot_session=abc123");
  }, 15000);

  it("cookie 文件不存在时正常无 cookie 抓取，不失败", async () => {
    const url = `${baseUrl}/cookie-echo.html`;
    const outcome = await scrapeOnce(browser, url, fakeAdapterWithCookie("does-not-exist.json"));
    expect(outcome.text).toContain("COOKIE_VALUE:none");
  }, 15000);
});

describe("站点适配器：域名匹配 + cookieFile 字段", () => {
  it("zhihu: zhuanlan.zhihu.com 与 zhihu.com 均命中，声明 cookieFile", () => {
    expect(isZhihuUrl("https://zhuanlan.zhihu.com/p/123456")).toBe(true);
    expect(isZhihuUrl("https://www.zhihu.com/question/1/answer/2")).toBe(true);
    expect(isZhihuUrl(`${baseUrl}/full.html`)).toBe(false);
    expect(zhihuSite.cookieFile).toBe("zhihu.json");
  });

  it("qyer: bbs.qyer.com 与 place.qyer.com 均命中，声明 cookieFile", () => {
    expect(isQyerUrl("https://bbs.qyer.com/post/123.html")).toBe(true);
    expect(isQyerUrl("https://place.qyer.com/xinjiang")).toBe(true);
    expect(isQyerUrl(`${baseUrl}/full.html`)).toBe(false);
    expect(qyerSite.cookieFile).toBe("qyer.json");
  });
});

describe("qyer: 复用马蜂窝分页模式", () => {
  let browser: Browser;

  beforeEach(async () => {
    browser = await chromium.launch({ headless: true });
  });

  afterEach(async () => {
    await browser.close();
  });

  it("沿下一页链接拼接全部页面正文（与 mafengwo 共享 pagination.ts 实现）", async () => {
    const page = await browser.newPage();
    await page.goto(`${baseUrl}/page1.html`, { waitUntil: "domcontentloaded" });

    const { title, text } = await extractPaginatedQyer(page);

    expect(title).toBe("分页游记 第1页");
    expect(text).toContain("第一页正文内容");
    expect(text).toContain("第二页正文内容");
  }, 30000);
});

describe("scrape: 混合批次（可达 + 不可达）", () => {
  it("同一批次处理 1 条可达 URL + 1 条不可达 URL，验证 pick.json 逐条持久化", async () => {
    const reachableUrl = `${baseUrl}/full.html`;
    const unreachablePort = await getUnusedPort();
    const unreachableUrl = `http://127.0.0.1:${unreachablePort}/dead`;

    seedPick([
      { url: reachableUrl, source: "reachable", media_type_guess: "text", method: "scrape", status: "pending" },
      { url: unreachableUrl, source: "unreachable", media_type_guess: "text", method: "scrape", status: "pending" },
    ]);

    // Run scrape
    const result = await runScrape(tripId);

    // 验证整体结果
    expect(result.processed).toBe(2);
    expect(result.full + result.partial).toBe(1); // 1 条可达
    expect(result.failed).toBe(1); // 1 条不可达

    // 验证可达条目三件套齐
    const reachableHash = sha1(reachableUrl);
    const rawDir = path.join(testPilotHome, "workspace", tripId, "raw");
    expect(existsSync(path.join(rawDir, `${reachableHash}.html`))).toBe(true);
    expect(existsSync(path.join(rawDir, `${reachableHash}.txt`))).toBe(true);
    expect(existsSync(path.join(rawDir, `${reachableHash}.meta.json`))).toBe(true);

    // 验证不可达条目标记 failed
    const unreachableHash = sha1(unreachableUrl);
    const unreachableMeta = readJson<{ status: string; reason?: string }>(
      tripId,
      `raw/${unreachableHash}.meta.json`,
    );
    expect(unreachableMeta.status).toBe("failed");
    expect(unreachableMeta.reason).toBeTruthy();

    // 验证 pick.json 包含两条条目的最新状态
    const pick = readJson<{ url: string; status: string }[]>(tripId, "raw/pick.json");
    expect(pick).toHaveLength(2);
    const reachablePick = pick.find((p) => p.url === reachableUrl);
    const unreachablePick = pick.find((p) => p.url === unreachableUrl);
    expect(reachablePick?.status).toBe("scraped");
    expect(unreachablePick?.status).toBe("failed");
  }, 30000);
});

describe("scrape CLI 参数校验", () => {
  it("缺少 --trip 抛 CliError", async () => {
    await expect(main(["run"])).rejects.toThrow(CliError);
  });

  it("未知子命令抛 CliError", async () => {
    await expect(main(["bogus", "--trip", tripId])).rejects.toThrow(CliError);
  });
});
