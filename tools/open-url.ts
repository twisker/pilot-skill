import { spawn } from "node:child_process";

// ---------------------------------------------------------------------------
// PILOT open-url.ts —— 跨平台「用默认浏览器打开一个 URL」小工具（Task 21）
//
// SKILL.md 里之前直接写死 macOS 专属的 `open <url>`；Windows 该用 `start`
// （cmd 内置命令，需 `cmd /c start ""`），Linux 该用 `xdg-open`。与其在
// SKILL.md 里堆判断分支，不如提供这一个小工具，SKILL 里统一写
// `npx tsx tools/open-url.ts <url>`，失败也不影响主链路（server 未启动/
// 无图形环境等场景，打印提示即可，不抛非零退出码阻断对话）。
// ---------------------------------------------------------------------------

export function commandFor(url: string, platform: NodeJS.Platform = process.platform): { cmd: string; args: string[] } {
  if (platform === "darwin") return { cmd: "open", args: [url] };
  if (platform === "win32") {
    // cmd /c start 的第一个引号参数会被当作窗口标题，需要占位空字符串
    return { cmd: "cmd", args: ["/c", "start", "", url] };
  }
  return { cmd: "xdg-open", args: [url] };
}

export function openUrl(url: string, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  const { cmd, args } = commandFor(url, platform);
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, { stdio: "ignore", detached: true });
      child.on("error", () => resolve(false));
      child.unref();
      // spawn 本身成功发起即视为成功（无法进一步确认浏览器真的打开了）
      resolve(true);
    } catch {
      resolve(false);
    }
  });
}

if (require.main === module) {
  const url = process.argv[2];
  if (!url) {
    process.stderr.write("用法: npx tsx tools/open-url.ts <url>\n");
    process.exit(1);
  }
  openUrl(url).then((ok) => {
    if (!ok) {
      process.stderr.write(
        `无法自动打开浏览器，请手动访问：${url}（macOS: open ${url} / Windows: start ${url} / Linux: xdg-open ${url}）\n`,
      );
    }
    // 打开失败不算致命错误：不阻塞 SKILL 主链路，退出码恒为 0
    process.exit(0);
  });
}
