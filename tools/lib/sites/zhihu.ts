import type { Page } from "playwright";
import { extractFromHtml } from "../extract";
import type { SiteAdapter } from "./types";
import { waitForSelectorOrIdle } from "./pagination";

const ZHIHU_DOMAINS = ["zhihu.com", "zhuanlan.zhihu.com"];
// 知乎文章/回答正文的常见 RichText 容器；命中与否只影响渲染等待策略，
// 抽取本身始终走 extract.ts 的通用启发式，选择器不命中时兜底到等网络空闲。
const CONTENT_SELECTOR = ".RichText, .Post-RichText, .AnswerItem .RichText";
const COOKIE_FILE = "zhihu.json";

export function isZhihuUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return ZHIHU_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
  } catch {
    return false;
  }
}

async function waitForRender(page: Page): Promise<void> {
  await waitForSelectorOrIdle(page, CONTENT_SELECTOR);
}

export const zhihuSite: SiteAdapter = {
  match: isZhihuUrl,
  prepare: waitForRender,

  async extract(page: Page) {
    const html = await page.content();
    return extractFromHtml(html);
  },

  cookieFile: COOKIE_FILE,
};
