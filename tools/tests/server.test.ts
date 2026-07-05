import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { createTrip, writeJson } from "../lib/workspace";
import {
  createApp,
  readTiandituKey,
  parseStartArgs,
  CliError,
  type App,
} from "../server/server";

// ---------------------------------------------------------------------------
// fixture: 临时 PILOT_HOME + 一个空 trip（每个用例独立，避免互相污染）
// ---------------------------------------------------------------------------

let testPilotHome: string;
let tripId: string;

beforeEach(() => {
  testPilotHome = mkdtempSync(path.join(tmpdir(), "pilot-server-test-"));
  process.env.PILOT_HOME = testPilotHome;
  const tripPath = createTrip("test-trip");
  tripId = path.basename(tripPath);
});

afterEach(() => {
  delete process.env.PILOT_HOME;
  if (existsSync(testPilotHome)) {
    rmSync(testPilotHome, { recursive: true });
  }
});

async function startApp(opts?: { tiandituKey?: string | null }): Promise<{ app: App; baseUrl: string }> {
  const app = createApp(tripId, opts);
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  await app.ready;
  const address = app.server.address() as AddressInfo;
  return { app, baseUrl: `http://127.0.0.1:${address.port}` };
}

// ---------------------------------------------------------------------------
// ① GET /api/state 聚合正确
// ---------------------------------------------------------------------------

describe("GET /api/state", () => {
  it("只有 intake.json 时，其余字段为 null", async () => {
    writeJson(tripId, "intake.json", { trip_id: tripId, destination: "新疆北疆" });
    const { app, baseUrl } = await startApp();
    try {
      const res = await fetch(`${baseUrl}/api/state`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({
        intake: { trip_id: tripId, destination: "新疆北疆" },
        travelogues: null,
        itinerary: null,
        progress: null,
      });
    } finally {
      await app.close();
    }
  });

  it("三个文件都存在时全部聚合", async () => {
    writeJson(tripId, "intake.json", { trip_id: tripId });
    writeJson(tripId, "travelogues/index.json", [
      { id: "t1", brief: "b", tags: ["自然"], total: 8, url: "https://you.ctrip.com/x" },
    ]);
    writeJson(tripId, "itinerary.json", { trip_id: tripId, status: "draft", days: [] });
    const { app, baseUrl } = await startApp();
    try {
      const res = await fetch(`${baseUrl}/api/state`);
      const body = await res.json();
      expect(body.intake).toEqual({ trip_id: tripId });
      expect(body.travelogues).toEqual([
        { id: "t1", brief: "b", tags: ["自然"], total: 8, url: "https://you.ctrip.com/x" },
      ]);
      expect(body.itinerary).toEqual({ trip_id: tripId, status: "draft", days: [] });
      expect(body.progress).toBeNull();
    } finally {
      await app.close();
    }
  });

  it("空 trip（四个文件都不存在）返回四个 null", async () => {
    const { app, baseUrl } = await startApp();
    try {
      const res = await fetch(`${baseUrl}/api/state`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ intake: null, travelogues: null, itinerary: null, progress: null });
    } finally {
      await app.close();
    }
  });

  it("progress.json 存在时聚合进度字段（长任务体验，spec §10.9）", async () => {
    writeJson(tripId, "progress.json", {
      stage: "fetch",
      current: 12,
      total: 50,
      message: "抓取中: https://example.com",
      updated_at: "2026-07-06T00:00:00.000Z",
    });
    const { app, baseUrl } = await startApp();
    try {
      const res = await fetch(`${baseUrl}/api/state`);
      const body = await res.json();
      expect(body.progress).toEqual({
        stage: "fetch",
        current: 12,
        total: 50,
        message: "抓取中: https://example.com",
        updated_at: "2026-07-06T00:00:00.000Z",
      });
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// ② SSE：改 itinerary.json → 2s 内收到 update 事件
// ---------------------------------------------------------------------------

describe("GET /events (SSE)", () => {
  it(
    "修改 itinerary.json 后 2s 内收到 {type:update, file:itinerary.json}",
    async () => {
      const { app, baseUrl } = await startApp();
      try {
        const received = new Promise<Record<string, unknown>>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("2s 内未收到 SSE 事件")), 2000);
          fetch(`${baseUrl}/events`)
            .then(async (res) => {
              const reader = res.body!.getReader();
              const decoder = new TextDecoder();
              let buf = "";
              for (;;) {
                const { value, done } = await reader.read();
                if (done) break;
                buf += decoder.decode(value, { stream: true });
                const match = buf.match(/data: (\{.*\})\n\n/);
                if (match) {
                  clearTimeout(timer);
                  resolve(JSON.parse(match[1]));
                  reader.cancel().catch(() => {});
                  break;
                }
              }
            })
            .catch(reject);
        });

        // 等 SSE 连接真正建立（chokidar ready 已等过，这里再等一小段防止
        // fetch 的 GET /events 还没被 http.Server 接受就已经写文件）
        await new Promise((r) => setTimeout(r, 150));
        writeJson(tripId, "itinerary.json", { trip_id: tripId, status: "draft", days: [] });

        const payload = await received;
        expect(payload).toEqual({ type: "update", file: "itinerary.json" });
      } finally {
        await app.close();
      }
    },
    8000,
  );
});

// ---------------------------------------------------------------------------
// ③ GET /api/config 有 key / 无 key 两态
// ---------------------------------------------------------------------------

describe("GET /api/config", () => {
  it("有 key 时返回该 key", async () => {
    const { app, baseUrl } = await startApp({ tiandituKey: "test-key-123" });
    try {
      const res = await fetch(`${baseUrl}/api/config`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ tianditu_key: "test-key-123" });
    } finally {
      await app.close();
    }
  });

  it("无 key 时返回 null（不崩）", async () => {
    const { app, baseUrl } = await startApp({ tiandituKey: null });
    try {
      const res = await fetch(`${baseUrl}/api/config`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ tianditu_key: null });
    } finally {
      await app.close();
    }
  });

  it("未传 opts 时默认 null", async () => {
    const { app, baseUrl } = await startApp();
    try {
      const res = await fetch(`${baseUrl}/api/config`);
      expect(await res.json()).toEqual({ tianditu_key: null });
    } finally {
      await app.close();
    }
  });
});

describe("readTiandituKey", () => {
  it("优先读 process.env.TIANDITU_KEY", () => {
    expect(readTiandituKey({ TIANDITU_KEY: "from-env" } as NodeJS.ProcessEnv, "/nonexistent")).toBe(
      "from-env",
    );
  });

  it("process.env 无值时回退解析项目根 .env", () => {
    const root = mkdtempSync(path.join(tmpdir(), "pilot-dotenv-test-"));
    writeFileSync(path.join(root, ".env"), "# 注释行\nTIANDITU_KEY=abc123\nOTHER=xyz\n");
    try {
      expect(readTiandituKey({} as NodeJS.ProcessEnv, root)).toBe("abc123");
    } finally {
      rmSync(root, { recursive: true });
    }
  });

  it(".env 不存在时返回 null", () => {
    const root = mkdtempSync(path.join(tmpdir(), "pilot-dotenv-empty-"));
    try {
      expect(readTiandituKey({} as NodeJS.ProcessEnv, root)).toBeNull();
    } finally {
      rmSync(root, { recursive: true });
    }
  });

  it(".env 存在但没有 TIANDITU_KEY 时返回 null", () => {
    const root = mkdtempSync(path.join(tmpdir(), "pilot-dotenv-nokey-"));
    writeFileSync(path.join(root, ".env"), "OTHER=xyz\n");
    try {
      expect(readTiandituKey({} as NodeJS.ProcessEnv, root)).toBeNull();
    } finally {
      rmSync(root, { recursive: true });
    }
  });
});

// ---------------------------------------------------------------------------
// ④ 静态文件 200（+ 未知路径 404 / 非 GET 405 补充覆盖）
// ---------------------------------------------------------------------------

describe("静态文件", () => {
  it("GET / 返回 index.html", async () => {
    const { app, baseUrl } = await startApp();
    try {
      const res = await fetch(`${baseUrl}/`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(await res.text()).toContain("<html");
    } finally {
      await app.close();
    }
  });

  it("GET /assets/app.js 返回 200", async () => {
    const { app, baseUrl } = await startApp();
    try {
      const res = await fetch(`${baseUrl}/assets/app.js`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("javascript");
    } finally {
      await app.close();
    }
  });

  it("GET /assets/style.css 返回 200", async () => {
    const { app, baseUrl } = await startApp();
    try {
      const res = await fetch(`${baseUrl}/assets/style.css`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("css");
    } finally {
      await app.close();
    }
  });

  it("GET /assets/maplibre-gl.js 返回 200（直读 node_modules，非 CDN）", async () => {
    const { app, baseUrl } = await startApp();
    try {
      const res = await fetch(`${baseUrl}/assets/maplibre-gl.js`);
      expect(res.status).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("GET /assets/maplibre-gl.css 返回 200", async () => {
    const { app, baseUrl } = await startApp();
    try {
      const res = await fetch(`${baseUrl}/assets/maplibre-gl.css`);
      expect(res.status).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("未知路径返回 404", async () => {
    const { app, baseUrl } = await startApp();
    try {
      const res = await fetch(`${baseUrl}/nope`);
      expect(res.status).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("非 GET 方法返回 405", async () => {
    const { app, baseUrl } = await startApp();
    try {
      const res = await fetch(`${baseUrl}/api/state`, { method: "POST" });
      expect(res.status).toBe(405);
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// createApp / CLI 参数解析
// ---------------------------------------------------------------------------

describe("createApp", () => {
  it("对不存在的 trip 立即抛错（fail fast）", () => {
    expect(() => createApp("nonexistent-trip-20260101")).toThrow();
  });

  it("只绑定 127.0.0.1，不暴露到 LAN（spec 承诺 localhost-only）", async () => {
    const { app } = await startApp();
    try {
      const address = app.server.address() as AddressInfo;
      expect(address.address).toBe("127.0.0.1");
    } finally {
      await app.close();
    }
  });
});

describe("parseStartArgs", () => {
  it("解析 --trip 与 --port", () => {
    expect(parseStartArgs(["start", "--trip", "foo-20260101", "--port", "5000"])).toEqual({
      tripId: "foo-20260101",
      port: 5000,
    });
  });

  it("--port 缺省时使用 4870", () => {
    expect(parseStartArgs(["start", "--trip", "foo-20260101"])).toEqual({
      tripId: "foo-20260101",
      port: 4870,
    });
  });

  it("缺 --trip 抛 CliError", () => {
    expect(() => parseStartArgs(["start"])).toThrow(CliError);
  });

  it("非 start 子命令抛 CliError", () => {
    expect(() => parseStartArgs(["stop", "--trip", "x"])).toThrow(CliError);
  });

  it("非法端口抛 CliError", () => {
    expect(() => parseStartArgs(["start", "--trip", "x", "--port", "abc"])).toThrow(CliError);
  });
});
