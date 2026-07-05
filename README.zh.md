[English](README.md) | **中文**

[![CI](https://github.com/twisker/pilot-skill/actions/workflows/ci.yml/badge.svg)](https://github.com/twisker/pilot-skill/actions/workflows/ci.yml)

# PILOT —— 对话式旅行路书设计（Claude Code Skill）

> **PILOT** is a Claude Code Skill that designs travel itineraries through conversation: it searches real travelogues across the Chinese web in real time, structures and curates the best ones, drafts a day-by-day itinerary you can edit by talking, checks it against deterministic conflict rules, and exports a print-ready itinerary book in Excel / PDF / Word — with a live read-only map view in your browser. Chinese-first (V1), runs entirely on your own machine.

在 Claude Code 里输入一句话，PILOT 帮你把一次旅行从「想法」聊成「可以直接带上路的路书」。

```
/pilot 十一云南自驾 6 天，两大人带娃
```

## 它是什么

PILOT 不是「让 AI 凭空编一份行程」。它的主链路是：

**对话收集需求 → 实时搜索全网真实游记 → 逐条结构化整理 → 精选蓝本 → 生成行程 → 对话编辑 → 逐日细化（含坐标查证）→ 确定性冲突检查 → 三格式导出。**

行程的每一天都能追溯到某条真实游记的某一天（`source_ref` 记账），坐标必须联网查证不许凭记忆填，覆盖率如实汇报绝不假装数据充足。

## 亮点

- **实时搜索真实游记**：马蜂窝 / 穷游 / 携程攻略 / 知乎 / 小红书 / B站 / 图虫 / 500px 多源检索，playwright 兜底抓取，B站视频游记可抽帧理解
- **结构化精选**：每条游记结构化为统一 schema，机器打分（完整度/粒度/媒体丰富度/新鲜度）+ 品味分双重排序，去重后留前 5 条做蓝本候选
- **对话式编辑**：「第 3 天换成 2 号线路的安排」「加一天禾木」——跨游记拼接、逐日细化都在对话里完成，每轮改动自动过 schema 校验与冲突规则（长途驾车 / 单日过密 / 预算超限 / 坐标距离异常等）
- **地图伴侣**：本地只读网页（时间线 / 地图 / 参考游记卡片墙），行程文件一变浏览器自动刷新（SSE），天地图底图
- **三格式路书**：Excel（4 sheet，含费用公式与消费流水模板）/ PDF / Word，结构对齐资深旅行者的实战路书习惯
- **全程本地**：数据全部落盘 `~/.pilot/workspace/`，cookie 只存本机，零云端依赖

## 系统要求

| 依赖 | 要求 |
|------|------|
| [Claude Code](https://claude.com/claude-code) | 必需（PILOT 是 Claude Code Skill） |
| Node.js | >= 20 |
| git | 任意近期版本 |
| yt-dlp + ffmpeg | 可选，仅视频游记理解需要——**无需自己装**，安装时选「是」或事后 `npx tsx tools/setup-video.ts install --yes` 一键搞定（跨平台静态二进制，见下方「视频依赖一键安装」） |
| 操作系统 | **macOS / Windows / Linux 均支持**（Windows 原生支持，不需要 WSL） |

## 三步安装

**macOS / Linux：**

```bash
# 1. clone 到固定安装位（推荐；clone 到别处也行，install.sh 会自动复制过去）
git clone https://github.com/twisker/pilot-skill.git ~/.pilot/app

# 2. 运行安装脚本（检查依赖 → npm install → 下载 playwright chromium → 注册 skill）
cd ~/.pilot/app && ./install.sh

# 3. 新开一个 Claude Code 会话，开聊
#    /pilot 十一去川西自驾一周，摄影为主
```

**Windows（原生 PowerShell / cmd，不需要 WSL / Git Bash）：**

```powershell
# 1. clone 到固定安装位
git clone https://github.com/twisker/pilot-skill.git $env:USERPROFILE\.pilot\app

# 2. 运行安装脚本（同一份 install.mjs，跨平台逻辑一致；Windows 用 node 直接跑）
cd $env:USERPROFILE\.pilot\app
node install.mjs

# 3. 新开一个 Claude Code 会话，开聊
#    /pilot 十一去川西自驾一周，摄影为主
```

安装脚本会询问是否顺带安装视频依赖（yt-dlp/ffmpeg），选「是」或者用 `--with-video --yes` 免交互一键装好；跳过也不影响文字游记主链路，随时可以事后补装（见下）。

安装后可选配置（详见 [docs/](docs/index.md)）：

- **天地图 key**（地图视图底图）：在 `~/.pilot/app/.env` 写入 `TIANDITU_KEY=<key>`，[免费申请](https://console.tianditu.gov.cn/)（浏览器端类型）
- **站点 cookie**（大幅提升抓取成功率）：`npx tsx ~/.pilot/app/tools/cookies.ts setup`
- **视频依赖一键安装**（B 站视频游记理解用，跳过也不影响主链路）：

  ```bash
  cd ~/.pilot/app/tools && npx tsx setup-video.ts install --yes
  ```

  自动下载 yt-dlp + ffmpeg/ffprobe 官方静态二进制到 `~/.pilot/bin/`（macOS/Windows/Linux 都是官方发行的单文件构建，不需要 brew / winget / apt，也不需要预装 python）。已经装过且能跑就直接跳过；要强制重下加 `--force`。macOS 上如果二进制被 Gatekeeper 拦下（提示"无法验证开发者"），按报错里给的 `xattr -d com.apple.quarantine <路径>` 处理一次即可。

## 快速上手：一段示例对话

```
你：/pilot 十一云南自驾 6 天，两大人带娃

PILOT：好的！确认几件事：具体几号出发几号回？从哪个城市出发？预算大概多少？

你：10 月 1 到 6，昆明出发，预算 1 万5

PILOT：（创建 trip → 生成搜索计划 → 逐源搜索游记 → 抓取 → 结构化 → 精选）
      本轮搜索覆盖率：
      - 携程攻略：搜到 10 条 → 选 6 → 抓取成功 5
      - 知乎：搜到 15 条 → 选 8 → 成功 6
      - 马蜂窝：搜到 18 条 → 选 12 → 成功 2（其余被滑块验证码拦截）
      ...
      精选出 5 条参考游记，推荐以「大理丽江环线 6 日」（评分 7.1，共 6 天）为蓝本 ...

你：可以。第 3 天太赶了，大理多待一天

PILOT：（编辑 → 校验 → 冲突检查）已改：Day 3-4 大理两晚 ...
      冲突检查：Day 5 丽江→泸沽湖段当日驾车约 300km（warn），要不要拆两天？

你：就这样，导出吧

PILOT：（逐日细化 → 坐标查证 → 最终冲突检查 → 导出）
      路书已导出：~/.pilot/workspace/yunnan-selfdrive-20261001/exports/
      ├── 路书.pdf  ├── 路书.xlsx  └── 路书.docx
```

完整教程见 [docs/zh/tutorial-quickstart.md](docs/zh/tutorial-quickstart.md)。

## 文档

`docs/` 目录即文档站（GitHub Pages），中英双语。仓库维护者启用方式：GitHub 仓库 **Settings → Pages → Source 选 `main` 分支 `/docs` 目录**，保存即上线。

| 文档 | 内容 |
|------|------|
| [docs/index.md](docs/index.md) | 文档导览（中英双语入口） |
| [docs/zh/tutorial-quickstart.md](docs/zh/tutorial-quickstart.md) | 完整走一遍：安装 → 第一个行程 → 编辑 → 导出 |
| [docs/zh/guide-cookies.md](docs/zh/guide-cookies.md) | cookie 导出全流程与各站说明 |
| [docs/zh/guide-config.md](docs/zh/guide-config.md) | `config/pilot.json` 全字段参考 |
| [docs/zh/guide-export.md](docs/zh/guide-export.md) | 路书四段结构与模板 sheet 用法 |
| [docs/zh/faq.md](docs/zh/faq.md) | 常见问题 |

英文版文档在 [docs/en/](docs/en/)（内容与中文版一一对应，非摘要翻译）。

## 常见问题（速览）

**为什么需要 cookie？**
马蜂窝/小红书等站点对未登录访问有反爬限制（验证码、登录墙）。PILOT 提供引导式工具在你本机浏览器登录后导出 cookie，**只保存在本机 `~/.pilot/cookies/`，绝不上传任何服务器**。不导出 cookie 也能用，只是这些源的抓取成功率低，PILOT 会如实汇报并降级。详见 [docs/zh/guide-cookies.md](docs/zh/guide-cookies.md)。

**天地图 key 怎么申请？**
[天地图控制台](https://console.tianditu.gov.cn/) 免费注册，创建「浏览器端」应用即得 key。没有 key 时地图视图显示引导文案，不影响行程设计主链路。

**抓取失败了怎么办？**
部分源被验证码拦截是常态。PILOT 的降级链：WebSearch → WebFetch 直读 → playwright 兜底 → 摘要增补 → 如实汇报覆盖率并给你选项（继续 / 导 cookie 重试 / 换词重搜），绝不假装数据充足。详见 [docs/zh/faq.md](docs/zh/faq.md)。

## License

Copyright (c) 2026 twisker. **All rights reserved.**

允许个人非商业使用；未经书面授权，禁止商用与再分发。详见 [LICENSE](LICENSE)。
