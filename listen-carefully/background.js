/**
 * Background Service Worker - handles theme-aware icon switching and context menu.
 */

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
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => window.matchMedia('(prefers-color-scheme: dark)').matches,
    });
    if (result?.result !== undefined) setIconTheme(result.result);
  } catch { /* tab not scriptable - keep default (dark) icon */ }
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

// --- Message listener ---

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (sender.id !== chrome.runtime.id) return;
  if (msg.type === 'themeDetected') {
    setIconTheme(msg.isDark);
  }
});
