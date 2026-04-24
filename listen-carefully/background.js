/**
 * Background Service Worker - handles context menu and Kokoro TTS API proxy.
 *
 * Kokoro fetches are routed through the service worker (not the content script)
 * to avoid Chrome's per-site permission prompts for cross-origin requests.
 * The /dev/captioned_speech response is JSON (base64 audio + timestamps),
 * so it passes through sendResponse without serialization issues.
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
        voice: msg.voice || 'af_alloy',
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

// --- Message listener ---

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return;

  if (msg.type === 'kokoroTTS') {
    handleKokoroTTS(msg).then(sendResponse);
    return true; // keep channel open for async response
  }
});
