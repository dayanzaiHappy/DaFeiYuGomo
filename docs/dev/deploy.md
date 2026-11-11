# 部署

发布目标是 GitHub Pages，产物是 `dist/` 静态文件，没有服务端。

## 链路

`.github/workflows/deploy.yml`：push 到 `main` 后 `npm ci` → `npm run build` → 上传 `dist/` → GitHub Pages。仓库设置里 Pages 的来源必须是 GitHub Actions，不是分支目录。

线上地址：<https://dayanzaihappy.github.io/DaFeiYuGomo/>

## 与仓库名绑定的两处

- Vite `base` 固定 `/DaFeiYuGomo/`，所有资源引用都带这个前缀。
- 仓库名必须叫 `DaFeiYuGomo`。改仓库名、或部署到用户主页根路径，都要同步改 `vite.config.ts` 的 `base`，否则页面白屏、资源 404。

## 运行时约束

GitHub Pages 不发 `Cross-Origin-Opener-Policy` / `Cross-Origin-Embedder-Policy`，因此 `SharedArrayBuffer` 不可用：

- ORT 的 WASM 后端固定**单线程**。想开多线程必须换到能设响应头的托管环境。
- 支持 WebGPU 的浏览器会先尝试 WebGPU；初始化时测一次单次评估耗时，比不上 WASM 就自动回退。

## 发布前

1. `npm run build` 必须过（含 `tsc --noEmit`）。
2. `package.json` 的版本、`CHANGELOG.md` 的条目、`docs/versions/vX.Y.Z.md` 三处一致。
3. 版本文件先写、再提交：技术档案和代码在同一次提交里，事后不用回头补。
4. 被 `.gitignore` 忽略的目录（`docs/local/`、`tests/`、`assets/`、`public/ort/`）不要用 `git add -f` 强加。

## 回滚

Pages 只认 `main` 的最新构建产物： revert 一个提交并 push 即可回滚线上版本。不要用强推改写已发布的提交——远端可能已经有人拉过。
