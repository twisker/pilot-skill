// ---------------------------------------------------------------------------
// PILOT fingerprint.ts —— distill.ts 的纯算法层（路线指纹 / 相似度 / 确定性评分）
//
// 全部函数无副作用、不碰文件系统，便于独立单测。distill.ts 只做 CLI + 文件 I/O，
// 具体算法都在这里。
// ---------------------------------------------------------------------------

export interface Poi {
  name: string;
  kind: "sight" | "meal" | "hotel" | "transit";
  note: string;
}

export interface RouteDay {
  day: number;
  pois: Poi[];
  transport: string;
  stay?: string | null;
}

export interface Travelogue {
  id: string;
  meta: {
    title: string;
    author: string;
    source: {
      url: string;
      platform: string;
      media_type: "text" | "video" | "image-set";
    };
    published_at?: string | null;
    fetch_quality: "full" | "partial" | "summary-only";
  };
  summary: {
    brief: string;
    tags: string[];
  };
  route: {
    days: RouteDay[];
  };
  quality: {
    deterministic: {
      completeness: number;
      granularity: number;
      media_richness: number;
      freshness: number;
    };
    taste_score?: number | null;
    total?: number | null;
  };
}

export interface DeterministicScore {
  completeness: number;
  granularity: number;
  media_richness: number;
  freshness: number;
}

// ---------------------------------------------------------------------------
// 指纹 / 相似度（dedupe 用）
//
// 相似度 = 0.5*Jaccard(全 POI 集合) + 0.5*(LCS(逐日序列)/max_len)，阈值 0.75 判重。
// ---------------------------------------------------------------------------

/** 每天 POI 名称有序序列（fingerprint 的基本单位） */
export function dailyPoiSequences(t: Travelogue): string[][] {
  return t.route.days.map((d) => d.pois.map((p) => p.name));
}

/** 逐日序列串接后的 POI 全序列（按 day 顺序展开，用于 LCS） */
export function flattenPoiSequence(t: Travelogue): string[] {
  return dailyPoiSequences(t).flat();
}

/** 全 POI 集合（去重，用于 Jaccard） */
export function poiSet(t: Travelogue): Set<string> {
  return new Set(flattenPoiSequence(t));
}

/** 两个集合的 Jaccard 相似度；两个空集合定义为 0（避免 0/0） */
export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** 最长公共子序列长度（标准 DP，O(n*m)） */
export function lcsLength(a: string[], b: string[]): number {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return 0;
  let prev = new Array<number>(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    const cur = new Array<number>(m + 1).fill(0);
    for (let j = 1; j <= m; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    prev = cur;
  }
  return prev[m];
}

export const DUPLICATE_THRESHOLD = 0.75;

/** 两篇游记的相似度：0.5*Jaccard(全 POI 集合) + 0.5*(LCS(逐日序列)/max_len) */
export function poiSimilarity(a: Travelogue, b: Travelogue): number {
  const seqA = flattenPoiSequence(a);
  const seqB = flattenPoiSequence(b);
  const maxLen = Math.max(seqA.length, seqB.length);
  const jaccard = jaccardSimilarity(poiSet(a), poiSet(b));
  const lcsRatio = maxLen === 0 ? 0 : lcsLength(seqA, seqB) / maxLen;
  return 0.5 * jaccard + 0.5 * lcsRatio;
}

// ---------------------------------------------------------------------------
// 确定性评分四项（score 子命令写回 quality.deterministic）
//
// 注：travelogue schema（v4.0 冻结）没有显式「声称天数」「图片数」字段，以下
// 两项启发式取值为工程判断，已在 task-8-report.md 中标注供内部复核：
//   - completeness 的分母「声称天数」用标题里的 "N天/N日" 数字启发式解析；
//     解析不到时不做无据惩罚，退化为「声称天数 = 实际天数」（除非实际天数为
//     0，此时天然是 0 分，无需特判 fetch_quality）。
//   - media_richness 没有图片数字段，用 media_type（主，权重 0.7）+ POI 备注
//     平均长度（次，权重 0.3，作为内容丰富度的代理信号）加权。
// ---------------------------------------------------------------------------

/** 从标题解析「声称天数」，如"北疆9天自驾环线" → 9；解析不到返回 null */
export function extractClaimedDays(title: string): number | null {
  const m = title.match(/(\d+)\s*[天日]/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function completeness(t: Travelogue): number {
  const actualDays = t.route.days.length;
  const claimed = extractClaimedDays(t.meta.title) ?? Math.max(actualDays, 1);
  if (claimed <= 0) return 0;
  return Math.min(1, actualDays / claimed);
}

export function granularity(t: Travelogue): number {
  const days = t.route.days.length;
  if (days === 0) return 0;
  const totalPois = t.route.days.reduce((sum, d) => sum + d.pois.length, 0);
  const avgPerDay = totalPois / days;
  return Math.min(1, avgPerDay / 4);
}

const MEDIA_TYPE_SCORE: Record<Travelogue["meta"]["source"]["media_type"], number> = {
  "image-set": 1,
  video: 0.7,
  text: 0.4,
};

function noteRichness(t: Travelogue): number {
  const pois = t.route.days.flatMap((d) => d.pois);
  if (pois.length === 0) return 0;
  const avgLen = pois.reduce((sum, p) => sum + p.note.length, 0) / pois.length;
  return Math.min(1, avgLen / 30);
}

export function mediaRichness(t: Travelogue): number {
  const base = MEDIA_TYPE_SCORE[t.meta.source.media_type] ?? 0.4;
  return 0.7 * base + 0.3 * noteRichness(t);
}

const FRESHNESS_HALF_LIFE_YEARS = 2;
const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;

/** published_at 为 null 时给中性值 0.5；否则按 2 年半衰指数衰减 */
export function freshness(publishedAt: string | null | undefined, now: Date = new Date()): number {
  if (!publishedAt) return 0.5;
  const published = new Date(`${publishedAt}T00:00:00Z`);
  if (Number.isNaN(published.getTime())) return 0.5;
  const ageYears = (now.getTime() - published.getTime()) / MS_PER_YEAR;
  const score = Math.pow(0.5, ageYears / FRESHNESS_HALF_LIFE_YEARS);
  return Math.max(0, Math.min(1, score));
}

export function scoreDeterministic(t: Travelogue, now: Date = new Date()): DeterministicScore {
  return {
    completeness: completeness(t),
    granularity: granularity(t),
    media_richness: mediaRichness(t),
    freshness: freshness(t.meta.published_at ?? null, now),
  };
}

export function deterministicMean(d: DeterministicScore): number {
  return (d.completeness + d.granularity + d.media_richness + d.freshness) / 4;
}

/** dedupe 判重后的排序分：优先 quality.total（0-10），缺失则用 deterministic 均值（0-1）乘以 10 统一量纲 */
export function dedupeRankScore(t: Travelogue): number {
  if (typeof t.quality.total === "number") return t.quality.total;
  return deterministicMean(t.quality.deterministic) * 10;
}

/** index 排序用 total：0.6*deterministic均值*10 + 0.4*taste_score；无 taste 时纯 deterministic */
export function indexTotal(t: Travelogue): number {
  const detMean10 = deterministicMean(t.quality.deterministic) * 10;
  const taste = t.quality.taste_score;
  if (typeof taste === "number") {
    return 0.6 * detMean10 + 0.4 * taste;
  }
  return detMean10;
}
