# 常见问题 FAQ

## 抓取与素材

### 抓取被验证码/反爬拦了怎么办？

**这是常态，不是故障。** 马蜂窝有滑块验证码 WAF，小红书无 cookie 直接拒绝，即使 playwright 也可能被拦。PILOT 的完整降级链：

```
WebSearch（免费）→ WebFetch 直读 → playwright 兜底抓取
→ 摘要（summary-only）增补 → 标记失败继续 → 覆盖率如实汇报
```

素材不足时 PILOT 会给你三个选项，由你决定：

1. **继续**：用现有素材做，置信度低的天会标出来
2. **导出 cookie 后重试**：见 [cookie 指南](guide-cookies.md)，成功率提升最明显的一步
3. **换源/换词重搜**：调整目的地粒度或措辞重来一轮

### 覆盖率汇报里「summary-only 增补」是什么？

正文抓取失败但搜索摘要（snippet）信息量足够的条目，PILOT 会只依据标题+摘要生成一条低置信度的结构化游记参与精选，**且单独计数、绝不冒充抓取成功**。增补占比超过一半时 PILOT 会额外提醒素材质量偏低。

### 为什么覆盖率里携程攻略/图虫总是靠前？

配置里的 `preferred_domains` 对实证抓取成功率高的域名做了排序加权（见[配置参考](guide-config.md)），属预期行为。

## 地图

### 没有天地图 key，地图会怎样？

地图视图显示引导文案（不报错），时间线与参考游记卡片墙照常可用，行程设计主链路完全不受影响。key 免费：[天地图控制台](https://console.tianditu.gov.cn/) 注册 → 创建「浏览器端」应用 → 把 key 写进 `~/.pilot/app/.env`：

```
TIANDITU_KEY=你的key
```

### 地图页面打不开？

- 确认 server 在跑：行程进行中 PILOT 会自动启动；手动启动：
  `npx tsx ~/.pilot/app/tools/server/server.ts start --trip <trip-id>`
- 端口冲突：默认 4870，可在 `.env` 设 `PILOT_PORT` 换端口
- server 启动失败不阻塞主链路——全程终端对话也能完成路书

### 行程里有的点没上地图？

坐标必须联网查证，查证不到的条目 `geo` 为空、不上图（PILOT 宁缺毋滥，不凭记忆填坐标）。

## 安装与更新

### 如何更新到新版本？

```bash
cd ~/.pilot/app && git pull && ./install.sh
```

（若你 clone 在别处，进 clone 目录 `git pull && ./install.sh`，脚本会重新同步到 `~/.pilot/app`。）
你的数据不受影响：行程在 `~/.pilot/workspace/`，cookie 在 `~/.pilot/cookies/`，`.env` 也会被保留。

### 如何卸载？

```bash
rm ~/.claude/skills/pilot          # 取消 skill 注册（是个 symlink；Windows 上可能是目录 junction 或整份复制，看安装时的日志）
rm -rf ~/.pilot/app                # 删除程序
rm -rf ~/.pilot                    # （可选）连同所有行程数据与 cookie 一起删除
```

Windows（PowerShell）对应命令：`Remove-Item $env:USERPROFILE\.claude\skills\pilot -Recurse -Force` / `Remove-Item $env:USERPROFILE\.pilot -Recurse -Force`。

### 视频游记功能提示缺 yt-dlp / ffmpeg？

视频理解是可选功能，一键装：

```bash
cd ~/.pilot/app/tools && npx tsx setup-video.ts install --yes
```

跨平台（macOS/Windows/Linux）下载官方静态二进制到 `~/.pilot/bin/`，不需要 brew / winget / apt，也不需要预装 python。已经装过且能跑会自动跳过；`--force` 强制重下。不装则 PILOT 自动跳过视频轮，只用文字与图集素材，不影响主链路。

macOS 上如果提示"无法验证开发者"（Gatekeeper 拦截未签名二进制），按报错信息执行一次 `xattr -d com.apple.quarantine <二进制路径>` 再重试。

### /pilot 没有触发？

- 确认 skill 已注册：`ls -l ~/.claude/skills/pilot`（Windows: `dir %USERPROFILE%\.claude\skills\pilot`）应指向/包含 `~/.pilot/app/skill` 的内容
- 需要**新开**一个 Claude Code 会话（skill 列表在会话启动时加载）
- 重跑安装脚本可修复注册：macOS/Linux `~/.pilot/app/install.sh`；Windows `node %USERPROFILE%\.pilot\app\install.mjs`

## 数据与隐私

### 我的数据会上传吗？

不会。PILOT 工具链零云端依赖：搜索抓取在你本机执行，行程/素材/cookie 全部落盘本机 `~/.pilot/`。与 Claude 的对话本身遵循你的 Claude Code 数据设置。

### cookie 安全吗？

cookie 只保存在 `~/.pilot/cookies/`，绝不上传；建议用小号，随时可删。详见 [cookie 指南](guide-cookies.md)的红线声明。

### 想从头再来一个行程？

直接说「新开一个行程」即可，旧行程原样保留在 `~/.pilot/workspace/`，随时可以回来继续。
