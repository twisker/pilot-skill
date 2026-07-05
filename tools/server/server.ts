import http from "node:http";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import chokidar from "chokidar";
import { tripDir, readJson } from "../lib/workspace";

// ---------------------------------------------------------------------------
// PILOT server.ts —— localhost 只读 UI（时间线 / 地图 / 参考游记卡片墙）
//
//   start --trip <id> [--port 4870]
//     零框架 node:http 静态服务 + 3 个只读端点：
//       GET /api/state   聚合 intake.json / travelogues/index.json / itinerary.json
//                        （文件不存在则对应字段为 null，不报错）
//       GET /api/config  下发 {tianditu_key}（读项目根 .env，key 本身绝不写入
//                        任何入库文件；缺失时前端显示引导文案，不崩）
//       GET /events      SSE；chokidar 监听 trip 目录 *.json 与 travelogues/，
//                        变化推 `data: {"type":"update","file":"<相对路径>"}`；
//                        30s 心跳注释行防代理超时
//
// server 是 B→C 演进承诺的未来内核，V1 只读：不接受任何写请求（非 GET 一律 405）。
// ---------------------------------------------------------------------------

export class CliError extends Error {}

const DEFAULT_PORT = 4870;
const HEARTBEAT_MS = 30_000;

// ---------------------------------------------------------------------------
// /api/state —— 聚合读取（文件缺失 → null，不抛错）
// ---------------------------------------------------------------------------

export interface StateResponse {
  intake: unknown | null;
  travelogues: unknown | null;
  itinerary: unknown | null;
}

function tryReadJson<T>(tripId: string, relPath: string): T | null {
  try {
    return readJson<T>(tripId, relPath);
  } catch {
    return null;
  }
}

export function readStateSafe(tripId: string): StateResponse {
  return {
    intake: tryReadJson(tripId, "intake.json"),
    travelogues: tryReadJson(tripId, "travelogues/index.json"),
    itinerary: tryReadJson(tripId, "itinerary.json"),
  };
}

// ---------------------------------------------------------------------------
// /api/config —— TIANDITU_KEY 读取（process.env 优先，其次项目根 .env 逐行解析；
// 不引 dotenv 依赖）
// ---------------------------------------------------------------------------

function parseDotEnv(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) result[key] = value;
  }
  return result;
}

/**
 * 读取 TIANDITU_KEY。projectRoot 默认 tools/server/ 的上两级（仓库根）。
 * env/projectRoot 参数用于单测注入，避免依赖真实 .env 内容。
 */
export function readTiandituKey(
  env: NodeJS.ProcessEnv = process.env,
  projectRoot: string = path.resolve(__dirname, "../.."),
): string | null {
  if (env.TIANDITU_KEY) return env.TIANDITU_KEY;
  const envPath = path.join(projectRoot, ".env");
  if (!existsSync(envPath)) return null;
  const parsed = parseDotEnv(readFileSync(envPath, "utf-8"));
  return parsed.TIANDITU_KEY || null;
}

// ---------------------------------------------------------------------------
// 静态资源路由表
//
// maplibre-gl 资产方案：不拷贝/不打包，直接用 require.resolve 定位
// node_modules/maplibre-gl/dist/{js,css} 并在请求时读盘返回——避免额外构建
// 步骤，也避免把 ~1MB 的 vendored 二进制提交进 git（node_modules 本身已被
// .gitignore 排除，`npm i maplibre-gl` 是唯一需要的"安装"动作）。
// ---------------------------------------------------------------------------

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

const SERVER_DIR = path.resolve(__dirname);

function staticRoutes(): Record<string, string> {
  return {
    "/": path.join(SERVER_DIR, "index.html"),
    "/index.html": path.join(SERVER_DIR, "index.html"),
    "/assets/app.js": path.join(SERVER_DIR, "assets", "app.js"),
    "/assets/style.css": path.join(SERVER_DIR, "assets", "style.css"),
    "/assets/maplibre-gl.js": require.resolve("maplibre-gl/dist/maplibre-gl.js"),
    "/assets/maplibre-gl.css": require.resolve("maplibre-gl/dist/maplibre-gl.css"),
  };
}

// ---------------------------------------------------------------------------
// createApp —— server 主体（http.Server + SSE 广播 + chokidar 监听）
// ---------------------------------------------------------------------------

export interface AppOptions {
  tiandituKey?: string | null;
}

export interface App {
  server: http.Server;
  /** chokidar 完成初始扫描后 resolve；测试/CLI 用它避免"写太早、事件没订阅上"的竞态 */
  ready: Promise<void>;
  close: () => Promise<void>;
}

export function createApp(tripId: string, opts: AppOptions = {}): App {
  const dir = tripDir(tripId); // trip 不存在则在此立刻抛错，fail fast
  const tiandituKey = opts.tiandituKey ?? null;
  const routes = staticRoutes();

  const sseClients = new Set<http.ServerResponse>();
  function broadcast(payload: unknown): void {
    const line = `data: ${JSON.stringify(payload)}\n\n`;
    for (const res of sseClients) res.write(line);
  }

  // chokidar v5+ 移除了 glob 支持（README 265 行），只能传目录/文件路径。
  // depth:0 让 dir 根只看直接子项（覆盖 intake.json/itinerary.json/search-plan.json，
  // 不递归进 raw/ 数百个抓取产物文件）；travelogues/ 单独传一个 root 覆盖其直接子项
  // （index.json + 各 <id>.json）。事件处理里再按 .json 后缀过滤掉目录本身的 add/unlink。
  const watcher = chokidar.watch([dir, path.join(dir, "travelogues")], {
    ignoreInitial: true,
    depth: 0,
  });
  watcher.on("all", (event, changedPath) => {
    if (event !== "add" && event !== "change") return;
    if (path.extname(changedPath) !== ".json") return; // 过滤目录本身的 add 事件
    const rel = path.relative(dir, changedPath);
    broadcast({ type: "update", file: rel });
  });
  const ready = new Promise<void>((resolve) => watcher.once("ready", resolve));

  const heartbeatTimer = setInterval(() => {
    for (const res of sseClients) res.write(": heartbeat\n\n");
  }, HEARTBEAT_MS);

  const server = http.createServer((req, res) => {
    if (req.method !== "GET") {
      res.writeHead(405, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "只读 server，仅支持 GET" }));
      return;
    }

    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;

    if (pathname === "/api/state") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(readStateSafe(tripId)));
      return;
    }

    if (pathname === "/api/config") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ tianditu_key: tiandituKey }));
      return;
    }

    if (pathname === "/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(": connected\n\n");
      sseClients.add(res);
      req.on("close", () => {
        sseClients.delete(res);
      });
      return;
    }

    const filePath = routes[pathname];
    if (filePath) {
      try {
        const body = readFileSync(filePath);
        res.writeHead(200, {
          "Content-Type": CONTENT_TYPES[path.extname(filePath)] ?? "application/octet-stream",
        });
        res.end(body);
      } catch {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: `静态文件缺失: ${pathname}` }));
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "未找到" }));
  });

  async function close(): Promise<void> {
    clearInterval(heartbeatTimer);
    for (const res of sseClients) res.end();
    sseClients.clear();
    await watcher.close();
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  return { server, ready, close };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function parseStartArgs(argv: string[]): { tripId: string; port: number } {
  const [cmd, ...rest] = argv;
  if (cmd !== "start") {
    throw new CliError(`未知子命令: ${cmd ?? "(空)"}（仅支持 start）`);
  }
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i];
    if (!key || !key.startsWith("--")) {
      throw new CliError(`参数格式错误: ${key ?? "(缺失)"}`);
    }
    flags[key.slice(2)] = rest[i + 1] ?? "";
  }
  if (!flags.trip) throw new CliError("--trip 是必填参数");
  const port = flags.port ? Number(flags.port) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port <= 0) {
    throw new CliError(`非法端口: ${flags.port}`);
  }
  return { tripId: flags.trip, port };
}

if (require.main === module) {
  (async () => {
    try {
      const { tripId, port } = parseStartArgs(process.argv.slice(2));
      const tiandituKey = readTiandituKey();
      const { server, ready } = createApp(tripId, { tiandituKey });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject); // 端口占用等 listen 失败会走 error 事件而非抛异常
        server.listen(port, "127.0.0.1", resolve);
      });
      await ready;
      process.stdout.write(
        `${JSON.stringify({
          status: "started",
          trip_id: tripId,
          port,
          url: `http://localhost:${port}`,
        })}\n`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`${JSON.stringify({ error: message })}\n`);
      process.exit(1);
    }
  })();
}
