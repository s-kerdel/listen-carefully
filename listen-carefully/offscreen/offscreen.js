/**
 * Offscreen document - hosts the Kokoro-js (in-browser ONNX) synthesis session.
 *
 * Why an offscreen document rather than the service worker or the content
 * script:
 *   - The service worker is evicted after ~30s idle, which would throw away
 *     the ~90 MB loaded model and force a re-init on every sentence. It also
 *     has no WebGPU adapter and no `URL.createObjectURL`.
 *   - The content script runs per-tab under the *page's* CSP, so wasm
 *     compilation is routinely blocked and each tab would load its own copy.
 * The offscreen document is a single extension-origin page that lives as long
 * as we keep it open, so the model is loaded once per browser session.
 *
 * It only *generates* audio: the WAV bytes go back to the content script,
 * which plays them through the same path as the Kokoro-FastAPI backend so
 * word-highlight sync has a single implementation.
 */

import { KokoroTTS, env } from '../vendor/kokoro-js.bundle.mjs';

// MV3 forbids remote code, so point ONNX Runtime at the vendored kernel
// instead of its default jsDelivr URL. Extension pages are not
// cross-origin-isolated, so SharedArrayBuffer (and therefore ORT's threaded
// path) is unavailable - asking for 1 thread avoids a blob-worker spawn that
// the extension CSP would block anyway.
env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('vendor/');
env.backends.onnx.wasm.numThreads = 1;
env.allowLocalModels = false;
env.useBrowserCache = true;

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';

// Model weights are tens of megabytes, so a load is a one-shot per config.
// `loadKey` records which device `ttsPromise` resolves to; a settings change
// invalidates it and triggers a fresh load.
let ttsPromise = null;
let loadKey = null;

// Snapshot of the most recent load, polled by the options page to render the
// download progress bar. `state` is 'idle' | 'loading' | 'ready' | 'error'.
let status = { state: 'idle', progress: 0, device: null, error: null };

/**
 * Resolve the execution device, degrading to wasm when WebGPU is requested
 * but unavailable (no adapter, or the flag is off in this Chrome build).
 * Kokoro-js recommends fp32 on WebGPU and q8 on wasm; a mismatched pair
 * produces silence rather than an error, so the dtype is corrected too.
 */
async function resolveBackend(device) {
  if (device === 'webgpu') {
    try {
      if (navigator.gpu && await navigator.gpu.requestAdapter()) {
        return { dtype: 'fp32', device: 'webgpu' };
      }
    } catch { /* fall through to wasm */ }
    console.info('Kokoro-js: WebGPU unavailable, falling back to wasm');
  }
  return { dtype: 'q8', device: 'wasm' };
}

/**
 * Load the model, or return the in-flight/loaded instance for this config.
 * Concurrent callers share one promise so a burst of sentences at the start
 * of a read does not kick off several downloads.
 */
function getTTS(device) {
  if (ttsPromise && loadKey === device) return ttsPromise;

  loadKey = device;
  status = { state: 'loading', progress: 0, device: null, error: null };

  ttsPromise = (async () => {
    const resolved = await resolveBackend(device);
    status.device = resolved.device;
    try {
      const tts = await KokoroTTS.from_pretrained(MODEL_ID, {
        dtype: resolved.dtype,
        device: resolved.device,
        progress_callback: (p) => {
          if (p.status === 'progress' && typeof p.progress === 'number') {
            // Several files download in parallel; the largest one dominates,
            // so tracking the max avoids a bar that jumps backwards.
            status.progress = Math.max(status.progress, Math.round(p.progress));
          }
        },
      });
      status = { state: 'ready', progress: 100, device: resolved.device, error: null };
      return tts;
    } catch (err) {
      status = {
        state: 'error', progress: 0, device: resolved.device,
        error: err?.message || String(err),
      };
      // Drop the rejected promise so the next request retries instead of
      // replaying the same failure forever.
      if (loadKey === device) { ttsPromise = null; loadKey = null; }
      throw err;
    }
  })();

  return ttsPromise;
}

// --- Idle unload ---
//
// The loaded model pins its weights for as long as this document lives - on
// the WebGPU path that is VRAM, which nothing else can reclaim. Tearing the
// whole document down is the reliable way to release it: closing the page
// drops the ONNX session and the WebGPU device together, where disposing the
// model alone would leave ORT's device and buffer cache behind. The reload
// afterwards is served from the browser cache, so it costs re-initialization
// time rather than a re-download.

let idleTimer = null;
let pendingRequests = 0;

/**
 * (Re)arm the unload timer. `minutes` of 0 (or anything non-positive) means
 * "keep resident", matching the Never option in settings.
 */
function scheduleIdleUnload(minutes) {
  clearTimeout(idleTimer);
  idleTimer = null;

  const m = Number(minutes);
  if (!Number.isFinite(m) || m <= 0) return;

  idleTimer = setTimeout(() => {
    // Only the document teardown is needed; ttsPromise and the ORT session go
    // with it.
    window.close();
  }, m * 60_000);
}

/** Base64-encode in chunks - `fromCharCode(...bytes)` overflows the stack. */
function toBase64(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

// Only one generation runs at a time: the ONNX session is not reentrant, and
// serialising also keeps a rapid skip from queueing work on the GPU.
let generateChain = Promise.resolve();

async function synthesize(msg) {
  const tts = await getTTS(msg.device);
  const audio = await tts.generate(msg.text, {
    voice: msg.voice,
    speed: msg.speed || 1.0,
  });
  return {
    audio: toBase64(audio.toWav()),
    audio_format: 'audio/wav',
    // Kokoro-js exposes no word timings, so the caller estimates them. Sending
    // the exact duration lets it do that without waiting for loadedmetadata.
    duration: audio.audio.length / audio.sampling_rate,
    device: status.device,
  };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return;
  if (msg?.target !== 'offscreen-kokorojs') return;

  if (msg.type === 'kokoroJsStatus') {
    sendResponse({ ...status });
    return false;
  }

  if (msg.type === 'kokoroJsSynth') {
    // Hold the unload off for as long as any request is outstanding, and re-arm
    // only once the queue fully drains - arming after each individual request
    // would let a short timeout fire while a later, slower sentence is still
    // being synthesized.
    pendingRequests++;
    clearTimeout(idleTimer);
    idleTimer = null;

    // Chain rather than run concurrently; a failure must not poison the chain.
    generateChain = generateChain
      .then(() => synthesize(msg))
      .then(sendResponse, (err) => sendResponse({ error: err?.message || String(err) }))
      .catch(() => {})
      .finally(() => {
        pendingRequests--;
        if (pendingRequests === 0) scheduleIdleUnload(msg.idleUnloadMinutes);
      });
    return true; // async response
  }
});
