/**
 * Options Page Script - full settings panel with voice preview and Kokoro TTS configuration.
 */

(function () {
  'use strict';

  // Theme detection (class-based for Brave compatibility)
  function applyTheme() {
    document.body.classList.toggle('dark',
      window.matchMedia('(prefers-color-scheme: dark)').matches);
  }
  applyTheme();
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

  const els = {
    ttsBackend: document.getElementById('tts-backend'),
    kokoroSettings: document.getElementById('kokoro-settings'),
    kokoroEndpoint: document.getElementById('kokoro-endpoint'),
    kokoroVoice: document.getElementById('kokoro-voice'),
    btnTestKokoro: document.getElementById('btn-test-kokoro'),
    kokoroTestResult: document.getElementById('kokoro-test-result'),
    voiceSection: document.getElementById('voice-section'),
    voice: document.getElementById('voice'),
    btnPreview: document.getElementById('btn-preview'),
    rate: document.getElementById('rate'),
    rateValue: document.getElementById('rate-value'),
    volume: document.getElementById('volume'),
    volumeValue: document.getElementById('volume-value'),
    pitch: document.getElementById('pitch'),
    pitchValue: document.getElementById('pitch-value'),
    highlightBg: document.getElementById('highlight-bg'),
    highlightFg: document.getElementById('highlight-fg'),
    highlightPreview: document.getElementById('highlight-preview'),
    skipCode: document.getElementById('skip-code'),
    skipAlt: document.getElementById('skip-alt'),
    skipLinks: document.getElementById('skip-links'),
    punctuationPauses: document.getElementById('punctuation-pauses'),
    neonHighlight: document.getElementById('neon-highlight'),
    focusMode: document.getElementById('focus-mode'),
    autoScroll: document.getElementById('auto-scroll'),
    savedMsg: document.getElementById('saved-msg'),
  };

  // SETTINGS_DEFAULTS, KOKORO_LANGS, KOKORO_GENDERS, formatKokoroVoice
  // loaded from lib/config.js

  function validHex(str) {
    return /^#(?:[A-Fa-f0-9]{3}|[A-Fa-f0-9]{4}|[A-Fa-f0-9]{6}|[A-Fa-f0-9]{8})$/.test(str) ? str : null;
  }

  // --- Save with visual feedback ---

  let hideTimeout;
  function save(partial) {
    chrome.storage.local.set(partial);
    els.savedMsg.classList.add('visible');
    clearTimeout(hideTimeout);
    hideTimeout = setTimeout(() => els.savedMsg.classList.remove('visible'), 3000);
  }

  // --- Backend UI toggle ---

  function updateBackendUI(backend) {
    const isKokoro = backend === 'kokoro';
    els.kokoroSettings.hidden = !isKokoro;
    els.voiceSection.hidden = isKokoro;
    // Pitch is not supported by Kokoro
    const pitchGroup = els.pitch.closest('.slider-group');
    pitchGroup.style.opacity = isKokoro ? '0.4' : '';
    els.pitch.disabled = isKokoro;
    if (isKokoro) loadKokoroOptions();
  }

  // --- Load Kokoro voices and models from API ---

  /** Check if voice ID matches the known {lang}{gender}_{name} pattern. */
  function isKnownVoiceFormat(id) {
    return id.length >= 4 && id[2] === '_'
      && id[0] in KOKORO_LANGS && id[1] in KOKORO_GENDERS;
  }

  async function loadKokoroOptions() {
    const endpoint = els.kokoroEndpoint.value.replace(/\/+$/, '');
    if (!isLocalhostURL(endpoint)) return;

    const savedVoice = els.kokoroVoice.value;

    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 15000);
      const res = await fetch(`${endpoint}/v1/audio/voices`, { signal: ac.signal }).catch(() => null);
      clearTimeout(t);
      if (!res?.ok) return;

      const data = await res.json();
      const voices = Array.isArray(data.voices) ? data.voices.filter(v => typeof v === 'string') : [];
      if (voices.length === 0) return;

      // Group by language (merge male+female under same lang, like browser voices)
      const langGroups = {};
      const ungrouped = [];
      for (const v of voices) {
        if (isKnownVoiceFormat(v)) {
          const langKey = v[0];
          if (!langGroups[langKey]) langGroups[langKey] = [];
          langGroups[langKey].push(v);
        } else {
          ungrouped.push(v);
        }
      }

      els.kokoroVoice.replaceChildren();

      for (const langKey of Object.keys(langGroups).sort()) {
        const optgroup = document.createElement('optgroup');
        optgroup.label = KOKORO_LANGS[langKey] || langKey;
        for (const v of langGroups[langKey]) {
          const opt = document.createElement('option');
          opt.value = v;
          opt.textContent = formatKokoroVoice(v);
          optgroup.appendChild(opt);
        }
        els.kokoroVoice.appendChild(optgroup);
      }

      // Voices that don't match the pattern — show raw ID
      for (const v of ungrouped) {
        const opt = document.createElement('option');
        opt.value = v;
        opt.textContent = v;
        els.kokoroVoice.appendChild(opt);
      }

      els.kokoroVoice.value = voices.includes(savedVoice) ? savedVoice : voices[0];
    } catch { /* API unreachable — keep current dropdown values */ }
  }

  // --- Load voices (options page has direct access to speechSynthesis) ---

  function loadVoices() {
    const voices = speechSynthesis.getVoices();
    if (voices.length === 0) return;

    const groups = {};
    for (const v of voices) {
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

    // Restore saved
    chrome.storage.local.get({ voiceURI: null }, (s) => {
      if (s.voiceURI) els.voice.value = s.voiceURI;
    });
  }

  speechSynthesis.addEventListener('voiceschanged', loadVoices);
  loadVoices();

  // --- Load settings ---

  chrome.storage.local.get(SETTINGS_DEFAULTS, (s) => {
    els.ttsBackend.value = s.ttsBackend;
    els.kokoroEndpoint.value = s.kokoroEndpoint;
    els.kokoroVoice.value = s.kokoroVoice;
    updateBackendUI(s.ttsBackend);

    els.rate.value = s.rate;
    els.rateValue.textContent = s.rate.toFixed(1) + 'x';
    els.volume.value = s.volume;
    els.volumeValue.textContent = Math.round(s.volume * 100) + '%';
    els.pitch.value = s.pitch;
    els.pitchValue.textContent = s.pitch.toFixed(1);
    els.highlightBg.value = validHex(s.highlightBg) || SETTINGS_DEFAULTS.highlightBg;
    els.highlightFg.value = validHex(s.highlightFg) || SETTINGS_DEFAULTS.highlightFg;
    els.skipCode.checked = s.skipCodeBlocks;
    els.skipAlt.checked = s.skipAltText;
    els.skipLinks.checked = s.skipLinks;
    els.neonHighlight.checked = s.neonHighlight;
    els.punctuationPauses.checked = s.punctuationPauses;
    // Backward compat: convert old boolean focusMode to string
    const fm = s.focusMode === true ? 'sentence' : (s.focusMode || 'off');
    els.focusMode.value = fm;
    els.autoScroll.checked = s.autoScroll;
    updatePreview();
  });

  // --- Highlight preview ---

  function updatePreview() {
    const span = els.highlightPreview.querySelector('span');
    span.style.borderRadius = '3px';
    span.style.padding = '0 3px';
    const bg = validHex(els.highlightBg.value) || SETTINGS_DEFAULTS.highlightBg;
    const fg = validHex(els.highlightFg.value) || SETTINGS_DEFAULTS.highlightFg;
    span.style.backgroundColor = bg;
    span.style.color = fg;
    if (els.neonHighlight.checked) {
      span.style.boxShadow = `0 0 4px ${bg}80, 0 0 9px ${bg}80, 0 0 18px ${bg}80, 0 2px 8px rgba(0,0,0,0.3)`;
    } else {
      span.style.boxShadow = '';
    }
  }

  // --- Highlight presets ---

  document.querySelectorAll('.preset').forEach(btn => {
    btn.addEventListener('click', () => {
      const bg = validHex(btn.dataset.bg) || SETTINGS_DEFAULTS.highlightBg;
      const fg = validHex(btn.dataset.fg) || SETTINGS_DEFAULTS.highlightFg;
      els.highlightBg.value = bg;
      els.highlightFg.value = fg;
      updatePreview();
      save({ highlightBg: bg, highlightFg: fg });
    });
  });

  // --- Event listeners ---

  els.ttsBackend.addEventListener('change', async () => {
    const backend = els.ttsBackend.value;

    if (backend === 'kokoro') {
      // Request localhost permission on first Kokoro activation
      const granted = await chrome.permissions.request({
        origins: ['http://localhost/*', 'http://127.0.0.1/*'],
      }).catch(() => false);

      if (!granted) {
        els.ttsBackend.value = 'browser';
        return;
      }
    }

    stopAllPreviews();
    els.kokoroTestResult.hidden = true;
    updateBackendUI(backend);
    save({ ttsBackend: backend });
  });

  let kokoroDebounce;
  function saveKokoroSetting(key, el) {
    clearTimeout(kokoroDebounce);
    kokoroDebounce = setTimeout(() => save({ [key]: el.value }), 300);
  }
  let endpointRefreshDebounce;
  els.kokoroEndpoint.addEventListener('input', () => {
    if (isLocalhostURL(els.kokoroEndpoint.value)) {
      saveKokoroSetting('kokoroEndpoint', els.kokoroEndpoint);
      // Refresh voice dropdown from new endpoint
      clearTimeout(endpointRefreshDebounce);
      endpointRefreshDebounce = setTimeout(loadKokoroOptions, 500);
    }
  });
  els.kokoroVoice.addEventListener('change', () => saveKokoroSetting('kokoroVoice', els.kokoroVoice));

  function isLocalhostURL(urlStr) {
    try {
      const url = new URL(urlStr);
      return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    } catch {
      return false;
    }
  }

  els.btnTestKokoro.addEventListener('click', async () => {
    const endpoint = els.kokoroEndpoint.value.replace(/\/+$/, '');
    const voice = els.kokoroVoice.value || 'af_alloy';

    if (!isLocalhostURL(endpoint)) {
      els.kokoroTestResult.hidden = false;
      els.kokoroTestResult.textContent = 'Endpoint must be a localhost address (localhost, 127.0.0.1)';
      els.kokoroTestResult.className = 'test-result error';
      return;
    }

    els.kokoroTestResult.hidden = false;
    els.kokoroTestResult.textContent = 'Connecting...';
    els.kokoroTestResult.className = 'test-result testing';

    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 15000);
      const response = await fetch(`${endpoint}/v1/audio/speech`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'kokoro',
          voice,
          input: 'Kokoro TTS connection test successful.',
          speed: parseFloat(els.rate.value) || 1.0,
        }),
        signal: ac.signal,
      });
      clearTimeout(t);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      _testAudio = audio;
      audio.volume = parseFloat(els.volume.value) || 1.0;
      const revoke = () => { URL.revokeObjectURL(url); if (_testAudio === audio) _testAudio = null; };
      audio.onended = () => {
        revoke();
        els.kokoroTestResult.textContent = 'Connected successfully';
        setTimeout(() => { els.kokoroTestResult.hidden = true; }, 3000);
      };
      audio.onerror = revoke;
      audio.play().catch(revoke);

      els.kokoroTestResult.textContent = 'Connected — playing test audio...';
      els.kokoroTestResult.className = 'test-result success';
    } catch (err) {
      const msg = err.name === 'AbortError' ? 'Request timed out' : err.message;
      els.kokoroTestResult.textContent = 'Failed: ' + msg;
      els.kokoroTestResult.className = 'test-result error';
    }
  });

  els.voice.addEventListener('change', () => save({ voiceURI: els.voice.value }));

  let rateDebounce;
  els.rate.addEventListener('input', () => {
    const rate = parseFloat(els.rate.value);
    els.rateValue.textContent = rate.toFixed(1) + 'x';
    clearTimeout(rateDebounce);
    rateDebounce = setTimeout(() => save({ rate }), 100);
  });

  let volumeDebounce;
  els.volume.addEventListener('input', () => {
    const volume = parseFloat(els.volume.value);
    els.volumeValue.textContent = Math.round(volume * 100) + '%';
    clearTimeout(volumeDebounce);
    volumeDebounce = setTimeout(() => save({ volume }), 100);
  });

  let pitchDebounce;
  els.pitch.addEventListener('input', () => {
    const pitch = parseFloat(els.pitch.value);
    els.pitchValue.textContent = pitch.toFixed(1);
    clearTimeout(pitchDebounce);
    pitchDebounce = setTimeout(() => save({ pitch }), 100);
  });

  els.highlightBg.addEventListener('input', () => {
    const bg = validHex(els.highlightBg.value);
    if (bg) save({ highlightBg: bg });
    updatePreview();
  });

  els.highlightFg.addEventListener('input', () => {
    const fg = validHex(els.highlightFg.value);
    if (fg) save({ highlightFg: fg });
    updatePreview();
  });

  els.neonHighlight.addEventListener('change', () => {
    save({ neonHighlight: els.neonHighlight.checked });
    updatePreview();
  });
  els.skipCode.addEventListener('change', () => save({ skipCodeBlocks: els.skipCode.checked }));
  els.skipAlt.addEventListener('change', () => save({ skipAltText: els.skipAlt.checked }));
  els.skipLinks.addEventListener('change', () => save({ skipLinks: els.skipLinks.checked }));
  els.punctuationPauses.addEventListener('change', () => save({ punctuationPauses: els.punctuationPauses.checked }));
  els.focusMode.addEventListener('change', () => save({ focusMode: els.focusMode.value }));
  els.autoScroll.addEventListener('change', () => save({ autoScroll: els.autoScroll.checked }));

  // --- Voice preview / test playback ---

  let _testAudio = null;

  function stopAllPreviews() {
    speechSynthesis.cancel();
    if (_testAudio) {
      _testAudio.pause();
      _testAudio.removeAttribute('src');
      _testAudio.load();
      _testAudio = null;
    }
  }

  els.btnPreview.addEventListener('click', () => {
    stopAllPreviews();
    const utterance = new SpeechSynthesisUtterance(
      'Hello! This is a preview of the selected voice. How does it sound?'
    );
    const voices = speechSynthesis.getVoices();
    const selected = voices.find(v => v.voiceURI === els.voice.value);
    if (selected) utterance.voice = selected;
    utterance.rate = parseFloat(els.rate.value);
    utterance.pitch = parseFloat(els.pitch.value);
    utterance.volume = parseFloat(els.volume.value);
    speechSynthesis.speak(utterance);
  });
})();
