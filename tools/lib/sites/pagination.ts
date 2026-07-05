import type { Page } from "playwright";
import { extractFromHtml } from "../extract";
import type { ExtractResult } from "./types";

// ---------------------------------------------------------------------------
// PILOT pagination.ts —— 分页游记全量拼接的通用实现，从 mafengwo.ts 抽出，
// 供 mafengwo / qyer 等有「下一页」翻页结构的站点复用。
//
// 正文抽取本身仍走 extract.ts 的通用启发式（不依赖 contentSelector），
// contentSelector 只用于翻页后的渲染等待，选择器不命中时退化为等网络空闲，
// 不影响抽取结果。
// ---------------------------------------------------------------------------

const DEFAULT_MAX_PAGES = 20;
const DEFAULT_WAIT_TIMEOUT_MS = 8000;

export interface PaginationOptions {
  contentSelector: string;
  nextLinkPattern: string;
  maxPages?: number;
  waitTimeoutMs?: number;
}

export async function waitForSelectorOrIdle(
  page: Page,
  selector: string,
  timeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
): Promise<void> {
  try {
    await page.waitForSelector(selector, { timeout: timeoutMs });
  } catch {
    try {
      await page.waitForLoadState("networkidle", { timeout: timeoutMs });
    } catch {
      // 两种等待都超时也继续抽取，交由上层按正文长度判 partial/failed
    }
  }
}

export async function extractPaginatedContent(
  page: Page,
  opts: PaginationOptions,
): Promise<ExtractResult> {
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
  const waitTimeoutMs = opts.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const texts: string[] = [];
  let title = "";
  const visited = new Set<string>();

  for (let i = 0; i < maxPages; i++) {
    const currentUrl = page.url();
    if (visited.has(currentUrl)) break;
    visited.add(currentUrl);

    const html = await page.content();
    const parsed = extractFromHtml(html);
    if (!title && parsed.title) title = parsed.title;
    if (parsed.text) texts.push(parsed.text);

    const nextHref = await page.evaluate((pattern: string) => {
      const re = new RegExp(pattern);
      const links = Array.from(document.querySelectorAll("a"));
      const next = links.find((a) => re.test(a.textContent ?? ""));
      return next ? (next as HTMLAnchorElement).href : null;
    }, opts.nextLinkPattern);

    if (!nextHref || visited.has(nextHref)) break;

    try {
      await page.goto(nextHref, { waitUntil: "domcontentloaded", timeout: 20000 });
      await waitForSelectorOrIdle(page, opts.contentSelector, waitTimeoutMs);
    } catch {
      break; // 翻页失败不影响已拼接到的内容，直接结束
    }
  }

  return { title, text: texts.join("\n\n") };
}
