import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  RELEASES_API,
  RELEASE_PUBKEY_B64,
  compareSemver,
  isNewer,
  isPubkeyConfigured,
  normalizeVersion,
  parseSemver,
  pickReleaseAssets,
  verifyRelease,
  type ReleaseAsset,
} from "../lib/release";
import {
  CliError,
  main,
  resolveAppRoot,
  verifyInstalledVersion,
  type UpgradeDeps,
} from "../upgrade";
import { generateSigningKeypair, signPayload } from "../lib/signing";

// ---------------------------------------------------------------------------
// upgrade.ts / lib/release.ts —— 自升级（v5.0 红线 6：先验签再替换 + 失败可回滚）
//
// 隔离约定：全程用 mkdtempSync + PILOT_HOME 指向临时目录；网络一律注入假
// downloadText/downloadFile，绝不真的访问 GitHub，也绝不碰真实 ~/.pilot。
// ---------------------------------------------------------------------------

describe("parseSemver", () => {
  it("解析标准 SemVer", () => {
    expect(parseSemver("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3 });
  });

  it("容忍前导 v", () => {
    expect(parseSemver("v0.1.10")).toEqual({ major: 0, minor: 1, patch: 10 });
  });

  it("支持多位数字", () => {
    expect(parseSemver("12.345.6789")).toEqual({ major: 12, minor: 345, patch: 6789 });
  });

  it("忽略预发布 / 构建后缀", () => {
    expect(parseSemver("v1.2.3-rc.1")).toEqual({ major: 1, minor: 2, patch: 3 });
    expect(parseSemver("1.2.3+build.7")).toEqual({ major: 1, minor: 2, patch: 3 });
  });

  it("无法解析返回 null（不抛异常）", () => {
    for (const bad of ["", "1.2", "1.2.3.4", "v", "abc", "1.x.3", "latest"]) {
      expect(parseSemver(bad), bad).toBeNull();
    }
  });
});

describe("compareSemver", () => {
  it("按 major/minor/patch 顺序比较", () => {
    expect(compareSemver("1.2.3", "1.2.4")).toBe(-1);
    expect(compareSemver("1.3.0", "1.2.9")).toBe(1);
    expect(compareSemver("2.0.0", "1.99.99")).toBe(1);
    expect(compareSemver("v1.2.3", "1.2.3")).toBe(0);
  });

  it("数字按数值而非字典序比较", () => {
    expect(compareSemver("1.0.10", "1.0.9")).toBe(1);
    expect(compareSemver("1.0.2", "1.0.10")).toBe(-1);
  });

  it("无法解析时抛可读错误", () => {
    expect(() => compareSemver("oops", "1.2.3")).toThrow(/无法解析版本号/);
    expect(() => compareSemver("1.2.3", "latest")).toThrow(/无法解析版本号/);
  });
});

describe("isNewer", () => {
  it("远端更高 → true", () => {
    expect(isNewer("1.0.14", "1.0.15")).toBe(true);
    expect(isNewer("1.0.14", "v1.1.0")).toBe(true);
  });

  it("相同或更低 → false", () => {
    expect(isNewer("1.0.14", "1.0.14")).toBe(false);
    expect(isNewer("1.0.14", "1.0.13")).toBe(false);
  });
});

describe("normalizeVersion", () => {
  it("去掉前导 v 与首尾空白", () => {
    expect(normalizeVersion("v1.2.3")).toBe("1.2.3");
    expect(normalizeVersion(" 1.2.3\n")).toBe("1.2.3");
    expect(normalizeVersion("v5.0.0")).toBe("5.0.0");
  });
});

describe("pickReleaseAssets", () => {
  const asset = (name: string): ReleaseAsset => ({ name, browser_download_url: `https://example.invalid/${name}` });
  const full = [asset("pilot-skill-1.2.3.tar.gz"), asset("pilot-skill-1.2.3.tar.gz.sig")];

  it("命中约定的 tarball 与 sig", () => {
    const picked = pickReleaseAssets({ tag_name: "v1.2.3", assets: full }, "v1.2.3");
    expect(picked.tarball?.name).toBe("pilot-skill-1.2.3.tar.gz");
    expect(picked.signature?.name).toBe("pilot-skill-1.2.3.tar.gz.sig");
  });

  it("缺 tarball → tarball 为 null，sig 仍可命中", () => {
    const picked = pickReleaseAssets(
      { tag_name: "v1.2.3", assets: [asset("pilot-skill-1.2.3.tar.gz.sig")] },
      "1.2.3"
    );
    expect(picked.tarball).toBeNull();
    expect(picked.signature).not.toBeNull();
  });

  it("缺 sig → signature 为 null（不抛异常）", () => {
    const picked = pickReleaseAssets(
      { tag_name: "v1.2.3", assets: [asset("pilot-skill-1.2.3.tar.gz")] },
      "1.2.3"
    );
    expect(picked.tarball).not.toBeNull();
    expect(picked.signature).toBeNull();
  });

  it("资产名不匹配（版本不同 / 命名不符）→ 双 null", () => {
    const picked = pickReleaseAssets(
      { tag_name: "v1.2.3", assets: [asset("pilot-skill-1.2.4.tar.gz"), asset("pilot.zip")] },
      "1.2.3"
    );
    expect(picked.tarball).toBeNull();
    expect(picked.signature).toBeNull();
  });
});

describe("verifyRelease", () => {
  const { privateKeyPem, publicKeyRawB64 } = generateSigningKeypair();
  const tarball = Buffer.from("pilot-skill-1.2.3 发布物原始字节\n");

  it("真实验签往返通过（现场生成密钥对）", () => {
    const sig = signPayload(tarball, privateKeyPem);
    expect(verifyRelease(tarball, sig, publicKeyRawB64)).toBe(true);
  });

  it("签名带换行/空白也能通过（.sig 文件常见）", () => {
    const sig = signPayload(tarball, privateKeyPem);
    expect(verifyRelease(tarball, `\n${sig}\n`, publicKeyRawB64)).toBe(true);
  });

  it("数据被篡改 → false", () => {
    const sig = signPayload(tarball, privateKeyPem);
    expect(verifyRelease(Buffer.from("pilot-skill-1.2.3 发布物原始字节！"), sig, publicKeyRawB64)).toBe(false);
  });

  it("换一把公钥 → false", () => {
    const other = generateSigningKeypair();
    const sig = signPayload(tarball, privateKeyPem);
    expect(verifyRelease(tarball, sig, other.publicKeyRawB64)).toBe(false);
  });

  it("非法 base64 / 长度错 → false，不抛异常", () => {
    expect(verifyRelease(tarball, "!!!not-base64!!!", publicKeyRawB64)).toBe(false);
    expect(verifyRelease(tarball, "", publicKeyRawB64)).toBe(false);
    expect(() => verifyRelease(tarball, "x", "shortkey")).not.toThrow();
    expect(verifyRelease(tarball, "x", "shortkey")).toBe(false);
  });
});

describe("isPubkeyConfigured", () => {
  it("占位常量 → false（未接线，自动升级应跳过）", () => {
    expect(isPubkeyConfigured()).toBe(false);
    expect(isPubkeyConfigured(RELEASE_PUBKEY_B64)).toBe(false);
  });

  it("空串 / 空白 → false", () => {
    expect(isPubkeyConfigured("")).toBe(false);
    expect(isPubkeyConfigured("   ")).toBe(false);
  });

  it("合法生成的公钥 → true", () => {
    expect(isPubkeyConfigured(generateSigningKeypair().publicKeyRawB64)).toBe(true);
  });

  it("非法长度公钥 → false", () => {
    expect(isPubkeyConfigured(Buffer.alloc(16).toString("base64"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 编排层
// ---------------------------------------------------------------------------

let testHome: string;
let testPilotHome: string;

beforeEach(() => {
  testHome = mkdtempSync(path.join(tmpdir(), "pilot-upgrade-"));
  testPilotHome = testHome;
  process.env.PILOT_HOME = testPilotHome;
});

afterEach(() => {
  delete process.env.PILOT_HOME;
  if (existsSync(testHome)) rmSync(testHome, { recursive: true, force: true });
});

function writeApp(
  version: string,
  opts: { env?: string; nodeModules?: boolean } = {}
): string {
  const app = path.join(testPilotHome, "app");
  mkdirSync(path.join(app, "skill"), { recursive: true });
  writeFileSync(path.join(app, "VERSION"), `${version}\n`);
  writeFileSync(path.join(app, "skill", "SKILL.md"), `# PILOT ${version}\n`);
  if (opts.env !== undefined) writeFileSync(path.join(app, ".env"), opts.env);
  if (opts.nodeModules) {
    const mods = path.join(app, "tools", "node_modules", "playwright");
    mkdirSync(mods, { recursive: true });
    writeFileSync(path.join(mods, "marker.txt"), "keep-me");
  }
  return app;
}

/** 用真实 tar 造一个含 VERSION + skill/SKILL.md 的发布包 */
function makeTarball(version: string, { withVersion = true } = {}): Buffer {
  const stage = path.join(testHome, `stage-${version}${withVersion ? "" : "-noversion"}`);
  mkdirSync(path.join(stage, "skill"), { recursive: true });
  if (withVersion) writeFileSync(path.join(stage, "VERSION"), `${version}\n`);
  writeFileSync(path.join(stage, "skill", "SKILL.md"), `# PILOT ${version}\n`);
  // 刻意回避盘符：包体走 stdout（`-f -`）+ cwd 设为 stage 且 -C 用相对 `.`。
  // Windows 上 Git for Windows 的 GNU tar 会把 `-f C:\...` 的 `C:` 当成远程主机名
  // （CI 实测 "Cannot connect to C: resolve failed"），而 bsdtar 不支持
  // `--force-local`，所以只能从调用形态上规避——与生产代码 extractTarball 同源。
  const entries = withVersion ? ["VERSION", "skill"] : ["skill"];
  const result = spawnSync("tar", ["-czf", "-", "-C", ".", ...entries], {
    cwd: stage,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`tar 造包失败: ${result.stderr?.toString() ?? ""}`);
  }
  if (!result.stdout || result.stdout.length === 0) throw new Error("tar 造包结果为空");
  return result.stdout;
}

function releaseJson(version: string): string {
  return JSON.stringify({
    tag_name: `v${version}`,
    assets: [
      { name: `pilot-skill-${version}.tar.gz`, browser_download_url: "https://example.invalid/pilot.tar.gz" },
      { name: `pilot-skill-${version}.tar.gz.sig`, browser_download_url: "https://example.invalid/pilot.tar.gz.sig" },
    ],
  });
}

interface Harness {
  deps: UpgradeDeps;
  logLines: string[];
  downloads: string[];
}

/** 组装注入依赖；tarball/sig 已就绪时假 downloadFile 会把它们写到目标路径 */
function harness(opts: {
  remoteVersion?: string | null;
  tarball?: Buffer;
  sig?: string;
  pubkey?: string;
  downloadTextError?: Error;
  downloadFileError?: Error;
  releaseBody?: string;
  verifyInstalled?: (appDir: string, expected: string) => boolean;
}): Harness {
  const logLines: string[] = [];
  const downloads: string[] = [];
  const deps: UpgradeDeps = {
    pilotHome: testPilotHome,
    log: (line) => logLines.push(line),
    downloadText: async (url) => {
      if (opts.downloadTextError) throw opts.downloadTextError;
      expect(url).toBe(RELEASES_API);
      return opts.releaseBody ?? releaseJson(opts.remoteVersion!);
    },
    downloadFile: async (url, dest) => {
      downloads.push(url);
      if (opts.downloadFileError) throw opts.downloadFileError;
      writeFileSync(dest, url.endsWith(".sig") ? opts.sig! : opts.tarball!);
    },
    verifyInstalled: opts.verifyInstalled,
  };
  if (opts.pubkey !== undefined) deps.pubkey = opts.pubkey;
  return { deps, logLines, downloads };
}

/** 用现场生成的密钥对签名 tarball，返回 {pubkey, sig, deps} */
function signedHarness(version: string, tarball: Buffer, extra: Partial<Parameters<typeof harness>[0]> = {}): Harness {
  const { privateKeyPem, publicKeyRawB64 } = generateSigningKeypair();
  return harness({ remoteVersion: version, tarball, sig: signPayload(tarball, privateKeyPem), pubkey: publicKeyRawB64, ...extra });
}

describe("upgrade run —— 无网络降级与版本判定", () => {
  it("已是最新：不下载、不替换，reason=already-latest", async () => {
    writeApp("1.0.14");
    const { deps, downloads } = harness({ remoteVersion: "1.0.14" });
    const result = await main(["run"], deps);
    expect(result).toMatchObject({ local: "1.0.14", remote: "1.0.14", newer: false, upgraded: false, reason: "already-latest" });
    expect(downloads).toHaveLength(0);
  });

  it("网络失败 / API 限流：不抛异常，降级提示，旧版保留", async () => {
    const app = writeApp("1.0.14", { env: "TIANDITU_KEY=abc" });
    const { deps } = harness({ downloadTextError: new Error("HTTP 403 rate limit") });
    const result = await main(["run"], deps);
    expect(result).toMatchObject({ upgraded: false, remote: null, reason: "network-error" });
    expect(readFileSync(path.join(app, "VERSION"), "utf-8").trim()).toBe("1.0.14");
    expect(readFileSync(path.join(app, ".env"), "utf-8")).toBe("TIANDITU_KEY=abc");
  });

  it("公钥未接线：不下载，reason=pubkey-not-configured", async () => {
    writeApp("1.0.14");
    const tarball = makeTarball("1.0.15");
    // 不传 pubkey → 使用内嵌占位常量
    const { deps, downloads, logLines } = harness({ remoteVersion: "1.0.15", tarball });
    const result = await main(["run"], deps);
    expect(result).toMatchObject({ newer: true, upgraded: false, reason: "pubkey-not-configured" });
    expect(downloads).toHaveLength(0);
    expect(logLines.join("\n")).toMatch(/发布公钥未接线/);
  });

  it("remote 更新但 --check-only：只报版本，不下载", async () => {
    writeApp("1.0.14");
    const { deps, downloads } = harness({ remoteVersion: "1.0.15" });
    const result = await main(["run", "--check-only"], deps);
    expect(result).toMatchObject({ remote: "1.0.15", newer: true, upgraded: false, reason: "check-only" });
    expect(downloads).toHaveLength(0);
  });

  it("check 子命令：不下载、不替换", async () => {
    writeApp("1.0.14");
    const { deps, downloads } = harness({ remoteVersion: "1.0.15" });
    const result = await main(["check"], deps);
    expect(result).toMatchObject({ action: "check", remote: "1.0.15", upgraded: false });
    expect(downloads).toHaveLength(0);
  });

  it("未知子命令 → CliError", async () => {
    await expect(main(["nope"], harness({ remoteVersion: "1.0.15" }).deps)).rejects.toThrow(CliError);
  });

  it("本地 VERSION 缺失 → 可读错误", async () => {
    await expect(main(["run"], harness({ remoteVersion: "1.0.15" }).deps)).rejects.toThrow(/未找到本地版本文件/);
  });
});

describe("upgrade run —— 验签与失败保留", () => {
  it("验签失败：拒用、解压不发生、旧目录原样保留", async () => {
    const app = writeApp("1.0.14", { env: "TIANDITU_KEY=keep", nodeModules: true });
    const tarball = makeTarball("1.0.15");
    // 用另一把私钥签名 → 与公钥不匹配
    const other = generateSigningKeypair();
    const { deps, logLines } = harness({
      remoteVersion: "1.0.15",
      tarball,
      sig: signPayload(tarball, other.privateKeyPem),
      pubkey: generateSigningKeypair().publicKeyRawB64,
    });
    await expect(main(["run"], deps)).rejects.toThrow(/验签失败/);
    // 旧版原样保留（不是空目录）
    expect(readFileSync(path.join(app, "VERSION"), "utf-8").trim()).toBe("1.0.14");
    expect(readFileSync(path.join(app, ".env"), "utf-8")).toBe("TIANDITU_KEY=keep");
    expect(existsSync(path.join(app, "tools", "node_modules", "playwright", "marker.txt"))).toBe(true);
    expect(existsSync(path.join(app, "skill", "SKILL.md"))).toBe(true);
    expect(logLines.join("\n")).toMatch(/验签失败/);
  });

  it("下载失败：降级为不替换，旧版保留", async () => {
    const app = writeApp("1.0.14", { env: "K=V" });
    const pubkey = generateSigningKeypair().publicKeyRawB64;
    const { deps } = harness({ remoteVersion: "1.0.15", downloadFileError: new Error("HTTP 500"), pubkey });
    const result = await main(["run"], deps);
    expect(result).toMatchObject({ upgraded: false, reason: "download-failed" });
    expect(readFileSync(path.join(app, "VERSION"), "utf-8").trim()).toBe("1.0.14");
    expect(readFileSync(path.join(app, ".env"), "utf-8")).toBe("K=V");
  });

  it("发布资产缺失 → 中止升级，旧版保留", async () => {
    writeApp("1.0.14");
    // 资产名与远端版本不匹配
    const { deps } = harness({
      remoteVersion: "1.0.15",
      pubkey: generateSigningKeypair().publicKeyRawB64,
      releaseBody: JSON.stringify({
        tag_name: "v1.0.15",
        assets: [{ name: "pilot-skill-1.0.16.tar.gz", browser_download_url: "https://example.invalid/x" }],
      }),
    });
    await expect(main(["run"], deps)).rejects.toThrow(/发布资产缺失/);
  });
});

describe("upgrade run —— 成功替换与用户状态迁移", () => {
  it("成功升级：新目录就位，.env 与 tools/node_modules 内容不变，.prev 保留旧版", async () => {
    const app = writeApp("1.0.14", { env: "TIANDITU_KEY=secret-key\n", nodeModules: true });
    const tarball = makeTarball("1.0.15");
    const { deps, logLines } = signedHarness("1.0.15", tarball);

    const result = await main(["run"], deps);

    expect(result).toMatchObject({ local: "1.0.14", remote: "1.0.15", upgraded: true, reason: "upgraded" });
    // 新版本就位
    expect(readFileSync(path.join(app, "VERSION"), "utf-8").trim()).toBe("1.0.15");
    expect(readFileSync(path.join(app, "skill", "SKILL.md"), "utf-8")).toContain("1.0.15");
    // 用户状态迁移到新目录且内容不变
    expect(readFileSync(path.join(app, ".env"), "utf-8")).toBe("TIANDITU_KEY=secret-key\n");
    expect(readFileSync(path.join(app, "tools", "node_modules", "playwright", "marker.txt"), "utf-8")).toBe("keep-me");
    // .prev 保留旧版
    const prev = path.join(testPilotHome, "app.prev-1.0.14");
    expect(existsSync(prev)).toBe(true);
    expect(readFileSync(path.join(prev, "VERSION"), "utf-8").trim()).toBe("1.0.14");
    // 临时目录清理干净
    expect(existsSync(path.join(testPilotHome, ".upgrade-tmp"))).toBe(false);
    expect(logLines.join("\n")).toMatch(/升级完成/);
  });

  it("只保留最近 1 个 .prev，更早的清理", async () => {
    writeApp("1.0.14");
    const stale = path.join(testPilotHome, "app.prev-1.0.10");
    mkdirSync(stale, { recursive: true });
    writeFileSync(path.join(stale, "VERSION"), "1.0.10\n");
    const tarball = makeTarball("1.0.15");
    const { deps } = signedHarness("1.0.15", tarball);

    await main(["run"], deps);

    const prevs = readdirSync(testPilotHome).filter((n) => n.startsWith("app.prev-"));
    expect(prevs).toEqual(["app.prev-1.0.14"]);
  });
});

describe("upgrade run —— 回滚", () => {
  it("替换后校验失败：旧版与用户状态全部恢复原位", async () => {
    const app = writeApp("1.0.14", { env: "TIANDITU_KEY=restore-me\n", nodeModules: true });
    const tarball = makeTarball("1.0.15");
    const { deps, logLines } = signedHarness("1.0.15", tarball, { verifyInstalled: () => false });

    await expect(main(["run"], deps)).rejects.toThrow(/已回滚到 1\.0\.14/);

    // 旧版原样恢复，不是空目录
    expect(readFileSync(path.join(app, "VERSION"), "utf-8").trim()).toBe("1.0.14");
    expect(readFileSync(path.join(app, "skill", "SKILL.md"), "utf-8")).toContain("1.0.14");
    expect(readFileSync(path.join(app, ".env"), "utf-8")).toBe("TIANDITU_KEY=restore-me\n");
    expect(readFileSync(path.join(app, "tools", "node_modules", "playwright", "marker.txt"), "utf-8")).toBe("keep-me");
    expect(readdirSync(app).length).toBeGreaterThan(0);
    // 没有残留 app.prev（已改回 app）与失败目录
    expect(readdirSync(testPilotHome).filter((n) => n.startsWith("app.prev-"))).toEqual([]);
    expect(readdirSync(testPilotHome).filter((n) => n.startsWith(".upgrade-failed-"))).toEqual([]);
    expect(logLines.join("\n")).toMatch(/回滚/);
  });
});

describe("解压结果校验", () => {
  it("resolveAppRoot：根即 app 根", () => {
    const dir = path.join(testHome, "flat");
    mkdirSync(path.join(dir, "skill"), { recursive: true });
    writeFileSync(path.join(dir, "VERSION"), "1.0.0\n");
    writeFileSync(path.join(dir, "skill", "SKILL.md"), "# x\n");
    expect(resolveAppRoot(dir)).toBe(dir);
  });

  it("resolveAppRoot：兼容外层套一层发行目录", () => {
    const dir = path.join(testHome, "wrapped");
    const inner = path.join(dir, "pilot-skill-1.0.0");
    mkdirSync(path.join(inner, "skill"), { recursive: true });
    writeFileSync(path.join(inner, "VERSION"), "1.0.0\n");
    writeFileSync(path.join(inner, "skill", "SKILL.md"), "# x\n");
    expect(resolveAppRoot(dir)).toBe(inner);
  });

  it("resolveAppRoot：空包/错包返回 null", () => {
    const empty = path.join(testHome, "empty");
    mkdirSync(empty, { recursive: true });
    expect(resolveAppRoot(empty)).toBeNull();
    // 有 VERSION 但缺 skill/SKILL.md（错包）
    const partial = path.join(testHome, "partial");
    mkdirSync(partial, { recursive: true });
    writeFileSync(path.join(partial, "VERSION"), "1.0.0\n");
    expect(resolveAppRoot(partial)).toBeNull();
  });

  it("verifyInstalledVersion：版本一致 true，不一致 false", () => {
    const app = writeApp("1.0.15");
    expect(verifyInstalledVersion(app, "v1.0.15")).toBe(true);
    expect(verifyInstalledVersion(app, "1.0.16")).toBe(false);
    expect(verifyInstalledVersion(path.join(testHome, "nope"), "1.0.15")).toBe(false);
  });

  it("解压结果缺 VERSION → 中止且不解压替换", async () => {
    const app = writeApp("1.0.14");
    // 造一个只有 skill/、**没有 VERSION** 的错包。
    // 走 makeTarball 同一条「无盘符」tar 代码路径：此前这里直接调 tar 传绝对
    // 路径，在 Windows（Git for Windows 的 GNU tar 把 `-f C:\…` 的 `C:` 当远程
    // 主机名）上 tar 静默失败，随后 readFileSync 报 ENOENT，掩盖了真正原因。
    const tarball = makeTarball("1.0.15", { withVersion: false });
    const { deps } = signedHarness("1.0.15", tarball);

    await expect(main(["run"], deps)).rejects.toThrow(/空包|错包/);
    expect(readFileSync(path.join(app, "VERSION"), "utf-8").trim()).toBe("1.0.14");
  });
});
