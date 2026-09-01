/**
 * Vendors kokoro-js (+ transformers.js + ONNX Runtime Web) into
 * listen-carefully/vendor/ so the extension ships with no build step and no
 * remote code - MV3 forbids loading scripts or wasm from a CDN.
 *
 * Outputs:
 *   vendor/kokoro-js.bundle.mjs              ESM bundle, imported by the offscreen doc
 *   vendor/ort-wasm-simd-threaded.jsep.*     ORT kernel + loader, via env.wasm.wasmPaths
 *
 * Run: node build.mjs   (from this directory)
 */
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VENDOR = path.join(HERE, '..', 'listen-carefully', 'vendor');
fs.mkdirSync(VENDOR, { recursive: true });

// transformers.js and kokoro-js statically import Node-only modules
// (onnxruntime-node, sharp, fs, path, ...) so one source file can serve both
// runtimes; none of them exist in a browser. Marking them `external` is not
// an option here: the bare specifiers survive into the ESM output and the
// browser then throws "Failed to resolve module specifier" at import time.
// Replace them with empty modules instead - every use sits behind an
// `apis.IS_NODE_ENV` check that is false in the offscreen document.
const NODE_ONLY = /^(node:)?(onnxruntime-node|sharp|fs|fs\/promises|path|url|module|stream|stream\/web|worker_threads|os|crypto)$/;

const stubNodeOnly = {
  name: 'stub-node-only',
  setup(build) {
    build.onResolve({ filter: NODE_ONLY }, (args) => ({ path: args.path, namespace: 'stub' }));
    build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      // A Proxy keeps `import x from 'fs'; x.readFileSync` from throwing at
      // module-evaluation time in code paths that only *reference* the API.
      contents: `const stub = new Proxy({}, { get: () => undefined });
export default stub;
export const Tensor = undefined;`,
      loader: 'js',
    }));
  },
};

const result = await esbuild.build({
  entryPoints: [path.join(HERE, 'kokoro-entry.mjs')],
  outfile: path.join(VENDOR, 'kokoro-js.bundle.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'chrome120',
  minify: true,
  legalComments: 'none',
  plugins: [stubNodeOnly],
  metafile: true,
});

// ONNX Runtime resolves its kernel and the matching loader module against
// env.wasm.wasmPaths at runtime rather than through the bundler, so both
// files have to sit on disk beside the bundle. The .jsep build is the one
// that carries the WebGPU execution provider as well as wasm.
const ORT_FILES = [
  'ort-wasm-simd-threaded.jsep.wasm',
  'ort-wasm-simd-threaded.jsep.mjs',
];
for (const file of ORT_FILES) {
  fs.copyFileSync(
    path.join(HERE, 'node_modules', 'onnxruntime-web', 'dist', file),
    path.join(VENDOR, file),
  );
}

for (const [file, meta] of Object.entries(result.metafile.outputs)) {
  console.log(`${path.basename(file)}  ${(meta.bytes / 1e6).toFixed(2)} MB`);
}
for (const file of ORT_FILES) {
  console.log(`${file}  ${(fs.statSync(path.join(VENDOR, file)).size / 1e6).toFixed(2)} MB`);
}
