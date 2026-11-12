# 架构

## 运行形态

纯静态站点：`index.html` + 一个 ES module 入口 + 一个 Web Worker。没有后端、没有账号、不发网络请求（除加载同源的模型与 ORT 运行时）。所有状态都在内存里，只有设置写 `localStorage`。

```text
index.html
  └─ src/main.ts            单一入口，持有唯一一份对局状态
       ├─ src/render/       Canvas 棋盘、DPR 适配、皮肤
       ├─ src/ui/           棋盘之外的界面：复盘屏、大肥鱼形象（SVG 兜底）
       ├─ src/audio/        Web Audio 音效与 BGM
       ├─ src/app/          设置持久化、复盘控制器
       ├─ src/game/         规则、搜索、战术、提示、复盘派生、记录（纯函数）
       └─ src/ai/           Worker 客户端 → Worker → onnxruntime-web
```

## 分层与依赖方向

依赖只能从上往下走，反向依赖（`game` 里 import `render`）视为设计错误：

| 层 | 目录 | 职责 | 依赖 |
|---|---|---|---|
| 入口 | `src/main.ts` | 状态机、事件绑定、DOM 更新 | 全部下层 |
| 视图 | `src/render/` `src/ui/` `src/styles/` | 只画，不改规则 | `game/types` |
| 交互 | `src/audio/` `src/app/` | 音效、设置读写、复盘队列 | `game/` `ai/client` |
| 规则与搜索 | `src/game/` | 棋盘、胜负、MCTS、战术、解释 | 仅 `game/types`，纯函数 |
| 推理 | `src/ai/` | Worker 协议与 ONNX 会话 | `game/types` |

`src/game/` 是纯函数，不碰 DOM 也不碰 Worker；推理由入口层通过 `AiClient` 发起，拿到 `SearchResult` 再交回 `game/explain` 生成解释。这样搜索逻辑可以在 Node 里直接跑，不需要浏览器环境。

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

## 复盘的数据流

```text
结算弹窗「复盘」
  → main.ts 快照 history（只读，不碰对局状态）
  → app/review.ts 建局面点与每步盘面
  → 简易：AiClient.evaluate 逐局面一次
    深度：AiClient.search 逐局面 82 sims（REVIEW_PROFILE）
  → game/review.ts 派生：人类视角、估值损失、评级、汇总
  → ui/review-view.ts 画第二块棋盘、估值曲线、着手列表

首页「导入对局」
  → game/record.ts parseRecord（schema + hash）
  → app/review.ts fromRecord（值、评级、标签原样还原）
  → 同一块复盘屏，只读，不经过 Worker
```

关键点：

- **落子后的值是对手视角**：`loss = max(0, before + after - 1)`，直接相减会把制胜手算成损失。
- **深度评估必须评每个局面**：只评人类回合会拿深评的 before 和快速的 after 相减，两种估计器混用。
- **双方都评级**，`human` 字段只决定「你 / 对手」的措辞与汇总分组。
- **记录 hash 只做完整性校验**：改完记录重算 hash 是免费的，防伪需要服务端签名。
- 复盘复用 `AiClient`，不新增 Worker 消息类型；退出复盘时 `cancelAll`。

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
