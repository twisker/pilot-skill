import type { Page } from "playwright";
import type { ExtractResult, SiteAdapter } from "./types";
import { extractPaginatedContent, waitForSelectorOrIdle } from "./pagination";

const QYER_DOMAIN = "qyer.com";
const MAX_PAGES = 20; // 分页帖子安全上限，与 mafengwo 一致，避免死循环
// 穷游帖子正文常见容器（论坛帖 bbs.qyer.com / 地点页 place.qyer.com）；
// 命中与否只影响渲染等待策略，抽取仍走 extract.ts 的通用启发式。
const CONTENT_SELECTOR = ".post_content, .qyer-content, .bbs-content";
const NEXT_LINK_PATTERN = "下一页|下页";
const COOKIE_FILE = "qyer.json";

export function isQyerUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === QYER_DOMAIN || host.endsWith(`.${QYER_DOMAIN}`);
  } catch {
    return false;
  }
}

async function waitForRender(page: Page): Promise<void> {
  await waitForSelectorOrIdle(page, CONTENT_SELECTOR);
}

/**
 * 穷游帖子分页拼接：复用 mafengwo 的分页模式（pagination.ts 共享实现），
 * 沿「下一页/下页」链接逐页拼接正文，直到无下一页或达到 maxPages 上限。
 */
export async function extractPaginated(
  page: Page,
  opts: { maxPages?: number } = {},
): Promise<ExtractResult> {
  return extractPaginatedContent(page, {
    contentSelector: CONTENT_SELECTOR,
    nextLinkPattern: NEXT_LINK_PATTERN,
    maxPages: opts.maxPages ?? MAX_PAGES,
  });
}

export const qyerSite: SiteAdapter = {
  match: isQyerUrl,
  prepare: waitForRender,
  extract: (page: Page) => extractPaginated(page),
  cookieFile: COOKIE_FILE,
};
