# 本地开发

## 前置

Node 与 npm，不需要全局安装任何工具。唯一运行时依赖是 `onnxruntime-web`，`npm install` 一次即可。

## 命令

| 命令 | 作用 |
|---|---|
| `npm install` | 安装依赖 |
| `npm run dev` | 开发服务器，`http://127.0.0.1:5173/DaFeiYuGomo/` |
| `npm run build` | `tsc --noEmit` + 生产构建到 `dist/` |
| `npm run preview` | 预览 `dist/` |
| `npm test` | 单元测试（vitest，`tests/` 目录） |

`predev` / `prebuild` 会先把 ORT 的 wasm 运行时复制到 `public/ort/`。该目录由脚本生成，不要手工编辑，也不要提交。

## 三个容易撞上的问题

1. **根路径 404**：`base` 固定为 `/DaFeiYuGomo/`，开发服务器也只在这个前缀下提供服务。打开 `http://127.0.0.1:5173/` 会白屏，必须带路径。
2. **模型 404**：模型在 `public/models/model-v2.onnx`，通过 `AI_CONFIG.modelUrl` 以相对 base 的路径取。移动文件要同步改常量。
3. **`npm test` 报找不到用例**：`tests/` 在 `.gitignore` 里（本地保留、不随仓库发布），新克隆的仓库没有这个目录，测试为空是预期行为，不是环境坏了。

## 目录

```text
src/game/      棋盘规则、MCTS、战术、提示逻辑、缓存
src/content/   气泡台词（唯一文案源）
src/ai/        Worker 与 ONNX Runtime 推理
src/render/    Canvas 棋盘、DPR 适配、皮肤
src/audio/     Web Audio 生命周期与合成音效
src/ui/        大肥鱼 SVG 兜底形象
src/app/       设置持久化
public/        模型、图片、音频、ORT 运行时
scripts/       构建期脚本
docs/          版本技术档案与工程文档
```

各层职责与依赖方向见 [architecture.md](./architecture.md)，移动端与 UI 的实现约束见 [ui.md](./ui.md)。
