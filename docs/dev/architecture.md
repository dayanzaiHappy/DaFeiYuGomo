# 架构

## 运行形态

纯静态站点：`index.html` + 一个 ES module 入口 + 一个 Web Worker。没有后端、没有账号、不发网络请求（除加载同源的模型与 ORT 运行时）。所有状态都在内存里，只有设置写 `localStorage`。

```text
index.html
  └─ src/main.ts            单一入口，持有唯一一份对局状态
       ├─ src/render/       Canvas 棋盘、DPR 适配、皮肤
       ├─ src/ui/           大肥鱼形象（SVG 兜底）
       ├─ src/audio/        Web Audio 音效与 BGM
       ├─ src/app/          设置持久化
       ├─ src/game/         规则、搜索、战术、提示、缓存（纯函数）
       └─ src/ai/           Worker 客户端 → Worker → onnxruntime-web
```

## 分层与依赖方向

依赖只能从上往下走，反向依赖（`game` 里 import `render`）视为设计错误：

| 层 | 目录 | 职责 | 依赖 |
|---|---|---|---|
| 入口 | `src/main.ts` | 状态机、事件绑定、DOM 更新 | 全部下层 |
| 视图 | `src/render/` `src/ui/` `src/styles/` | 只画，不改规则 | `game/types` |
| 交互 | `src/audio/` `src/app/` | 音效、设置读写 | 无 |
| 规则与搜索 | `src/game/` | 棋盘、胜负、MCTS、战术、解释 | 仅 `game/types`，纯函数 |
| 推理 | `src/ai/` | Worker 协议与 ONNX 会话 | `game/types` |

`src/game/` 是纯函数，不碰 DOM 也不碰 Worker；推理由入口层通过 `AiClient` 发起，拿到 `SearchResult` 再交回 `game/explain` 生成解释。这样搜索逻辑可以在 Node 里被脚本直接跑（`docs/local/bench/` 就是这么复现实验的）。

## 一次落子的数据流

```text
点击 / 触摸
  → BoardView 换算成 move
  → main.ts 校验（是否轮到人、格子是否为空）
  → board.ts placeStone → checkWin
  → 需要 AI 时：aiConfig 取档位 → toSearchOptions → AiClient.search
      → Worker: 编码 planes → session.run → policy/value
      → mcts.ts: VCF 快检 → 候选截断 → N 次模拟（选择/扩展/评估/回传）
      → 采样出 move → 回传 SearchResult
  → board.ts placeStone → render/board-view 重绘 → 音效 → 气泡文案
```

关键点：

- **棋盘状态不可变**：`placeStone` 返回新数组，搜索里靠「沿路径落子 / 撤销」复用同一块盘面，不做整盘拷贝。
- **候选生成是热点**：`legalMoves` 用预计算邻接表 + 位图去重，输出序列必须保持稳定，否则同一局面的搜索结果会漂移。
- **文案与逻辑分离**：气泡台词全在 `src/content/whale-lines.ts`，`game/` 只产出结构化结果，不拼文案。

## 状态与持久化

| 状态 | 位置 | 生命周期 |
|---|---|---|
| 对局（棋盘、轮到谁、历史手） | `main.ts` 内的单一对象 | 刷新即丢 |
| 设置（难度、皮肤、音效、音量） | `localStorage`，键 `dafeiyugomo.settings.v1` | 跨会话 |
| 提示缓存 | 内存 LRU | 刷新即丢 |
| 版本号 | 构建期 `__APP_VERSION__`，来自 `package.json` | 随构建固定 |

设置读取一律做兜底：键不存在、JSON 坏了、难度值是已删除的档位，都回落到默认值。隐私模式下 `localStorage` 不可写时静默忽略，不能因此阻塞启动。

## 构建产物

`npm run build` = `tsc --noEmit` + `vite build`。产物 `dist/` 可直接静态托管：

- `base` 固定 `/DaFeiYuGomo/`，与仓库名绑定。
- `prebuild` 把 `onnxruntime-web` 的 wasm 运行时复制到 `public/ort/`，随构建进 `dist/ort/`。
- Worker 以 ES module 形式打包（`worker.format = 'es'`），模型与 wasm 都不内联（`assetsInlineLimit = 0`），避免首屏体积被 base64 撑大。
