# DaFeiYuGomo

五子棋网页版，从桌面版五子棋项目移植。棋盘 15×15，五连即胜；Bot 沿用桌面版 v2 模型 + MCTS 搜索。

在线地址：<https://dayanzaihappy.github.io/DaFeiYuGomo/>

## 功能

- **人 vs 人**：本地双人，支持悔棋、重开、返回菜单。
- **人 vs 机**：可选执黑 / 执白；执白时 Bot 先下天元。难度分简单 / 普通 / 困难 / 地狱，可在设置中切换。
- **提示**：只在你的人机对战回合可用；蓝色大肥鱼思考后给出建议落点与理由。
- **复盘**：人机局结束后可逐手回看。简易评估秒级给出估值曲线，深度评估补上最佳着、评级与漏着标签；点「正确着法」可看收回原落子、落下正确一手的动画；支持自动回放、倍速与导出 JSONL。
- **导入回放**：首页可直接打开导出的 JSONL，离线重建曲线、评级与正确着法，不需要重新推理。
- **移动端**：Canvas 高清适配、触控落子、竖屏布局、棋盘区不干扰页面滚动。
- **音效**：落子、胜利、失败、和棋、提示、非法操作、按钮，Web Audio 合成；总开关 + 音量可调，设置本地保存。
- **皮肤**：经典木纹 / 青玉 / 黑曜 / 霓虹，切换不刷新页面；可选「音效跟随皮肤」。

不做账号、在线联机、跨设备存档；界面仅中文。

## 运行

```bash
npm install
npm run dev      # http://127.0.0.1:5173/DaFeiYuGomo/
npm run build    # 类型检查 + 生产构建
```

需要 Node 与 npm，没有其他环境依赖。部署到 GitHub Pages 的说明见 [docs/dev/deploy.md](./docs/dev/deploy.md)。

## 文档

| 文件 | 内容 |
|---|---|
| [CHANGELOG.md](./CHANGELOG.md) | 各版本面向用户的变更 |
| [docs/README.md](./docs/README.md) | 文档地图与命名规则 |
| [docs/versions/](./docs/versions/) | 各版本的技术档案，一个版本一个文件 |
| [docs/dev/](./docs/dev/) | 架构、本地开发、部署、UI 约束 |
| [docs/CREDITS.md](./docs/CREDITS.md) | 素材来源与许可 |

想知道 AI 为什么这么下、某个参数为什么取这个值，看对应版本的 `docs/versions/vX.Y.Z.md`；要动代码，先看 `docs/dev/architecture.md`。

## 版权与素材

- 头像素材来自 DeepSeek 相关二创社区（「蓝色大肥鱼 / 鲸鱼娘」同人图），如有侵权请联系删除。
- 背景音乐：B 站《Let me go 大肥鱼和用户深情对唱》，UP 主 @星落落_oi（BV13SYr6dEiQ）；版权归原作者所有，如有侵权请联系删除。
- 桌面版代码与 v2 模型：MIT，Copyright (c) 2026 dayanzaiHappy；许可见 [LICENSE](./LICENSE)。
- 其余棋盘、棋子、图标由 Canvas/SVG 生成，音效由 Web Audio 合成。
- 详见 [docs/CREDITS.md](./docs/CREDITS.md)。
- 「蓝色大肥鱼」是 DeepSeek 鲸鱼娘的社区昵称；本项目与 DeepSeek 官方无关。
