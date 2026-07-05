# cookie 导出指南

**中文** | [English](https://twisker.github.io/pilot-skill/en/guide-cookies.html)

## 为什么需要 cookie

马蜂窝、小红书等站点对未登录的程序化访问有强反爬措施（滑块验证码、登录墙）。没有登录态时这些源的抓取成功率很低——PILOT 不会因此崩溃，但参考素材会变少，路书质量打折扣。

导出你自己的登录 cookie 后，PILOT 的 playwright 抓取会带上登录态，成功率显著提升。

## 红线声明（请先读）

- cookie **只保存在你本机** `~/.pilot/cookies/` 目录（playwright storageState JSON 格式）
- PILOT **不会把 cookie 上传到任何服务器**——整个工具链零云端依赖，抓取都发生在你的机器上
- cookie 等同你的登录凭证，**不要**把 `~/.pilot/cookies/` 下的文件发给别人或提交到 git
- 随时可以删除：`rm ~/.pilot/cookies/<站点>.json` 即刻失效

## 全流程：cookies.ts setup

```bash
# 一次引导所有站点（推荐首次使用）
npx tsx ~/.pilot/app/tools/cookies.ts setup

# 只处理某一个站点
npx tsx ~/.pilot/app/tools/cookies.ts setup --site xhs
```

流程（每个站点重复）：

1. 工具打开一个**有界面的 Chromium 窗口**，自动导航到该站登录页
2. 你在窗口里正常登录（扫码 / 短信 / 密码都行）
3. 工具每 2 秒轮询一次登录标志：
   - **知乎 / 小红书 / B站**：检测到标志 cookie（`z_c0` / `web_session` / `SESSDATA`）即自动判定成功
   - **马蜂窝 / 穷游**：无稳定标志 cookie，采用「cookie 数量显著增加 + 你按回车确认」兜底
4. 判定成功后自动保存 storageState 到 `~/.pilot/cookies/<站点>.json`，进入下一站
5. 单站超时 5 分钟：跳过该站继续（之后可用 `--site` 单独补）

全部结束后 stdout 输出逐站结果 JSON（便于留痕），进度信息在 stderr。

## 各站点说明

| 站点 | `--site` 值 | cookie 文件 | 登录标志 | 说明 |
|------|------------|-------------|---------|------|
| 马蜂窝 | `mafengwo` | `mafengwo.json` | 无（回车确认兜底） | 即使有 cookie，仍可能遇到滑块验证码；被拦时需要人工过一次滑块 |
| 知乎 | `zhihu` | `zhihu.json` | `z_c0` | 自动检测 |
| 穷游 | `qyer` | `qyer.json` | 无（回车确认兜底） | 登录入口在论坛（bbs.qyer.com） |
| 小红书 | `xhs` | `xhs.json` | `web_session` | **无 cookie 时该源直接跳过**（判 failed，原因 no-cookie） |
| B站 | `bilibili` | `bilibili.json` | `SESSDATA` | 供视频游记下载（yt-dlp）使用 |

## 查看现状：cookies.ts status

```bash
npx tsx ~/.pilot/app/tools/cookies.ts status
```

输出各站表格：cookie 文件是否存在、标志 cookie 是否在、最早过期时间。cookie 过期后重跑 `setup --site <站点>` 即可。

## 常见问题

**登录成功了但工具没检测到？**
马蜂窝/穷游没有稳定标志 cookie，工具会提示你登录完成后按回车确认。知乎/小红书/B站若自动检测失败，等几秒（轮询间隔 2 秒）或重跑。

**导出 cookie 后马蜂窝还是被验证码拦？**
是的，这可能发生——马蜂窝的滑块验证码独立于登录态。PILOT 会如实汇报被拦数量，你可以选择人工过一次滑块后让它重试，或接受用其他源的素材。

**担心安全？**
建议用小号登录；用完可随时删 `~/.pilot/cookies/`。工具代码开源可审计（`tools/cookies.ts`、`tools/lib/sites/cookies.ts`）。
