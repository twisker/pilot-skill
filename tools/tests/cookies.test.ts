import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  SITES,
  findSite,
  hasMarkerCookie,
  earliestExpiryIso,
  computeSiteStatus,
  runStatus,
  formatStatusTable,
  CliError,
  type StorageStateLite,
} from "../cookies";

let testPilotHome: string;

beforeEach(() => {
  testPilotHome = mkdtempSync(path.join(tmpdir(), "pilot-cookies-test-"));
  process.env.PILOT_HOME = testPilotHome;
});

afterEach(() => {
  delete process.env.PILOT_HOME;
  if (existsSync(testPilotHome)) {
    rmSync(testPilotHome, { recursive: true });
  }
});

function writeCookieFixture(cookieFile: string, storageState: StorageStateLite): void {
  const dir = path.join(testPilotHome, "cookies");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, cookieFile), JSON.stringify(storageState), "utf-8");
}

describe("SITES 常量表", () => {
  it("按 mafengwo/zhihu/qyer/xhs/bilibili 顺序声明 5 个站点", () => {
    expect(SITES.map((s) => s.key)).toEqual(["mafengwo", "zhihu", "qyer", "xhs", "bilibili"]);
  });

  it("已知标志 cookie：zhihu=z_c0 / xhs=web_session / bilibili=SESSDATA", () => {
    expect(findSite("zhihu").markerCookie).toBe("z_c0");
    expect(findSite("xhs").markerCookie).toBe("web_session");
    expect(findSite("bilibili").markerCookie).toBe("SESSDATA");
  });

  it("无稳定已知标志的站点（mafengwo/qyer）markerCookie 为 null", () => {
    expect(findSite("mafengwo").markerCookie).toBeNull();
    expect(findSite("qyer").markerCookie).toBeNull();
  });
});

describe("findSite", () => {
  it("未知站点名抛 CliError", () => {
    expect(() => findSite("not-a-site")).toThrow(CliError);
  });
});

describe("hasMarkerCookie", () => {
  it("命中标志 cookie 名返回 true", () => {
    expect(hasMarkerCookie([{ name: "z_c0", expires: -1 }], "z_c0")).toBe(true);
  });

  it("未命中返回 false（含空数组）", () => {
    expect(hasMarkerCookie([{ name: "other", expires: -1 }], "z_c0")).toBe(false);
    expect(hasMarkerCookie([], "z_c0")).toBe(false);
  });
});

describe("earliestExpiryIso", () => {
  it("空数组返回 null", () => {
    expect(earliestExpiryIso([])).toBeNull();
  });

  it("全部为 session cookie（expires=-1）返回 null", () => {
    expect(earliestExpiryIso([{ name: "a", expires: -1 }, { name: "b", expires: -1 }])).toBeNull();
  });

  it("取多个非 -1 值中的最小值并转换为 ISO 日期", () => {
    const later = 1893456000; // 2030-01-01T00:00:00Z
    const earlier = 1800000000; // 2027-01-15T ...
    const iso = earliestExpiryIso([
      { name: "a", expires: -1 },
      { name: "b", expires: later },
      { name: "c", expires: earlier },
    ]);
    expect(iso).toBe(new Date(earlier * 1000).toISOString());
  });
});

describe("computeSiteStatus 三态", () => {
  const zhihuSite = findSite("zhihu"); // markerCookie = z_c0

  it("① 无文件：exists=false, markerPresent=false, earliestExpiry=null", () => {
    const status = computeSiteStatus(zhihuSite, null);
    expect(status).toEqual({
      key: "zhihu",
      label: "知乎",
      exists: false,
      markerPresent: false,
      earliestExpiry: null,
    });
  });

  it("② 有文件含标志 cookie：exists=true, markerPresent=true", () => {
    const status = computeSiteStatus(zhihuSite, {
      cookies: [{ name: "z_c0", expires: 1893456000 }],
    });
    expect(status.exists).toBe(true);
    expect(status.markerPresent).toBe(true);
    expect(status.earliestExpiry).toBe(new Date(1893456000 * 1000).toISOString());
  });

  it("③ 有文件缺标志 cookie：exists=true, markerPresent=false", () => {
    const status = computeSiteStatus(zhihuSite, {
      cookies: [{ name: "some_other_cookie", expires: -1 }],
    });
    expect(status.exists).toBe(true);
    expect(status.markerPresent).toBe(false);
    expect(status.earliestExpiry).toBeNull();
  });

  it("无已知标志 cookie 的站点（mafengwo）：markerPresent 恒为 null，不论文件是否存在", () => {
    const mafengwoSite = findSite("mafengwo");
    expect(computeSiteStatus(mafengwoSite, null).markerPresent).toBeNull();
    expect(
      computeSiteStatus(mafengwoSite, { cookies: [{ name: "anything", expires: -1 }] }).markerPresent,
    ).toBeNull();
  });
});

describe("runStatus（集成，读取 fixture 文件，不触碰浏览器/网络）", () => {
  it("混合三态：无文件 / 含标志 / 缺标志，各站点独立判定", () => {
    // zhihu：有文件，含标志 z_c0
    writeCookieFixture("zhihu.json", { cookies: [{ name: "z_c0", expires: 1893456000 }] });
    // xhs：有文件，缺标志 web_session
    writeCookieFixture("xhs.json", { cookies: [{ name: "unrelated", expires: -1 }] });
    // bilibili：无文件（不写）
    // mafengwo/qyer：无文件（不写）

    const rows = runStatus();
    expect(rows.map((r) => r.key)).toEqual(["mafengwo", "zhihu", "qyer", "xhs", "bilibili"]);

    const zhihu = rows.find((r) => r.key === "zhihu")!;
    expect(zhihu.exists).toBe(true);
    expect(zhihu.markerPresent).toBe(true);

    const xhs = rows.find((r) => r.key === "xhs")!;
    expect(xhs.exists).toBe(true);
    expect(xhs.markerPresent).toBe(false);

    const bilibili = rows.find((r) => r.key === "bilibili")!;
    expect(bilibili.exists).toBe(false);
    expect(bilibili.markerPresent).toBe(false);

    const mafengwo = rows.find((r) => r.key === "mafengwo")!;
    expect(mafengwo.exists).toBe(false);
    expect(mafengwo.markerPresent).toBeNull();
  });
});

describe("formatStatusTable", () => {
  it("渲染表头与每行数据，列宽按最长内容对齐", () => {
    const table = formatStatusTable([
      { key: "zhihu", label: "知乎", exists: true, markerPresent: true, earliestExpiry: "2030-01-01T00:00:00.000Z" },
      { key: "mafengwo", label: "马蜂窝", exists: false, markerPresent: null, earliestExpiry: null },
    ]);
    const lines = table.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("站点");
    expect(lines[1]).toContain("知乎");
    expect(lines[1]).toContain("在");
    expect(lines[2]).toContain("马蜂窝");
    expect(lines[2]).toContain("缺失");
    expect(lines[2]).toContain("未知(启发式站点)");
  });
});
