/**
 * Background Service Worker - handles theme-aware icon switching, context menu,
 * and Kokoro TTS API proxy.
 *
 * Kokoro fetches are routed through the service worker (not the content script)
 * to avoid Chrome's per-site permission prompts for cross-origin requests.
 * The /dev/captioned_speech response is JSON (base64 audio + timestamps),
 * so it passes through sendResponse without serialization issues.
 */

importScripts('lib/config.js');

// --- Theme-aware icon ---
//
// The icon follows the user's prefers-color-scheme. Content scripts and the
// popup both report the current theme via 'themeDetected' messages, and the
// last value is cached in chrome.storage.local so the icon survives service
// worker restarts and browser restarts without needing the 'scripting'
// permission to probe tabs.

// Tracks whether the icon has been set from a live signal during this service
// worker lifetime. Used to skip the storage-cache restore if a fresh
// 'themeDetected' message arrives before the async storage read resolves
// (otherwise the stale snapshot could clobber the live value).
let _iconSetThisLifetime = false;

function setIconTheme(isDark) {
  _iconSetThisLifetime = true;
  const suffix = isDark ? 'light' : 'dark';
  chrome.action.setIcon({
    path: {
      16: `icons/icon-16-${suffix}.png`,
      48: `icons/icon-48-${suffix}.png`,
      128: `icons/icon-128-${suffix}.png`,
    }
  });
}

// Restore the last-known theme on service worker cold start. Falls back to
// the manifest's default icon if the cache is empty (first install only).
chrome.storage.local.get('_iconTheme', (data) => {
  if (_iconSetThisLifetime) return; // a live message already set the icon
  if (typeof data?._iconTheme === 'boolean') setIconTheme(data._iconTheme);
});

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

    // JSON with base64 audio + timestamps — fully sendResponse-serializable
    return await response.json();
  } catch (err) {
    return { error: err.name === 'AbortError' ? 'Request aborted' : err.message };
  }
}

// --- Message listener ---

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return;

  if (msg.type === 'themeDetected' && typeof msg.isDark === 'boolean') {
    setIconTheme(msg.isDark);
    chrome.storage.local.set({ _iconTheme: msg.isDark });
  }

  if (msg.type === 'kokoroTTS') {
    handleKokoroTTS(msg).then(sendResponse);
    return true; // keep channel open for async response
  }
});
