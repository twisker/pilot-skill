// ---------------------------------------------------------------------------
// PILOT extract.ts —— 通用正文抽取（启发式：最长文本块 + 段落密度）
//
// 纯字符串/正则处理，不依赖 playwright，可脱离浏览器单测。站点适配层
// （generic.ts / xhs.ts 等）拿 page.content() 渲染后的 HTML 字符串喂进来。
// ---------------------------------------------------------------------------

export interface ExtractResult {
  title: string;
  text: string;
}

const BOILERPLATE_TAGS = ["script", "style", "noscript", "template", "nav", "header", "footer", "aside"];

function stripBoilerplate(html: string): string {
  let out = html.replace(/<!--[\s\S]*?-->/g, " ");
  for (const tag of BOILERPLATE_TAGS) {
    const re = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi");
    out = out.replace(re, " ");
  }
  return out;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function textOf(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 优先取 <h1>，其次 <title>，都没有则空字符串。
 */
export function extractTitle(html: string): string {
  const h1 = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1) {
    const t = textOf(h1[1]);
    if (t) return t;
  }
  const titleTag = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  if (titleTag) {
    const t = textOf(titleTag[1]);
    if (t) return t;
  }
  return "";
}

/**
 * 提取标签名平衡的顶层块（如最外层 <div>...</div>），用手动深度计数配对
 * 开闭标签，避免正则贪婪/非贪婪在嵌套同名标签下匹配错位（例如 <div> 套 <div>）。
 */
function extractBalancedBlocks(html: string, tagName: string): string[] {
  const blocks: string[] = [];
  const tagRe = new RegExp(`<(/?)${tagName}\\b[^>]*?(/?)>`, "gi");
  let depth = 0;
  let start = -1;
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(html))) {
    const isClose = match[1] === "/";
    const isSelfClose = match[2] === "/";
    if (isSelfClose) continue;
    if (!isClose) {
      if (depth === 0) start = match.index;
      depth++;
    } else if (depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) {
        blocks.push(html.slice(start, match.index + match[0].length));
        start = -1;
      }
    }
  }
  return blocks;
}

function bestBlockText(html: string, tagName: string, minDensity: number, minLength: number): string {
  const blocks = extractBalancedBlocks(html, tagName);
  let best = "";
  for (const block of blocks) {
    const text = textOf(block);
    if (text.length < minLength) continue;
    const density = text.length / block.length;
    if (density < minDensity) continue;
    if (text.length > best.length) best = text;
  }
  return best;
}

function paragraphText(html: string): string {
  const matches = [...html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)];
  const allTexts = matches.map((m) => textOf(m[1])).filter((t) => t.length > 0);
  // 过滤导航/按钮类短 p（如“更多”“分享”），保留正文段落；
  // 若全文没有一条「像样」的段落（真实页面本就很短），退化为不过滤，避免把仅有的内容清空。
  const substantial = allTexts.filter((t) => t.length >= 15);
  const parts = substantial.length > 0 ? substantial : allTexts;
  return parts.join("\n");
}

/**
 * 启发式正文抽取：最长文本块 + 段落密度。
 * 1. 先合并全文 <p> 段落；若总长 ≥200 字，认为已覆盖正文，直接返回。
 * 2. 否则退化为在 <article>/<div> 顶层块中找「文本密度高且最长」的块
 *    （density = 纯文本长度 / 块原始 HTML 长度，过滤掉菜单/侧栏等标签多文字少的容器）。
 * 3. 三个候选（段落拼接 / article 块 / div 块）取最长者。
 */
export function extractMainText(rawHtml: string): string {
  const html = stripBoilerplate(rawHtml);
  const pText = paragraphText(html);
  if (pText.length >= 200) return pText;

  const articleText = bestBlockText(html, "article", 0.08, 200);
  const divText = bestBlockText(html, "div", 0.15, 200);

  const candidates = [pText, articleText, divText].sort((a, b) => b.length - a.length);
  return candidates[0] ?? "";
}

export function extractFromHtml(html: string): ExtractResult {
  return {
    title: extractTitle(html),
    text: extractMainText(html),
  };
}
