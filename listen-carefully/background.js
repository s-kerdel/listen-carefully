/**
 * Background Service Worker - handles context menu and both Kokoro backends.
 *
 * Kokoro-FastAPI fetches are routed through the service worker (not the
 * content script) to avoid Chrome's per-site permission prompts for
 * cross-origin requests. The /dev/captioned_speech response is JSON (base64
 * audio + timestamps), so it passes through sendResponse without
 * serialization issues.
 *
 * Kokoro-js runs in an offscreen document (see offscreen/offscreen.js); the
 * worker owns that document's lifecycle and relays messages to it, because
 * content scripts cannot address an offscreen document directly.
 */

importScripts('lib/config.js');

// --- Context menu ---

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'tts-read-from-here',
    title: 'Read from here',
    contexts: ['page', 'selection', 'link', 'image'],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'tts-read-from-here' && tab?.id) {
    chrome.tabs.sendMessage(tab.id, { type: 'readFromHere' }).catch(() => {});
  }
});

// --- Kokoro TTS proxy ---

// isLocalhostURL loaded from lib/config.js

let _kokoroController = null;

async function handleKokoroTTS(msg) {
  const endpoint = (msg.endpoint || 'http://localhost:8880').replace(/\/+$/, '');

  if (!isLocalhostURL(endpoint)) {
    return { error: 'Endpoint must be a localhost address' };
  }

  // Sentences are typically <500 chars; cap to guard against a misbehaving
  // content script or malicious page flooding the Kokoro server.
  if (typeof msg.text !== 'string' || msg.text.length > 50_000) {
    return { error: 'Request payload too large or invalid.' };
  }

  // Abort any in-flight request so rapid skips don't queue on the GPU.
  // abort() on a completed controller is a no-op, so this is always safe.
  if (_kokoroController) _kokoroController.abort();
  const controller = _kokoroController = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    const response = await fetch(`${endpoint}/dev/captioned_speech`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'kokoro',
        voice: msg.voice || SETTINGS_DEFAULTS.kokoroVoice,
        input: msg.text,
        speed: msg.speed || 1.0,
        response_format: 'mp3',
        stream: false,
        return_timestamps: true,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      return { error: `HTTP ${response.status}: ${response.statusText}` };
    }

    // JSON with base64 audio + timestamps - fully sendResponse-serializable
    return await response.json();
  } catch (err) {
    return { error: err.name === 'AbortError' ? 'Request aborted' : err.message };
  }
}

// --- Kokoro-js offscreen document ---

const OFFSCREEN_PATH = 'offscreen/offscreen.html';

// createDocument() rejects if a document already exists or if another call is
// still in flight, and the worker can be evicted between calls - so we probe
// for the live document and single-flight the creation.
let _offscreenCreating = null;

async function ensureOffscreen() {
  const existing = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)],
  });
  if (existing.length > 0) return;

  if (!_offscreenCreating) {
    _offscreenCreating = chrome.offscreen.createDocument({
      url: OFFSCREEN_PATH,
      // WORKERS covers the ONNX Runtime session; AUDIO_PLAYBACK is not needed
      // because the content script does the playing.
      reasons: ['WORKERS'],
      justification: 'Runs the Kokoro-js text-to-speech model locally.',
    }).finally(() => { _offscreenCreating = null; });
  }
  await _offscreenCreating;
}

/**
 * Tear down the offscreen document, releasing the loaded model along with the
 * ONNX session and WebGPU device it holds. Reports whether anything was
 * actually running so the options page can say so.
 */
async function closeOffscreen() {
  const existing = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)],
  }).catch(() => []);

  if (existing.length === 0) return { unloaded: false };

  try {
    await chrome.offscreen.closeDocument();
    return { unloaded: true };
  } catch (err) {
    return { unloaded: false, error: err?.message || String(err) };
  }
}

/**
 * Wake the offscreen document if needed and forward a request to it.
 * `target` namespaces the message so this worker's own listener ignores it.
 */
async function relayToOffscreen(msg) {
  try {
    await ensureOffscreen();
    return await chrome.runtime.sendMessage({ ...msg, target: 'offscreen-kokorojs' });
  } catch (err) {
    return { error: err?.message || String(err) };
  }
}

// --- Message listener ---

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return;
  // Offscreen traffic is relayed by relayToOffscreen and handled there.
  if (msg.target === 'offscreen-kokorojs') return;

  if (msg.type === 'kokoroTTS') {
    handleKokoroTTS(msg).then(sendResponse);
    return true; // keep channel open for async response
  }

  if (msg.type === 'kokoroJsTTS') {
    // Synthesis time scales with input length and blocks the single ONNX
    // session, so cap what a misbehaving content script can submit.
    if (typeof msg.text !== 'string' || msg.text.length > 5_000) {
      sendResponse({ error: 'Request payload too large or invalid.' });
      return false;
    }
    relayToOffscreen({
      type: 'kokoroJsSynth',
      text: msg.text,
      voice: msg.voice,
      speed: msg.speed,
      device: msg.device,
      idleUnloadMinutes: msg.idleUnloadMinutes,
    }).then(sendResponse);
    return true;
  }

  // Immediate unload: closing the document drops the ONNX session and the
  // WebGPU device with it, which is what actually frees the memory.
  if (msg.type === 'kokoroJsUnload') {
    closeOffscreen().then(sendResponse);
    return true;
  }

  if (msg.type === 'kokoroJsStatus') {
    relayToOffscreen({ type: msg.type, device: msg.device }).then(sendResponse);
    return true;
  }
});
