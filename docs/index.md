# PILOT 文档

**PILOT** 是一个 Claude Code Skill：对话式旅行路书设计工具。实时搜索全网真实游记 → 结构化精选 → 对话生成与编辑行程 → 冲突检查 → 导出 Excel / PDF / Word 三格式路书，另配浏览器地图伴侣视图。全程本地运行。

仓库主页与安装说明：[github.com/twisker/pilot-skill](https://github.com/twisker/pilot-skill)

## 文档导览

| 文档 | 你想做什么 |
|------|-----------|
| [快速上手教程](tutorial-quickstart.md) | 从安装到导出第一份路书，完整走一遍（含预期终端输出） |
| [cookie 导出指南](guide-cookies.md) | 提升马蜂窝/知乎/穷游/小红书/B站的抓取成功率 |
| [配置参考](guide-config.md) | `config/pilot.json` 全字段说明（源路由 / 精选数量 / 地图等） |
| [路书导出说明](guide-export.md) | 四段结构、Excel 四 sheet、模板 sheet 用法 |
| [常见问题 FAQ](faq.md) | 抓取被拦 / 无 key 地图 / 如何更新 等 |

## 一分钟了解主链路

```
① 意图收集     对话问清目的地/日期/人群/预算/交通/偏好 → intake.json
② 搜索编排     多源搜索计划 → WebSearch → 挑选候选 → 抓取正文（playwright 兜底）
③ 结构化       每条游记一个子代理，整理为统一 travelogue JSON
④ 精选         校验 → 去重 → 机器打分 + 品味分 → 留前 5 条（含视频补充轮）
⑤ 行程生成     以最优游记为蓝本裁剪成逐日行程，对话编辑随改随查
⑥ 逐日细化     住宿/交通/餐饮/门票逐天补齐，坐标联网查证（不许凭记忆填）
⑦ 冲突检查     长途驾车/单日过密/预算超限/坐标距离异常等确定性规则
⑧ 导出         PDF → Excel → Word 三件套，落盘 ~/.pilot/workspace/<trip-id>/exports/
```

所有数据都在你的机器上：行程与素材在 `~/.pilot/workspace/`，程序安装在 `~/.pilot/app/`，cookie 在 `~/.pilot/cookies/`（绝不上传）。

## 快速命令速查

```bash
npx tsx ~/.pilot/app/tools/trip.ts current            # 查看当前行程指针
npx tsx ~/.pilot/app/tools/cookies.ts setup           # 引导式导出站点 cookie
npx tsx ~/.pilot/app/tools/cookies.ts status          # 各站 cookie 现状表
npx tsx ~/.pilot/app/tools/server/server.ts start --trip <trip-id>   # 手动启动地图伴侣
```

> 这些命令一般不需要手动敲——在 Claude Code 对话里 PILOT 会自己调用。它们在排查问题时有用。
