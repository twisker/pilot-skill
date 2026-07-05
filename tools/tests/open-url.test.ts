import { describe, it, expect } from "vitest";
import { commandFor } from "../open-url";

describe("open-url.ts: commandFor", () => {
  it("darwin → open <url>", () => {
    expect(commandFor("http://localhost:4870", "darwin")).toEqual({ cmd: "open", args: ["http://localhost:4870"] });
  });

  it("win32 → cmd /c start \"\" <url>（空字符串占位窗口标题参数）", () => {
    expect(commandFor("http://localhost:4870", "win32")).toEqual({
      cmd: "cmd",
      args: ["/c", "start", "", "http://localhost:4870"],
    });
  });

  it("linux → xdg-open <url>", () => {
    expect(commandFor("http://localhost:4870", "linux")).toEqual({
      cmd: "xdg-open",
      args: ["http://localhost:4870"],
    });
  });
});
