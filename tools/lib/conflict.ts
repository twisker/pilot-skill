// ---------------------------------------------------------------------------
// PILOT lib/conflict.ts —— check.ts 的纯算法层（距离 / 时长文本解析 / 关键词表）
//
// 全部函数无副作用、不碰文件系统，便于独立单测。check.ts 只做 CLI + 规则编排
// + 文件 I/O，具体的数值/文本计算都在这里（同 lib/fingerprint.ts 的分层原则）。
// ---------------------------------------------------------------------------

export interface LatLng {
  lat: number;
  lng: number;
}

const EARTH_RADIUS_KM = 6371;

/**
 * Haversine 大圆距离（公里）。用于 R-09（相邻坐标距离异常）。
 */
export function haversineKm(a: LatLng, b: LatLng): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  return EARTH_RADIUS_KM * c;
}

/**
 * 从 transit 条目的 note 文本中解析驾车时长（小时）。用于 C-01。
 *
 * 支持「X小时」「X.X小时」「X个小时」。解析不到返回 null。
 *
 * 设计说明：conflict-rules.md 的 v4 字段对照表明确写着 C-01 的驾车时长
 * "从 note 文本解析"，未提及坐标估算兜底，因此本函数不做 geo 距离/80km/h
 * 的估算兜底 —— 严格按规范文本的唯一来源实现，避免引入规范未定义的启发式
 * （也避免与 R-09 的"坐标距离异常"检测产生混淆的重叠判定）。
 */
export function parseDrivingHours(note: string): number | null {
  const match = note.match(/(\d+(?:\.\d+)?)\s*(?:个)?\s*小时/);
  if (!match) return null;
  return Number(match[1]);
}

/**
 * C-07 高强度活动关键词表（冻结常量，非 config——规则本身是确定性规则，
 * 关键词随行程内容语义变化不大，改动应走代码 review 而非运行时配置）。
 */
/**
 * R-09 距离阈值（2026-07-05 主控裁定，两处提为具名常量）：
 *   - 同日内相邻 geo 条目：>300km 视为坐标疑似错误（自驾单日几乎不可能）。
 *   - 跨天（第 N 天末条目 → 第 N+1 天首条目）：跨天含正常长途驾驶日，阈值
 *     放宽到 >600km 才 warn，避免把合理的长途转场日误判为坐标错误。
 */
export const R09_SAME_DAY_THRESHOLD_KM = 300;
export const R09_CROSS_DAY_THRESHOLD_KM = 600;

export const HIGH_INTENSITY_KEYWORDS: readonly string[] = [
  "徒步",
  "攀登",
  "登山",
  "骑行",
  "漂流",
  "蹦极",
  "攀岩",
  "滑雪",
  "穿越",
  "涉水",
  "高海拔",
];
