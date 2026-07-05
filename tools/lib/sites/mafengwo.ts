import type { Page } from "playwright";
import type { ExtractResult, SiteAdapter } from "./types";
import { extractPaginatedContent, waitForSelectorOrIdle } from "./pagination";

const MAFENGWO_DOMAIN = "mafengwo.cn";
const MAX_PAGES = 20; // 分页游记安全上限，避免死循环
const CONTENT_SELECTOR = ".vc_article";
const NEXT_LINK_PATTERN = "下一页|下页";
const COOKIE_FILE = "mafengwo.json";

export function isMafengwoUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === MAFENGWO_DOMAIN || host.endsWith(`.${MAFENGWO_DOMAIN}`);
  } catch {
    return false;
  }
}

async function waitForRender(page: Page): Promise<void> {
  await waitForSelectorOrIdle(page, CONTENT_SELECTOR);
}

/**
 * 分页游记全量拼接：沿「下一页/下页」链接逐页抓取正文并拼接，直到无下一页
 * 或达到 maxPages 上限。翻页文案匹配是唯一与马蜂窝强绑定的部分，其余复用
 * extract.ts 的通用抽取（经由 pagination.ts 共享实现），因此可脱离真实马蜂窝
 * 页面、用本地 fixture 单测。
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

export const mafengwoSite: SiteAdapter = {
  match: isMafengwoUrl,
  prepare: waitForRender,
  extract: (page: Page) => extractPaginated(page),
  cookieFile: COOKIE_FILE,
};
