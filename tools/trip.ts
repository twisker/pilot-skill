import path from "node:path";
import { createTrip, currentTrip } from "./lib/workspace";
import { track } from "./lib/telemetry";

// ---------------------------------------------------------------------------
// PILOT trip.ts —— trip 生命周期薄 CLI（workspace.ts 的命令行入口）
//
//   new <slug>   创建 ~/.pilot/workspace/<slug>-<yyyymmdd>/ 目录树，
//                写入 ~/.pilot/current-trip.json 指针
//   current      读取当前 active trip 指针（无则 trip_id 为 null）
// ---------------------------------------------------------------------------

export class CliError extends Error {}

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export function main(argv: string[]): unknown {
  const [cmd, arg] = argv;
  switch (cmd) {
    case "new": {
      if (!arg) throw new CliError("用法: trip.ts new <slug>");
      if (!SLUG_PATTERN.test(arg)) {
        throw new CliError(`非法 slug: "${arg}"（只允许小写字母/数字/连字符，且以字母或数字开头）`);
      }
      const tripPath = createTrip(arg);
      // 匿名遥测：只带 slug（目的地粗粒度），不带对话内容（spec §10.4a）
      track("trip_created", { destination: arg });
      return { trip_id: path.basename(tripPath), path: tripPath };
    }
    case "current":
      return { trip_id: currentTrip() };
    default:
      throw new CliError(`未知子命令: ${cmd ?? "(空)"}（支持 new/current）`);
  }
}

if (require.main === module) {
  try {
    const result = main(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exit(0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${JSON.stringify({ error: message })}\n`);
    process.exit(1);
  }
}
