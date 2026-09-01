/**
 * Popup Script - controls the TTS popup UI and communicates with the content script.
 */

(function () {
  'use strict';

  // --- DOM references ---
  const els = {
    mode: document.getElementById('mode'),
    btnPlay: document.getElementById('btn-play'),
    btnPause: document.getElementById('btn-pause'),
    btnStop: document.getElementById('btn-stop'),
    btnPrev: document.getElementById('btn-prev'),
    btnNext: document.getElementById('btn-next'),
    voice: document.getElementById('voice'),
    voiceGroup: document.getElementById('voice-group'),
    showAllLanguages: document.getElementById('show-all-languages'),
    noVoicesNote: document.getElementById('voice-no-voices-note'),
    limitedNote: document.getElementById('voice-limited-note'),
    kokoroInfo: document.getElementById('kokoro-info'),
    kokoroLabel: document.getElementById('kokoro-label'),
    kokoroVoiceLabel: document.getElementById('kokoro-voice-label'),
    rate: document.getElementById('rate'),
    rateValue: document.getElementById('rate-value'),
    volume: document.getElementById('volume'),
    volumeValue: document.getElementById('volume-value'),
    autoScroll: document.getElementById('auto-scroll'),
    status: document.getElementById('status'),
    progressContainer: document.getElementById('progress-container'),
    progressBar: document.getElementById('progress-bar'),
    progressText: document.getElementById('progress-text'),
    readingInfo: document.getElementById('reading-info'),
    openOptions: document.getElementById('open-options'),
  };

  // --- Helpers ---

  async function sendToTab(msg, silent) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return null;
    try {
      return await chrome.tabs.sendMessage(tab.id, msg);
    } catch {
      if (!silent) showError('Cannot connect to this page. Try refreshing.');
      return null;
    }
  }

  function showError(message) {
    els.status.textContent = message;
    els.status.classList.add('status-error');
  }

  let currentState = 'stopped';
  let _voicesCache = [];

  function updatePlayPauseButtons(state) {
    currentState = state;
    const hasError = els.status.classList.contains('status-error');
    if (state === 'playing') {
      els.status.classList.remove('status-error');
      els.btnPlay.hidden = true;
      els.btnPause.hidden = false;
      els.status.textContent = 'Playing...';
    } else if (state === 'paused') {
      els.status.classList.remove('status-error');
      els.btnPlay.hidden = false;
      els.btnPause.hidden = true;
      els.btnPlay.querySelector('span').textContent = 'Resume';
      els.btnPlay.setAttribute('aria-label', 'Resume playback');
      els.status.textContent = 'Paused';
    } else {
      els.btnPlay.hidden = false;
      els.btnPause.hidden = true;
      els.btnPlay.querySelector('span').textContent = 'Read';
      els.btnPlay.setAttribute('aria-label', 'Read aloud');
      if (!hasError) els.status.textContent = 'Ready';
      els.progressContainer.hidden = true;
      els.progressText.hidden = true;
      els.readingInfo.hidden = true;
    }
  }

  function formatDuration(seconds) {
    if (seconds < 60) return seconds + 's';
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return s > 0 ? m + 'm ' + s + 's' : m + 'm';
  }

  function updateProgress(sentenceIndex, totalSentences, wordCount, wordsRead, estimatedSeconds) {
    if (totalSentences <= 0) return;
    // Word-based progress - accurate even with mixed long paragraphs and short bullets
    const pct = wordCount > 0 ? (wordsRead / wordCount) * 100 : 0;
    els.progressContainer.hidden = false;
    els.progressText.hidden = false;
    els.progressBar.style.width = pct + '%';
    els.progressText.textContent = (sentenceIndex + 1) + ' / ' + totalSentences;
    if (wordCount > 0 && estimatedSeconds > 0) {
      const remaining = Math.round(estimatedSeconds * (1 - pct / 100));
      els.readingInfo.hidden = false;
      els.readingInfo.textContent = '~' + formatDuration(remaining) + ' left';
    }
  }

  // formatKokoroVoice, SETTINGS_DEFAULTS loaded from lib/config.js

  // --- Load saved settings ---

  function updateBackendUI(backend, settings) {
    const isKokoro = isKokoroBackend(backend);
    const isKokoroJs = backend === 'kokorojs';
    els.voiceGroup.hidden = isKokoro;
    els.kokoroInfo.hidden = !isKokoro;
    if (!isKokoro) return;

    els.kokoroLabel.textContent = isKokoroJs ? 'Kokoro-js' : 'Kokoro';
    const voice = isKokoroJs ? settings.kokoroJsVoice : settings.kokoroVoice;
    if (voice) {
      els.kokoroVoiceLabel.textContent = formatKokoroVoice(voice);
    }
  }

  async function loadSettings() {
    return new Promise((resolve) => {
      chrome.storage.local.get(SETTINGS_DEFAULTS, (settings) => {
        els.mode.value = settings.mode;
        els.rate.value = settings.rate;
        els.rateValue.textContent = settings.rate.toFixed(1) + 'x';
        els.volume.value = settings.volume;
        els.volumeValue.textContent = Math.round(settings.volume * 100) + '%';
        els.autoScroll.checked = settings.autoScroll;
        els.showAllLanguages.setAttribute('aria-pressed', String(!!settings.showAllLanguages));
        updateBackendUI(settings.ttsBackend, settings);
        resolve(settings);
      });
    });
  }

  function saveSettings(partial) {
    safeSave(partial);
    sendToTab({ type: 'updateSettings', settings: partial });
  }

  // --- Load voices ---

  async function loadVoices() {
    const result = await sendToTab({ type: 'getVoices' });
    if (!result || !result.voices || result.voices.length === 0) {
      els.voice.replaceChildren();
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'No voices available';
      els.voice.appendChild(opt);
      return;
    }

    const settings = await new Promise(r =>
      chrome.storage.local.get({ voiceURI: null, showAllLanguages: false }, r)
    );

    // Truly empty (no TTS at all) is rare - kept as a defensive alert.
    els.noVoicesNote.hidden = result.voices.length > 0;

    // Limited voices stay selectable but suppress word-by-word marking.
    // Show the warning when the active selection is one of them.
    _voicesCache = result.voices;
    const selected = result.voices.find(v => v.voiceURI === settings.voiceURI);
    els.limitedNote.hidden = !(selected && isLimitedVoice(selected));

    const visible = filterVoicesForDropdown(
      result.voices, settings.voiceURI, settings.showAllLanguages
    );

    const groups = {};
    for (const v of visible) {
      if (!groups[v.lang]) groups[v.lang] = [];
      groups[v.lang].push(v);
    }

    els.voice.replaceChildren();
    for (const lang of Object.keys(groups).sort()) {
      const optgroup = document.createElement('optgroup');
      optgroup.label = lang;
      for (const v of groups[lang]) {
        const option = document.createElement('option');
        option.value = v.voiceURI;
        option.textContent = v.name;
        optgroup.appendChild(option);
      }
      els.voice.appendChild(optgroup);
    }

    if (settings.voiceURI) els.voice.value = settings.voiceURI;
  }

  // --- Sync current state from content script ---

  async function syncState() {
    const result = await sendToTab({ type: 'getState' }, true);
    if (result) {
      updatePlayPauseButtons(result.state);
      if (result.state !== 'stopped' && result.totalSentences > 0) {
        updateProgress(result.sentenceIndex, result.totalSentences, result.wordCount, result.wordsRead, result.estimatedSeconds);
      }
      els.kokoroInfo.classList.toggle('csp-fallback', !!result.cspFallback);
    }
  }

  // --- Event listeners ---

  els.btnPlay.addEventListener('click', () => {
    if (currentState === 'paused') {
      sendToTab({ type: 'togglePlayPause' });
    } else {
      sendToTab({ type: 'play', mode: els.mode.value });
    }
    updatePlayPauseButtons('playing');
  });

  els.btnPause.addEventListener('click', () => {
    sendToTab({ type: 'pause' });
    updatePlayPauseButtons('paused');
  });

  els.btnStop.addEventListener('click', () => {
    sendToTab({ type: 'stop' });
    updatePlayPauseButtons('stopped');
  });

  els.btnPrev.addEventListener('click', () => {
    sendToTab({ type: 'skipPrev' });
  });

  els.btnNext.addEventListener('click', () => {
    sendToTab({ type: 'skipNext' });
  });

  els.mode.addEventListener('change', () => {
    saveSettings({ mode: els.mode.value });
    sendToTab({ type: 'stop' });
    updatePlayPauseButtons('stopped');
  });

  els.voice.addEventListener('change', () => {
    saveSettings({ voiceURI: els.voice.value });
    const v = _voicesCache.find(x => x.voiceURI === els.voice.value);
    els.limitedNote.hidden = !(v && isLimitedVoice(v));
  });

  els.showAllLanguages.addEventListener('click', () => {
    const next = els.showAllLanguages.getAttribute('aria-pressed') !== 'true';
    els.showAllLanguages.setAttribute('aria-pressed', String(next));
    saveSettings({ showAllLanguages: next });
    loadVoices();
  });

  let rateDebounce;
  els.rate.addEventListener('input', () => {
    const rate = Math.max(0.5, Math.min(3.0, parseFloat(els.rate.value)));
    els.rateValue.textContent = rate.toFixed(1) + 'x';
    clearTimeout(rateDebounce);
    rateDebounce = setTimeout(() => saveSettings({ rate }), 100);
  });

  let volumeDebounce;
  els.volume.addEventListener('input', () => {
    const volume = Math.max(0, Math.min(1.0, parseFloat(els.volume.value)));
    els.volumeValue.textContent = Math.round(volume * 100) + '%';
    clearTimeout(volumeDebounce);
    volumeDebounce = setTimeout(() => saveSettings({ volume }), 100);
  });

  els.autoScroll.addEventListener('change', () => {
    saveSettings({ autoScroll: els.autoScroll.checked });
  });

  els.openOptions.addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  // Listen for state changes from content script
  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (sender.id !== chrome.runtime.id) return;
    if (msg.type === 'stateChanged') {
      updatePlayPauseButtons(msg.state);
    }
    if (msg.type === 'progress') {
      updateProgress(msg.sentenceIndex, msg.totalSentences, msg.wordCount, msg.wordsRead, msg.estimatedSeconds);
    }
    if (msg.type === 'settingChanged' && msg.key === 'rate') {
      els.rate.value = msg.value;
      els.rateValue.textContent = msg.value.toFixed(1) + 'x';
    }
    if (msg.type === 'error') {
      showError(msg.message);
    }
  });

  // --- Theme detection (class-based fallback for Brave) ---
  // Apply dark mode class based on system theme.
  function applyTheme() {
    const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.body.classList.toggle('dark', isDark);
  }
  applyTheme();
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

  // --- Initialize ---
  loadSettings().then((settings) => {
    if (!isKokoroBackend(settings.ttsBackend)) loadVoices();
    syncState();
    // Poll state while popup is open - ensures progress/info stay current
    // even if runtime messages are missed
    setInterval(syncState, 500);
  });
})();
