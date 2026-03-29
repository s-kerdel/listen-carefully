/**
 * Content Script - orchestrates TTS playback, text extraction, and highlighting.
 * Runs in the page context where speechSynthesis is available.
 *
 * Key design: the Highlighter is the single source of truth for the word list.
 * Sentences are built from the actual wrapped spans (getSentences()), so the
 * sentence word count is always identical to the span count. Highlighting maps
 * by index, never by text matching, so pauses/punctuation cannot cause drift.
 */

(function () {
  'use strict';

  if (window.__listenCarefullyInitialized) return;
  window.__listenCarefullyInitialized = true;

  const engine = new TTSEngine();
  const extractor = new TextExtractor();
  const highlighter = new Highlighter();

  let sentences = [];

  // Safe message sender - silently ignores errors when popup/background is closed
  function sendMsg(msg) {
    try {
      chrome.runtime.sendMessage(msg).catch(() => {});
    } catch { /* extension context invalidated */ }
  }

  // Elements to skip when wrapping words
  const BASE_SKIP_SELECTORS = [
    'nav', 'header', 'footer', 'aside',
    '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]',
    '[role="complementary"]', '.sidebar', '.nav', '.menu',
    '.advertisement', '.ad', '.ads', '.social-share',
    '.comments', '.comment-section', '#comments',
    'script', 'style', 'noscript', 'svg', 'canvas',
    'iframe', 'form', 'button', 'input', 'select', 'textarea',
    '.sr-only', '.visually-hidden', '.screen-reader-text',
    '[aria-hidden="true"]',
  ];

  // --- Wire up TTS engine callbacks ---
  // All callbacks are guarded: after extension reload the context is invalidated
  // but the TTS engine (speechSynthesis) keeps firing events on the old page.

  function safeCall(fn) {
    return (...args) => { try { fn(...args); } catch {} };
  }

  engine.onBoundary = safeCall((charIndex, charLength, sentenceIndex) => {
    highlighter.highlightWord(charIndex, charLength, sentenceIndex);
  });

  engine.onSentenceStart = safeCall((sentenceIndex) => {
    highlighter.highlightWord(0, 0, sentenceIndex);
    sendMsg({
      type: 'progress',
      sentenceIndex,
      totalSentences: sentences.length,
    });
  });

  engine.onStateChange = safeCall((state) => {
    sendMsg({ type: 'stateChanged', state });
  });

  engine.onEnd = safeCall(() => {
    highlighter.cleanup();
    sendMsg({ type: 'stateChanged', state: 'stopped' });
  });

  // --- Load settings from storage ---

  function loadSettings() {
    return new Promise((resolve) => {
      chrome.storage.local.get({
        voiceURI: null,
        rate: 1.0,
        pitch: 1.0,
        volume: 1.0,
        highlightBg: '#FFEB3B',
        highlightFg: '#000000',
        mode: 'fullpage',
        skipCodeBlocks: true,
        skipAltText: false,
        skipLinks: false,
        neonHighlight: true,
        punctuationPauses: true,
        focusMode: 'off',
        autoScroll: true,
      }, (settings) => {
        engine.updateSettings({
          voiceURI: settings.voiceURI,
          rate: settings.rate,
          pitch: settings.pitch,
          volume: settings.volume,
        });
        highlighter.updateSettings({
          highlightBg: settings.highlightBg,
          highlightFg: settings.highlightFg,
          neonHighlight: settings.neonHighlight,
          autoScroll: settings.autoScroll,
        });
        resolve(settings);
      });
    });
  }

  function buildSkipSelectors(settings) {
    const selectors = [...BASE_SKIP_SELECTORS];
    if (settings.skipCodeBlocks) {
      // Skip <pre> blocks and <code> elements that contain .line spans (real code blocks).
      // Inline <code>word</code> without .line children is kept so terms like
      // "tools" still get read.
      selectors.push('pre', 'code:has(span.line)');
    }
    return selectors;
  }

  // --- Core playback (used by ALL modes) ---

  /**
   * @param {Element} container - DOM element whose words to wrap
   * @param {Object}  settings  - user settings
   * @param {Range}   [range]   - if provided, only read words within this Range (selection mode)
   */
  function startPlayback(container, settings, range) {
    const skipSelectors = buildSkipSelectors(settings);

    // Wrap words - if range is provided, only spans from text nodes
    // intersecting the range are kept (selection mode filtering at DOM level)
    // Backward compat: convert old boolean focusMode to string
    const fm = settings.focusMode === true ? 'sentence' : (settings.focusMode || 'off');
    highlighter.focusMode = fm;
    highlighter.prepare(container, skipSelectors, range);

    // Build sentences directly from spans - word counts are guaranteed to match
    sentences = highlighter.getSentences({ punctuationPauses: settings.punctuationPauses });
    if (sentences.length === 0) {
      highlighter.cleanup();
      sendMsg({ type: 'error', message: 'No readable text found.' });
      return;
    }

    // Send estimated reading time to popup
    const wordCount = highlighter.wordSpans.length;
    // Average TTS rate: ~150 words/min at 1.0x speed
    const wordsPerMin = 150 * engine.settings.rate;
    const estimatedSeconds = Math.round((wordCount / wordsPerMin) * 60);
    sendMsg({
      type: 'readingInfo',
      wordCount,
      estimatedSeconds,
      totalSentences: sentences.length,
    });

    engine.play(sentences);
  }

  // --- Reading modes ---

  async function startReading(mode) {
    const settings = await loadSettings();
    mode = mode || settings.mode;

    if (mode === 'element' || mode === 'readfromhere') {
      startElementPicker(settings, mode);
      return;
    }

    let container;
    let selectionRange = null;

    if (mode === 'selection') {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) {
        sendMsg({ type: 'error', message: 'No text selected. Select some text first.' });
        return;
      }
      selectionRange = selection.getRangeAt(0);
      const ancestor = selectionRange.commonAncestorContainer;
      const selectionEl = ancestor.nodeType === Node.TEXT_NODE ? ancestor.parentElement : ancestor;
      container = selectionEl.closest('article, main, section, [role="main"]')
        || extractor.findMainContent()
        || selectionEl;
    } else {
      container = extractor.findMainContent();
    }

    if (!container) {
      sendMsg({ type: 'error', message: 'No readable text found on this page.' });
      return;
    }

    startPlayback(container, settings, selectionRange);
  }

  function startElementPicker(settings, mode) {
    document.body.style.cursor = 'crosshair';
    sendMsg({ type: 'stateChanged', state: 'picking' });

    const onClick = async (e) => {
      e.preventDefault();
      e.stopPropagation();
      document.removeEventListener('click', onClick, true);
      document.body.style.cursor = '';

      try {
        const s = settings || await loadSettings();

        const container = e.target.closest('article, main, section, [role="main"]')
          || extractor.findMainContent();
        if (!container) {
          sendMsg({ type: 'error', message: 'No readable text found on this page.' });
          return;
        }
        const range = document.createRange();
        range.setStartBefore(e.target);
        if (mode === 'readfromhere') {
          range.setEndAfter(container.lastChild || container);
        } else {
          range.setEndAfter(e.target);
        }
        startPlayback(container, s, range);
      } catch (err) {
        sendMsg({ type: 'error', message: 'Failed to start reading.' });
      }
    };

    document.addEventListener('click', onClick, true);
  }

  // --- Message handler ---

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return;
    switch (msg.type) {
      case 'play':
        startReading(msg.mode);
        break;

      case 'readFromHere': {
        if (!lastRightClickedEl) break;
        (async () => {
          const s = await loadSettings();
          const container = lastRightClickedEl.closest('article, main, section, [role="main"]')
            || extractor.findMainContent();
          if (!container) {
            sendMsg({ type: 'error', message: 'No readable text found on this page.' });
            return;
          }
          const range = document.createRange();
          range.setStartBefore(lastRightClickedEl);
          range.setEndAfter(container.lastChild || container);
          startPlayback(container, s, range);
        })();
        break;
      }

      case 'togglePlayPause':
        if (engine.state === 'stopped') {
          startReading(msg.mode);
        } else {
          engine.togglePlayPause();
        }
        break;

      case 'pause':
        engine.pause();
        break;

      case 'stop':
        engine.stop();
        highlighter.cleanup();
        break;

      case 'skipNext':
        engine.skipNext();
        break;

      case 'skipPrev':
        engine.skipPrev();
        break;

      case 'getState': {
        const wordCount = highlighter.wordSpans ? highlighter.wordSpans.length : 0;
        const wordsPerMin = 150 * engine.settings.rate;
        sendResponse({
          state: engine.state,
          sentenceIndex: engine.getCurrentSentenceIndex(),
          totalSentences: sentences.length,
          wordCount,
          estimatedSeconds: wordCount > 0 ? Math.round((wordCount / wordsPerMin) * 60) : 0,
        });
        return true;
      }

      case 'getVoices':
        const voices = engine.getVoices();
        if (voices.length > 0) {
          sendResponse({ voices: voices.map(v => ({ name: v.name, voiceURI: v.voiceURI, lang: v.lang })) });
        } else {
          setTimeout(() => {
            const retry = engine.getVoices();
            sendResponse({ voices: retry.map(v => ({ name: v.name, voiceURI: v.voiceURI, lang: v.lang })) });
          }, 300);
        }
        return true;

      case 'updateSettings':
        if (msg.settings) {
          if (msg.settings.voiceURI || msg.settings.rate || msg.settings.pitch || msg.settings.volume !== undefined) {
            engine.updateSettings(msg.settings);
          }
          if (msg.settings.highlightBg || msg.settings.highlightFg) {
            highlighter.updateSettings(msg.settings);
          }
        }
        break;
    }
  });

  // --- Keyboard shortcuts ---
  // Alt+R for full-page read, Alt+P / Alt+S for play-pause / stop
  // Alt+Shift+Arrows for navigation and speed

  document.addEventListener('keydown', (e) => {
    if (!e.altKey) return;

    // Alt+P - Play / Pause
    if (!e.shiftKey && e.code === 'KeyP') {
      e.preventDefault();
      if (engine.state === 'stopped') startReading();
      else engine.togglePlayPause();
      return;
    }

    // Alt+R - Full Page Read
    if (!e.shiftKey && e.code === 'KeyR') {
      e.preventDefault();
      engine.stop();
      highlighter.cleanup();
      startReading('fullpage');
      return;
    }

    // Alt+S - Stop
    if (!e.shiftKey && e.code === 'KeyS') {
      e.preventDefault();
      engine.stop();
      highlighter.cleanup();
      return;
    }

    // Alt+Shift+Arrow combos
    if (!e.shiftKey) return;

    switch (e.code) {
      case 'ArrowRight':
        e.preventDefault();
        engine.skipNext();
        break;

      case 'ArrowLeft':
        e.preventDefault();
        engine.skipPrev();
        break;

      case 'ArrowUp': {
        e.preventDefault();
        const up = Math.round(Math.min(3.0, engine.settings.rate + 0.1) * 10) / 10;
        engine.updateSettings({ rate: up });
        chrome.storage.local.set({ rate: up });
        sendMsg({ type: 'settingChanged', key: 'rate', value: up });
        break;
      }

      case 'ArrowDown': {
        e.preventDefault();
        const down = Math.round(Math.max(0.5, engine.settings.rate - 0.1) * 10) / 10;
        engine.updateSettings({ rate: down });
        chrome.storage.local.set({ rate: down });
        sendMsg({ type: 'settingChanged', key: 'rate', value: down });
        break;
      }
    }
  });

  // --- Context menu: "Read from here" ---

  let lastRightClickedEl = null;
  document.addEventListener('contextmenu', (e) => {
    lastRightClickedEl = e.target;
  });

  // --- Theme-aware icon ---

  const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
  function sendTheme() {
    sendMsg({ type: 'themeDetected', isDark: darkQuery.matches });
  }
  sendTheme();
  darkQuery.addEventListener('change', sendTheme);

  // --- Cleanup on page unload ---

  window.addEventListener('beforeunload', () => {
    engine.stop();
    highlighter.cleanup();
  });
})();
