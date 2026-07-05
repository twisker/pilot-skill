import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { atomicWriteFileSync } from "./workspace";

// ---------------------------------------------------------------------------
// PILOT 匿名遥测客户端库（spec §10.4a）
//
// 隐私契约（收集什么 / 不收集什么）：
//   - install_id：本地随机 UUID（~/.pilot/telemetry.json），不含任何身份信息，
//     不与账号/邮箱/设备指纹关联
//   - 事件白名单（EVENT_PROPS，白名单外 track 直接 no-op）：
//       install          安装/首次运行           props: 无
//       trip_created     trip 创建               props: destination（目的地粗粒度，
//                        城市/地区级字符串）、days（天数）。不带对话内容、
//                        不带 intake 全文、不带人群/预算细节
//       export           路书导出                props: format（docx/pdf/xlsx）
//       reco_impression  产品推荐曝光（窗口 1 整包产品，纯语义）
//                        props: product_id、match_score
//       reco_dismissed   产品推荐被拒绝          props: product_id（用户明确拒绝
//                        或冷淡回应后记录，本 trip 内不再推荐，spec §10.4b-3）
//       booking_link_shown  booking 短链曝光（窗口 2，与产品推荐语义分离）
//                        props: code（短码，取 affiliate_url 中 /r/ 后的段）
//   - 关闭方式（任一即全局 no-op）：
//       1) 环境变量 PILOT_TELEMETRY=off
//       2) ~/.pilot/telemetry.json 的 enabled 置 false
//
// 上报机制：track() 只追加本地队列（~/.pilot/telemetry-queue.jsonl），
// flush() 才批量 POST 到链接服务 /t。endpoint 读 config/pilot.json 的
// telemetry.endpoint —— **当前默认 null = 只落盘不上报**，链接服务部署后
// 才改为真实 URL。离线/失败容忍：POST 失败队列原样保留；队列超 1000 条
// 丢最旧。track/flush 永不抛异常（遥测绝不能打断主流程）。
// ---------------------------------------------------------------------------

export const TELEMETRY_EVENTS = [
  "install",
  "trip_created",
  "export",
  "reco_impression",
  "reco_dismissed",
  "booking_link_shown",
] as const;

export type TelemetryEventName = (typeof TELEMETRY_EVENTS)[number];

/** 事件 → 允许的 props 键（与 services/link-service 服务端白名单一致） */
export const EVENT_PROPS: Record<TelemetryEventName, readonly string[]> = {
  install: [],
  trip_created: ["destination", "days"],
  export: ["format"],
  reco_impression: ["product_id", "match_score"],
  reco_dismissed: ["product_id"],
  booking_link_shown: ["code"],
};

export const QUEUE_MAX = 1000;

export interface TelemetryState {
  install_id: string;
  created_at: string;
  enabled: boolean;
}

export interface QueuedEvent {
  event: TelemetryEventName;
  ts: string;
  props: Record<string, string | number | boolean>;
}

function pilotHome(): string {
  return process.env.PILOT_HOME || path.join(homedir(), ".pilot");
}

function statePath(): string {
  return path.join(pilotHome(), "telemetry.json");
}

function queuePath(): string {
  return path.join(pilotHome(), "telemetry-queue.jsonl");
}

// ---------------------------------------------------------------------------
// 状态文件（install_id / enabled）
// ---------------------------------------------------------------------------

/** telemetry.json 解析失败（损坏）时返回的保守占位状态：不重建文件、不重发 install 事件 */
const CORRUPT_STATE: TelemetryState = { install_id: "", created_at: "", enabled: false };

/**
 * 读取遥测状态；文件不存在则首次生成（UUID + created_at + enabled:true），
 * 并顺带入队一条 install 事件（安装 = 首次生成 install_id）。
 *
 * 文件存在但损坏（非法 JSON）→ 按 disabled 保守处理：**不重建/覆盖文件、
 * 不重发 install 事件**（避免每次损坏读取都悄悄生成新 install_id、污染
 * 安装量统计；也避免用一次解析异常当作理由覆盖用户本地状态）。人工修复
 * 或删除该文件后才会恢复正常。
 */
export function ensureTelemetryState(): TelemetryState {
  const p = statePath();
  if (existsSync(p)) {
    try {
      const parsed = JSON.parse(readFileSync(p, "utf-8")) as Partial<TelemetryState>;
      if (typeof parsed.install_id === "string" && parsed.install_id) {
        return {
          install_id: parsed.install_id,
          created_at: typeof parsed.created_at === "string" ? parsed.created_at : "",
          enabled: parsed.enabled !== false,
        };
      }
    } catch {
      return CORRUPT_STATE;
    }
  }
  const state: TelemetryState = {
    install_id: randomUUID(),
    created_at: new Date().toISOString(),
    enabled: true,
  };
  atomicWriteFileSync(p, JSON.stringify(state, null, 2));
  appendToQueue({ event: "install", ts: state.created_at, props: {} });
  return state;
}

/**
 * PILOT_TELEMETRY=off 或 telemetry.json enabled:false → 全局关闭。
 * 文件损坏（非法 JSON）→ 同样按 disabled 处理（保守：宁可漏报也不在状态
 * 不可信时继续采集/重建），与 ensureTelemetryState 的 CORRUPT_STATE 口径一致。
 */
export function telemetryEnabled(): boolean {
  if ((process.env.PILOT_TELEMETRY || "").toLowerCase() === "off") return false;
  const p = statePath();
  if (!existsSync(p)) return true; // 状态文件由首次 track 时生成
  try {
    const parsed = JSON.parse(readFileSync(p, "utf-8")) as Partial<TelemetryState>;
    return parsed.enabled !== false;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 本地队列（jsonl 追加，上限 QUEUE_MAX，超限丢最旧）
// ---------------------------------------------------------------------------

export function readQueue(): QueuedEvent[] {
  const p = queuePath();
  if (!existsSync(p)) return [];
  const events: QueuedEvent[] = [];
  for (const line of readFileSync(p, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as QueuedEvent);
    } catch {
      // 坏行跳过
    }
  }
  return events;
}

function writeQueue(events: QueuedEvent[]): void {
  const body = events.map((e) => JSON.stringify(e)).join("\n");
  atomicWriteFileSync(queuePath(), body ? `${body}\n` : "");
}

function appendToQueue(event: QueuedEvent): void {
  const events = readQueue();
  events.push(event);
  // 超上限丢最旧
  writeQueue(events.slice(Math.max(0, events.length - QUEUE_MAX)));
}

// ---------------------------------------------------------------------------
// track / flush
// ---------------------------------------------------------------------------

function filterProps(
  event: TelemetryEventName,
  props: Record<string, unknown> | undefined
): Record<string, string | number | boolean> {
  const allowed = EVENT_PROPS[event];
  const out: Record<string, string | number | boolean> = {};
  if (!props) return out;
  for (const [key, value] of Object.entries(props)) {
    if (!allowed.includes(key)) continue;
    if (typeof value === "string") out[key] = value.slice(0, 200);
    else if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
    else if (typeof value === "boolean") out[key] = value;
  }
  return out;
}

/**
 * 记录一条事件到本地队列。白名单外事件 / 遥测关闭 → no-op。
 * 永不抛异常。返回是否实际入队（便于测试断言）。
 */
export function track(event: string, props?: Record<string, unknown>): boolean {
  try {
    if (!telemetryEnabled()) return false;
    if (!(TELEMETRY_EVENTS as readonly string[]).includes(event)) return false;
    const name = event as TelemetryEventName;
    ensureTelemetryState();
    appendToQueue({
      event: name,
      ts: new Date().toISOString(),
      props: filterProps(name, props),
    });
    return true;
  } catch {
    return false;
  }
}

/** 读 config/pilot.json 的 telemetry.endpoint；null/缺失 = 不上报 */
export function readTelemetryEndpoint(
  configPath: string = path.resolve(__dirname, "../../config/pilot.json")
): string | null {
  try {
    const config = JSON.parse(readFileSync(configPath, "utf-8")) as {
      telemetry?: { endpoint?: string | null };
    };
    const endpoint = config.telemetry?.endpoint;
    return typeof endpoint === "string" && endpoint ? endpoint : null;
  } catch {
    return null;
  }
}

export interface FlushResult {
  sent: number;
  kept: number;
  reason?: string;
}

/**
 * 批量上报队列到链接服务 /t。
 * - endpoint 为 null（当前默认）→ 不上报，队列原样保留
 * - POST 失败/网络错误 → 队列原样保留（下次再试）
 * - 成功 → 清空队列
 * 永不抛异常。opts 供测试注入 endpoint/fetch。
 */
export async function flush(opts?: {
  endpoint?: string | null;
  fetchImpl?: typeof fetch;
}): Promise<FlushResult> {
  try {
    if (!telemetryEnabled()) return { sent: 0, kept: 0, reason: "遥测已关闭" };
    const endpoint = opts?.endpoint !== undefined ? opts.endpoint : readTelemetryEndpoint();
    const events = readQueue();
    if (events.length === 0) return { sent: 0, kept: 0 };
    if (!endpoint) {
      return { sent: 0, kept: events.length, reason: "endpoint 未配置（只落盘不上报）" };
    }
    const state = ensureTelemetryState();
    const doFetch = opts?.fetchImpl ?? fetch;
    const res = await doFetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ install_id: state.install_id, events }),
    });
    if (!res.ok) {
      return { sent: 0, kept: events.length, reason: `HTTP ${res.status}` };
    }
    writeQueue([]);
    return { sent: events.length, kept: 0 };
  } catch (err) {
    const kept = (() => {
      try {
        return readQueue().length;
      } catch {
        return 0;
      }
    })();
    return { sent: 0, kept, reason: err instanceof Error ? err.message : String(err) };
  }
}
