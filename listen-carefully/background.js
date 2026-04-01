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

function setIconTheme(isDark) {
  const suffix = isDark ? 'light' : 'dark';
  chrome.action.setIcon({
    path: {
      16: `icons/icon-16-${suffix}.png`,
      48: `icons/icon-48-${suffix}.png`,
      128: `icons/icon-128-${suffix}.png`,
    }
  });
}

// Probe the active tab's theme on startup so the icon is correct
// before any content script sends a themeDetected message.
async function probeTheme() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || tab.url?.startsWith('chrome://')) return;
    const [result] = await Promise.race([
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => window.matchMedia('(prefers-color-scheme: dark)').matches,
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
    ]);
    if (result?.result !== undefined) setIconTheme(result.result);
  } catch { /* tab not scriptable or timed out - keep default icon */ }
}
probeTheme();

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

async function handleKokoroTTS(msg) {
  const endpoint = (msg.endpoint || 'http://localhost:8880').replace(/\/+$/, '');

  if (!isLocalhostURL(endpoint)) {
    return { error: 'Endpoint must be a localhost address' };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

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
    return { error: err.name === 'AbortError' ? 'Request timed out' : err.message };
  }
}

// --- Message listener ---

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return;

  if (msg.type === 'themeDetected') {
    setIconTheme(msg.isDark);
  }

  if (msg.type === 'kokoroTTS') {
    handleKokoroTTS(msg).then(sendResponse);
    return true; // keep channel open for async response
  }
});
