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
  const highlighter = new Highlighter();

  let sentences = [];
  let _lastSelectionRange = null;

  // Safe message sender - silently ignores errors when popup/background is closed
  function sendMsg(msg) {
    try {
      chrome.runtime.sendMessage(msg).catch(() => {});
    } catch { /* extension context invalidated */ }
  }

  // SKIP_SELECTORS loaded from lib/config.js

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
    const wordCount = highlighter.wordSpans.length;
    const wordsPerMin = 150 * engine.settings.rate;
    const wordsRead = highlighter.sentenceMap[sentenceIndex]?.startWordIndex || 0;
    sendMsg({
      type: 'progress',
      sentenceIndex,
      totalSentences: sentences.length,
      wordCount,
      wordsRead,
      estimatedSeconds: wordCount > 0 ? Math.round((wordCount / wordsPerMin) * 60) : 0,
    });
  });

  engine.onStateChange = safeCall((state) => {
    sendMsg({ type: 'stateChanged', state });
  });

  engine.onEnd = safeCall(() => {
    highlighter.cleanup();
    sendMsg({ type: 'stateChanged', state: 'stopped' });
  });

  engine.onError = safeCall((message) => {
    sendMsg({ type: 'error', message });
  });

  // --- Load settings from storage ---

  function loadSettings() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(SETTINGS_DEFAULTS, (settings) => {
          engine.updateSettings({
            voiceURI: settings.voiceURI,
            rate: settings.rate,
            pitch: settings.pitch,
            volume: settings.volume,
            ttsBackend: settings.ttsBackend,
            kokoroEndpoint: settings.kokoroEndpoint,
            kokoroVoice: settings.kokoroVoice,
          });
          highlighter.updateSettings({
            highlightBg: settings.highlightBg,
            highlightFg: settings.highlightFg,
            neonHighlight: settings.neonHighlight,
            autoScroll: settings.autoScroll,
          });
          resolve(settings);
        });
      } catch { resolve(SETTINGS_DEFAULTS); }
    });
  }

  function buildSkipSelectors(settings) {
    const selectors = [...SKIP_SELECTORS];
    if (settings.skipCodeBlocks) {
      // Skip <pre> blocks and <code> elements that contain .line spans (real code blocks).
      // Inline <code>word</code> without .line children is kept so terms like
      // "tools" still get read.
      selectors.push('pre', 'code:has(span.line)');
    }
    if (settings.skipAltText) selectors.push('figcaption');
    if (settings.skipLinks) selectors.push('a[href]');
    return selectors;
  }

  // --- Core playback (used by ALL modes) ---

  /**
   * @param {Element} container - DOM element whose words to wrap
   * @param {Object}  settings  - user settings
   * @param {Range}   [range]   - if provided, only read words within this Range (selection mode)
   */
  function startPlayback(container, settings, range) {
    // Cancel element picker if active — prevents stale click listener
    if (_activePickerCleanup) _activePickerCleanup();

    const skipSelectors = buildSkipSelectors(settings);

    // Wrap words - if range is provided, only spans from text nodes
    // intersecting the range are kept (selection mode filtering at DOM level)
    // Backward compat: convert old boolean focusMode to string
    const fm = settings.focusMode === true ? 'sentence' : (settings.focusMode || 'off');
    highlighter.focusMode = fm;
    highlighter.prepare(container, skipSelectors, range);

    // Build sentences directly from spans - word counts are guaranteed to match
    sentences = highlighter.getSentences({ punctuationPauses: settings.punctuationPauses });
    if (sentences.length === 0 && !range) {
      // Fullpage mode: retry without skip selectors, then with document.body
      highlighter.cleanup();
      highlighter.focusMode = fm;
      highlighter.prepare(container, [], null);
      sentences = highlighter.getSentences({ punctuationPauses: settings.punctuationPauses });
      if (sentences.length === 0 && container !== document.body) {
        highlighter.cleanup();
        highlighter.focusMode = fm;
        highlighter.prepare(document.body, skipSelectors, null);
        sentences = highlighter.getSentences({ punctuationPauses: settings.punctuationPauses });
      }
    }
    if (sentences.length === 0) {
      highlighter.cleanup();
      sendMsg({ type: 'stateChanged', state: 'stopped' });
      sendMsg({ type: 'error', message: 'No readable text found.' });
      return;
    }

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
      // Use saved selection if the live one was lost (e.g. popup stole focus)
      const selection = window.getSelection();
      if ((!selection || selection.isCollapsed) && _lastSelectionRange) {
        selectionRange = _lastSelectionRange;
      } else if (selection && !selection.isCollapsed) {
        selectionRange = selection.getRangeAt(0);
        _lastSelectionRange = selectionRange.cloneRange();
      } else {
        sendMsg({ type: 'error', message: 'No text selected. Select some text first.' });
        return;
      }
      // Use commonAncestor as container — guarantees it contains the full selection
      const ancestor = selectionRange.commonAncestorContainer;
      container = ancestor.nodeType === Node.TEXT_NODE ? ancestor.parentElement : ancestor;
    } else {
      container = findMainContent();
    }

    if (!container) {
      sendMsg({ type: 'error', message: 'No readable text found on this page.' });
      return;
    }

    startPlayback(container, settings, selectionRange);
  }

  let _activePickerCleanup = null;

  function startElementPicker(settings, mode) {
    // Cancel any previous picker to prevent stacking click listeners
    if (_activePickerCleanup) _activePickerCleanup();

    document.body.style.cursor = 'crosshair';
    sendMsg({ type: 'stateChanged', state: 'picking' });

    const onClick = async (e) => {
      e.preventDefault();
      e.stopPropagation();
      document.removeEventListener('click', onClick, true);
      document.body.style.cursor = '';
      _activePickerCleanup = null;

      try {
        const s = settings || await loadSettings();

        const container = findContainerFor(e.target);
        if (!container) {
          sendMsg({ type: 'error', message: 'No readable text found on this page.' });
          return;
        }
        const range = document.createRange();
        if (container.contains(e.target)) {
          range.setStartBefore(e.target);
        } else {
          range.setStart(container, 0);
        }
        if (mode === 'readfromhere') {
          range.setEndAfter(container.lastChild || container);
        } else {
          if (container.contains(e.target)) {
            range.setEndAfter(e.target);
          } else {
            range.setEndAfter(container.lastChild || container);
          }
        }
        startPlayback(container, s, range);
      } catch (err) {
        sendMsg({ type: 'error', message: 'Failed to start reading.' });
      }
    };

    _activePickerCleanup = () => {
      document.removeEventListener('click', onClick, true);
      document.body.style.cursor = '';
      _activePickerCleanup = null;
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
        if (!lastRightClickInfo) break;
        (async () => {
          const s = await loadSettings();
          const startEl = resolveClickTarget(lastRightClickInfo);
          const container = findContainerFor(startEl);
          if (!container) {
            sendMsg({ type: 'error', message: 'No readable text found on this page.' });
            return;
          }
          const range = document.createRange();
          if (container.contains(startEl)) {
            range.setStartBefore(startEl);
          } else {
            range.setStart(container, 0);
          }
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
        engine.stop(); // onEnd callback handles highlighter.cleanup()
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
        const si = engine.getCurrentSentenceIndex();
        const wordsRead = highlighter.sentenceMap?.[si]?.startWordIndex || 0;
        sendResponse({
          state: engine.state,
          sentenceIndex: si,
          totalSentences: sentences.length,
          wordCount,
          wordsRead,
          estimatedSeconds: wordCount > 0 ? Math.round((wordCount / wordsPerMin) * 60) : 0,
          ttsBackend: engine.settings.ttsBackend || 'browser',
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
          const has = (k) => msg.settings[k] !== undefined;
          if (has('voiceURI') || has('rate') || has('pitch') || has('volume') ||
              has('ttsBackend') || has('kokoroEndpoint') || has('kokoroVoice')) {
            engine.updateSettings(msg.settings);
          }
          if (has('highlightBg') || has('highlightFg') ||
              has('neonHighlight') || has('autoScroll')) {
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
      e.stopPropagation();
      if (engine.state === 'stopped') startReading();
      else engine.togglePlayPause();
      return;
    }

    // Alt+R - Full Page Read
    if (!e.shiftKey && e.code === 'KeyR') {
      e.preventDefault();
      e.stopPropagation();
      engine.stop();
      startReading('fullpage');
      return;
    }

    // Alt+S - Stop
    if (!e.shiftKey && e.code === 'KeyS') {
      e.preventDefault();
      e.stopPropagation();
      engine.stop();
      return;
    }

    // Alt+Shift+Arrow combos
    if (!e.shiftKey) return;

    switch (e.code) {
      case 'ArrowRight':
        e.preventDefault();
        e.stopPropagation();
        engine.skipNext();
        break;

      case 'ArrowLeft':
        e.preventDefault();
        e.stopPropagation();
        engine.skipPrev();
        break;

      case 'ArrowUp': {
        e.preventDefault();
        e.stopPropagation();
        const up = Math.round(Math.min(3.0, engine.settings.rate + 0.1) * 10) / 10;
        engine.updateSettings({ rate: up });
        safeSave({ rate: up });
        sendMsg({ type: 'settingChanged', key: 'rate', value: up });
        break;
      }

      case 'ArrowDown': {
        e.preventDefault();
        e.stopPropagation();
        const down = Math.round(Math.max(0.5, engine.settings.rate - 0.1) * 10) / 10;
        engine.updateSettings({ rate: down });
        safeSave({ rate: down });
        sendMsg({ type: 'settingChanged', key: 'rate', value: down });
        break;
      }
    }
  });

  // --- Context menu: "Read from here" ---

  let lastRightClickInfo = null;
  document.addEventListener('contextmenu', (e) => {
    lastRightClickInfo = {
      target: e.target,
      clientX: e.clientX,
      clientY: e.clientY,
    };
  });

  /**
   * Resolve a right-click to the nearest text-bearing element.
   * Uses caret APIs to pinpoint the exact text node under the cursor,
   * falling back to the raw event target.
   */
  function resolveClickTarget(info) {
    let textNode = null;
    if (document.caretPositionFromPoint) {
      const pos = document.caretPositionFromPoint(info.clientX, info.clientY);
      if (pos?.offsetNode?.nodeType === Node.TEXT_NODE && pos.offsetNode.textContent.trim()) {
        textNode = pos.offsetNode;
      }
    }
    if (!textNode && document.caretRangeAtPoint) {
      const range = document.caretRangeAtPoint(info.clientX, info.clientY);
      if (range?.startContainer?.nodeType === Node.TEXT_NODE && range.startContainer.textContent.trim()) {
        textNode = range.startContainer;
      }
    }
    return textNode ? (textNode.parentElement || info.target) : info.target;
  }

  // --- Theme-aware icon ---

  const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
  function sendTheme() {
    sendMsg({ type: 'themeDetected', isDark: darkQuery.matches });
  }
  sendTheme();
  darkQuery.addEventListener('change', sendTheme);

  // --- Cleanup on page unload ---

  window.addEventListener('beforeunload', () => {
    try { engine.stop(); highlighter.cleanup(); } catch {}
  });
})();
