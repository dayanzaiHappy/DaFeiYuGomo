// 把 ONNX Runtime Web 的 wasm 运行时复制到 public/ort/，供 Worker 在子路径下加载。
// jsep 版本只在支持 WebGPU 的浏览器里按需下载。
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = join(root, 'node_modules', 'onnxruntime-web', 'dist');
const dst = join(root, 'public', 'ort');

if (!existsSync(src)) {
  console.error('找不到 onnxruntime-web/dist，请先运行 npm install');
  process.exit(1);
}

mkdirSync(dst, { recursive: true });

const files = [
  'ort-wasm-simd-threaded.mjs',
  'ort-wasm-simd-threaded.wasm',
  'ort-wasm-simd-threaded.jsep.mjs',
  'ort-wasm-simd-threaded.jsep.wasm',
];

for (const file of files) {
  const from = join(src, file);
  if (!existsSync(from)) {
    console.error(`缺少文件: ${from}`);
    process.exit(1);
  }
  copyFileSync(from, join(dst, file));
  console.log(`copied ${file}`);
}
