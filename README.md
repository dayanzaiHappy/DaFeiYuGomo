# DaFeiYuGomo

五子棋网页版，从桌面版五子棋项目移植。棋盘 15×15，五连即胜；Bot 沿用桌面版 v2（b6c96 ONNX）+ MCTS。

在线地址：<https://dayanzaihappy.github.io/DaFeiYuGomo/>

## 功能

- **人 vs 人**：本地双人，支持悔棋、重开、返回菜单。
- **人 vs 机**：可选执黑/执白；执白时 Bot 先下天元。AI 难度分简单 / 普通 / 困难 / 地狱，可在设置中切换。
- **提示**：只在你的人机对战回合可用；蓝色大肥鱼思考后给出建议落点和理由。
- **移动端**：Canvas 高清适配、触控落子、竖屏布局、棋盘区禁止滚动/缩放冲突。
- **音效**：落子、胜利、失败、和棋、提示、非法操作、按钮，Web Audio 合成；总开关 + 音量持久化。
- **皮肤**：经典木纹 / 青玉 / 黑曜 / 霓虹，切换不刷新页面；可选“音效跟随皮肤”。

不做对局保存、回看、账号、在线联机；界面仅中文。

## AI

- 模型：桌面版 `src/v2/model.onnx`，b6c96，输入 `planes[B,2,15,15]`，输出 `policy[225]`、`value[1]`。
- 搜索：`C_PUCT=2.0`、邻域半径 4、空盘天元、顺序 MCTS。四档难度（简单 / 普通 / 困难 / 地狱）的搜索预算为 40 / 66 / 109 / 179 次推演（公比 √e）；对手在根节点加 Dirichlet 噪声（α=0.1，ε = 0.10 / 0.06 / 0.03 / 0.01），噪声只作用在“先验不低于 top1 的 50%、且距上一手切比雪夫 ≤ 2 格”的前 12 / 10 / 8 / 8 个候选上，避免把明显不合理的点抬到最前；搜索结束后按 visits 温度采样（前 3 名，τ = 1.0 / 0.6 / 0.3 / 0.1），提示保持确定性 argmax、预算 292 次推演；玩家先手时，Bot 白棋第一手只做一次 policy 前向、不跑 MCTS，在玩家落子切比雪夫距离 ≤ 2 内按 policy / 贴近玩家 / 靠近天元 = 0.50 / 0.30 / 0.20 评分，并在前 3 名内加权随机落子。其余 PvAI 与提示共用同一套规则/评估，仅搜索预算和随机化设置不同。
- 推理：`onnxruntime-web` 在 Web Worker 中运行；初始化时分别测量 WebGPU / WASM 单次评估，自动选择更快的后端；失败时回退 WASM。
- 提示支持 LRU 缓存；同一局面重复请求秒回。

## 本地开发

```bash
npm install
npm run dev
```

打开 `http://127.0.0.1:5173/DaFeiYuGomo/`。

```bash
npm run build     # 类型检查 + 生产构建
npm run preview   # 预览 dist
```

## 部署

- 仓库名必须是 `DaFeiYuGomo`；Vite `base` 固定为 `/DaFeiYuGomo/`。
- `.github/workflows/deploy.yml` 在 push 到 `main` 后执行 `npm ci` → `npm run build` → GitHub Pages。
- `prebuild` 会把 `onnxruntime-web` 的 wasm 运行时复制到 `public/ort/`；构建产物 `dist/` 可直接静态托管。
- GitHub Pages 没有 COOP/COEP，因此 ORT 固定单线程 WASM；支持 WebGPU 的浏览器会优先尝试 WebGPU，若不快则自动回退。

## 目录

```text
src/game/      棋盘、规则、MCTS、提示逻辑、缓存
src/content/   大肥鱼台词（whale-lines.ts，改提示文案只改这里）
src/ai/        Web Worker + ONNX Runtime Web 推理
src/render/    Canvas 棋盘、DPR 适配、皮肤
src/audio/     Web Audio 生命周期与合成音效
src/ui/        大肥鱼 SVG 兜底形象
src/app/       设置持久化
public/images/ 大肥鱼头像（完整原图等比缩放，未裁切）
public/audio/  背景音乐（bgm/Let Me Go.mp3）
docs/          版权与素材说明（计划/报告等本地产物放 docs/local/，不提交）
assets/        原始素材（仅本地保留，不提交）
scripts/       ORT 资源复制
```

## 版权与素材

- 头像素材来自 DeepSeek 相关二创社区（“蓝色大肥鱼 / 鲸鱼娘”同人图），如有侵权请联系删除。
- 背景音乐：B 站《Let me go 大肥鱼和用户深情对唱》，UP 主 @星落落_oi（BV13SYr6dEiQ）；版权归原作者所有，如有侵权请联系删除。
- 桌面版代码与 v2 模型：MIT，Copyright (c) 2026 dayanzaiHappy；许可见 [LICENSE](./LICENSE)。
- 其余棋盘、棋子、图标由 Canvas/SVG 生成，音效由 Web Audio 合成。
- 详见 [docs/CREDITS.md](./docs/CREDITS.md)。
- “蓝色大肥鱼”是 DeepSeek 鲸鱼娘的社区昵称；本项目与 DeepSeek 官方无关。
