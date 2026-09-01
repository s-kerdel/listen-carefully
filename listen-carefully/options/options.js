/**
 * Options Page Script - full settings panel with voice preview and Kokoro TTS configuration.
 */

(function () {
  'use strict';

  // Theme detection (class-based for Brave compatibility).
  // Also reports the theme to the background service worker so the toolbar
  // Apply dark mode class based on system theme.
  function applyTheme() {
    const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.body.classList.toggle('dark', isDark);
  }
  applyTheme();
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

  const els = {
    ttsBackend: document.getElementById('tts-backend'),
    kokoroSettings: document.getElementById('kokoro-settings'),
    kokoroEndpoint: document.getElementById('kokoro-endpoint'),
    kokoroVoice: document.getElementById('kokoro-voice'),
    btnRefreshKokoro: document.getElementById('btn-refresh-kokoro'),
    btnTestKokoro: document.getElementById('btn-test-kokoro'),
    kokoroTestResult: document.getElementById('kokoro-test-result'),
    kokoroJsSettings: document.getElementById('kokorojs-settings'),
    kokoroJsVoice: document.getElementById('kokorojs-voice'),
    kokoroJsDevice: document.getElementById('kokorojs-device'),
    kokoroJsIdleUnload: document.getElementById('kokorojs-idle-unload'),
    btnTestKokoroJs: document.getElementById('btn-test-kokorojs'),
    btnUnloadKokoroJs: document.getElementById('btn-unload-kokorojs'),
    kokoroJsTestResult: document.getElementById('kokorojs-test-result'),
    voiceSection: document.getElementById('voice-section'),
    voice: document.getElementById('voice'),
    showAllLanguages: document.getElementById('show-all-languages'),
    noVoicesNote: document.getElementById('voice-no-voices-note'),
    limitedNote: document.getElementById('voice-limited-note'),
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
    focusMode: document.getElementById('focus-mode'),
    focusDimStyle: document.getElementById('focus-dim-style'),
    wordMarkerStyle: document.getElementById('word-marker-style'),
    matchingUnderline: document.getElementById('matching-underline'),
    autoScroll: document.getElementById('auto-scroll'),
    siteList: document.getElementById('site-list'),
    siteHostname: document.getElementById('site-hostname'),
    siteSelector: document.getElementById('site-selector'),
    btnAddSite: document.getElementById('btn-add-site'),
    btnReset: document.getElementById('btn-reset'),
    savedMsg: document.getElementById('saved-msg'),
  };

  // SETTINGS_DEFAULTS, KOKORO_LANGS, KOKORO_GENDERS, formatKokoroVoice
  // loaded from lib/config.js

  let _activeVoiceLimited = false;

  // Line focus needs word boundaries, which limited voices don't fire.
  // Disable the option for them and demote a saved 'line' to 'text'.
  function refreshLineFocusAvailability() {
    const lineOpt = els.focusMode.querySelector('option[value="line"]');
    if (lineOpt) lineOpt.disabled = _activeVoiceLimited;
    if (_activeVoiceLimited && els.focusMode.value === 'line') {
      els.focusMode.value = 'text';
      save({ focusMode: 'text' });
      updatePreview();
    }
  }

  function validHex(str) {
    return /^#(?:[A-Fa-f0-9]{3}|[A-Fa-f0-9]{4}|[A-Fa-f0-9]{6}|[A-Fa-f0-9]{8})$/.test(str) ? str : null;
  }

  // --- Save with visual feedback ---

  let hideTimeout;
  function save(partial) {
    safeSave(partial);
    chrome.tabs.query({}, (tabs) => {
      for (const tab of tabs) {
        chrome.tabs.sendMessage(tab.id, { type: 'updateSettings', settings: partial }).catch(() => {});
      }
    });
    els.savedMsg.classList.add('visible');
    clearTimeout(hideTimeout);
    hideTimeout = setTimeout(() => els.savedMsg.classList.remove('visible'), 3000);
  }

  // --- Backend UI toggle ---

  function updateBackendUI(backend) {
    const isFastApi = backend === 'kokoro';
    const isKokoroJs = backend === 'kokorojs';
    const isKokoro = isKokoroBackend(backend);
    els.kokoroSettings.hidden = !isFastApi;
    els.kokoroJsSettings.hidden = !isKokoroJs;
    els.voiceSection.hidden = isKokoro;
    // Pitch is not supported by either Kokoro backend
    const pitchGroup = els.pitch.closest('.slider-group');
    pitchGroup.style.opacity = isKokoro ? '0.4' : '';
    els.pitch.disabled = isKokoro;
    if (isFastApi) loadKokoroOptions();
  }

  // --- Kokoro-js (in-browser model) ---

  /**
   * Kokoro-js ships a fixed voice list, so unlike the FastAPI backend there is
   * nothing to query - the dropdown fills synchronously, before the model has
   * been downloaded.
   */
  function populateKokoroJsVoices(savedVoice) {
    els.kokoroJsVoice.replaceChildren();
    for (const id of KOKOROJS_VOICES) {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = formatKokoroVoice(id);
      els.kokoroJsVoice.appendChild(opt);
    }
    els.kokoroJsVoice.value = KOKOROJS_VOICES.includes(savedVoice)
      ? savedVoice
      : SETTINGS_DEFAULTS.kokoroJsVoice;
  }

  function showKokoroJsResult(text, kind) {
    els.kokoroJsTestResult.hidden = false;
    els.kokoroJsTestResult.textContent = text;
    els.kokoroJsTestResult.className = `test-result ${kind}`;
  }

  // --- Load Kokoro voices and models from API ---

  /** Check if voice ID matches the known {lang}{gender}_{name} pattern. */
  function isKnownVoiceFormat(id) {
    return id.length >= 4 && id[2] === '_'
      && id[0] in KOKORO_LANGS && id[1] in KOKORO_GENDERS;
  }

  async function loadKokoroOptions() {
    const endpoint = els.kokoroEndpoint.value.replace(/\/+$/, '');
    const { kokoroVoice: savedVoice } = await new Promise(r =>
      chrome.storage.local.get({ kokoroVoice: SETTINGS_DEFAULTS.kokoroVoice }, r)
    );

    // Replace dropdown with a disabled option that displays the saved voice,
    // and surface the error reason in the existing kokoro-test-result element.
    // The option carries savedVoice as its value so any incidental save() is
    // a no-op (storage stays untouched).
    const showError = (msg) => {
      els.kokoroVoice.replaceChildren();
      const opt = document.createElement('option');
      opt.value = savedVoice;
      opt.disabled = true;
      opt.selected = true;
      opt.textContent = formatKokoroVoice(savedVoice);
      els.kokoroVoice.appendChild(opt);
      els.kokoroTestResult.hidden = false;
      els.kokoroTestResult.textContent = msg;
      els.kokoroTestResult.className = 'test-result error';
    };

    if (!isLocalhostURL(endpoint)) {
      showError('Endpoint must be a localhost address (localhost, 127.0.0.1)');
      return;
    }

    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 15000);
      const res = await fetch(`${endpoint}/v1/audio/voices`, { signal: ac.signal }).catch(() => null);
      clearTimeout(t);
      if (!res?.ok) {
        showError(res
          ? `Kokoro server at ${endpoint} returned HTTP ${res.status}`
          : `Cannot reach Kokoro server at ${endpoint}. Is the server running?`);
        return;
      }

      const data = await res.json();
      // Kokoro-FastAPI >= v0.4.0 returns [{id, name}, ...]; older builds returned
      // plain strings. Accept both so the dropdown works against either server.
      const voices = Array.isArray(data.voices)
        ? data.voices
            .map(v => (typeof v === 'string' ? v : v?.id))
            .filter(v => typeof v === 'string' && v)
        : [];
      if (voices.length === 0) {
        showError(`Kokoro server at ${endpoint} returned no voices`);
        return;
      }

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

      // Voices that don't match the pattern - show raw ID
      for (const v of ungrouped) {
        const opt = document.createElement('option');
        opt.value = v;
        opt.textContent = v;
        els.kokoroVoice.appendChild(opt);
      }

      els.kokoroVoice.value = voices.includes(savedVoice) ? savedVoice : voices[0];
      els.kokoroTestResult.hidden = true;
    } catch {
      showError(`Cannot reach Kokoro server at ${endpoint}. Is the server running?`);
    }
  }

  // --- Load voices (options page has direct access to speechSynthesis) ---

  function loadVoices() {
    const allVoices = speechSynthesis.getVoices();
    if (allVoices.length === 0) return;

    chrome.storage.local.get(
      { voiceURI: null, showAllLanguages: false },
      (s) => {
        // Auto-pick only when no saved voice or it refers to a no-longer-
        // installed voice. A user-selected limited voice (Google / Microsoft
        // Online / etc.) is respected - it just shows the warning + suppresses
        // the per-word marker. This matches the engine's _maybeAutoPickVoice.
        let voiceURI = s.voiceURI;
        const saved = voiceURI && allVoices.find(v => v.voiceURI === voiceURI);
        if (!saved) {
          const picked = pickDefaultVoice(allVoices);
          if (picked && picked !== voiceURI) {
            voiceURI = picked;
            safeSave({ voiceURI: picked });
          }
        }

        // Truly empty system (no TTS at all) - rare, but keep the alert
        // for the case where Chromium reports zero voices.
        els.noVoicesNote.hidden = allVoices.length > 0;

        // Limited voices stay selectable but suppress word-by-word marking.
        // Show an inline warning when the active selection is one of them.
        const selected = allVoices.find(v => v.voiceURI === voiceURI);
        _activeVoiceLimited = Boolean(selected && isLimitedVoice(selected));
        els.limitedNote.hidden = !_activeVoiceLimited;
        refreshLineFocusAvailability();

        const visible = filterVoicesForDropdown(allVoices, voiceURI, s.showAllLanguages);

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

        if (voiceURI) els.voice.value = voiceURI;
      }
    );
  }

  speechSynthesis.addEventListener('voiceschanged', loadVoices);
  loadVoices();

  // --- Load settings ---

  chrome.storage.local.get(SETTINGS_DEFAULTS, (s) => {
    els.ttsBackend.value = s.ttsBackend;
    els.kokoroEndpoint.value = s.kokoroEndpoint;
    els.kokoroVoice.value = s.kokoroVoice;
    populateKokoroJsVoices(s.kokoroJsVoice);
    els.kokoroJsDevice.value = s.kokoroJsDevice;
    els.kokoroJsIdleUnload.value = String(s.kokoroJsIdleUnload);
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
    els.punctuationPauses.checked = s.punctuationPauses;
    // Backward compat: convert old boolean focusMode to string
    const fm = s.focusMode === true ? 'sentence' : (s.focusMode || 'off');
    els.focusMode.value = fm;
    refreshLineFocusAvailability();
    els.focusDimStyle.value = (s.focusDimStyle === 'band') ? 'band' : 'dim';
    const validMarkers = ['color-underline', 'color-underline-continuous', 'color', 'bg-only'];
    els.wordMarkerStyle.value = validMarkers.includes(s.wordMarkerStyle) ? s.wordMarkerStyle : 'color-underline';
    els.matchingUnderline.checked = s.matchingUnderline !== false;
    els.autoScroll.checked = s.autoScroll;
    els.showAllLanguages.checked = !!s.showAllLanguages;
    _siteSelectors = s.siteSelectors || {};
    renderSiteSelectors();
    updatePreview();
  });

  // --- Highlight preview ---

  function updatePreview() {
    const word = els.highlightPreview.querySelector('.preview-word');
    const activeSentence = els.highlightPreview.querySelector('.preview-sentence-active');
    const vlineActive = els.highlightPreview.querySelector('.preview-vline-active');
    const vlineTrailing = els.highlightPreview.querySelector('.preview-vline-trailing');
    const otherSentences = els.highlightPreview.querySelectorAll('.preview-sentence-other');
    const activePara = els.highlightPreview.querySelector('.preview-para-active');
    const otherPara = els.highlightPreview.querySelector('.preview-para-other');
    const bg = validHex(els.highlightBg.value) || SETTINGS_DEFAULTS.highlightBg;
    const fg = validHex(els.highlightFg.value) || SETTINGS_DEFAULTS.highlightFg;

    for (const el of [word, activeSentence, vlineActive, vlineTrailing, activePara, otherPara, ...otherSentences]) {
      el.style.cssText = '';
    }

    // Active-word marker.
    const marker = els.wordMarkerStyle.value;
    if (marker === 'color') {
      word.style.color = bg;
    } else if (marker === 'color-underline' || marker === 'color-underline-continuous') {
      word.style.color = bg;
      const underlineColor = els.matchingUnderline.checked ? bg : fg;
      word.style.textDecoration = `underline ${underlineColor} solid 3px`;
      word.style.textUnderlineOffset = '2px';
      if (marker === 'color-underline-continuous') {
        word.style.textDecorationSkipInk = 'none';
      }
    } else {
      word.style.backgroundColor = bg;
      word.style.color = fg;
    }

    // Focus mode + dim style.
    //   text     - active paragraph stays, other paragraphs dim
    //   sentence - only active sentence stays (both visual lines), the rest dims
    //   line     - only active visual line stays, same-sentence overflow also dims
    const fm = els.focusMode.value;
    if (fm === 'off') return;

    const DIM = 'rgba(128, 128, 128, 0.55)';
    const BAND = `color-mix(in srgb, ${bg} 18%, transparent)`;
    const band = els.focusDimStyle.value === 'band';

    if (fm === 'text') {
      otherPara.style.color = DIM;
      if (band) {
        activePara.style.backgroundColor = BAND;
        activePara.style.color = fg;
      }
    } else if (fm === 'sentence') {
      for (const s of otherSentences) s.style.color = DIM;
      otherPara.style.color = DIM;
      if (band) {
        activeSentence.style.backgroundColor = BAND;
        activeSentence.style.color = fg;
      }
    } else {
      // line
      for (const s of otherSentences) s.style.color = DIM;
      otherPara.style.color = DIM;
      vlineTrailing.style.color = DIM;
      if (band) {
        vlineActive.style.backgroundColor = BAND;
        vlineActive.style.color = fg;
      }
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

    // permissions.request rejects when denied, but *throws synchronously* when
    // Chrome decides there was no user gesture - so both need catching, or the
    // engine switch is abandoned before anything is saved.
    const requestOrigins = async (origins) => {
      try {
        return await chrome.permissions.request({ origins });
      } catch {
        return false;
      }
    };

    // Kokoro-FastAPI cannot work at all without loopback access, so a refusal
    // cancels the switch.
    if (backend === 'kokoro') {
      const granted = await requestOrigins(['http://localhost/*', 'http://127.0.0.1/*']);
      if (!granted) {
        els.ttsBackend.value = 'browser';
        return;
      }
    }

    // Kokoro-js only needs Hugging Face for the one-time model download, and
    // the hub already serves those files with permissive CORS - so ask (it
    // hardens the download against a redirect to a stricter host) but keep the
    // engine selected either way.
    if (backend === 'kokorojs') {
      await requestOrigins([
        'https://huggingface.co/*', 'https://*.hf.co/*', 'https://*.huggingface.co/*',
      ]);
    }

    stopAllPreviews();
    els.kokoroTestResult.hidden = true;
    els.kokoroJsTestResult.hidden = true;
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

  els.btnRefreshKokoro.addEventListener('click', loadKokoroOptions);

  els.kokoroJsVoice.addEventListener('change', () => save({ kokoroJsVoice: els.kokoroJsVoice.value }));

  els.kokoroJsIdleUnload.addEventListener('change', () => {
    // Takes effect on the next synthesis, which is when the timer is re-armed.
    save({ kokoroJsIdleUnload: Number(els.kokoroJsIdleUnload.value) });
  });

  // Frees the model's memory now rather than waiting out the idle timer.
  els.btnUnloadKokoroJs.addEventListener('click', async () => {
    els.btnUnloadKokoroJs.disabled = true;
    try {
      const res = await chrome.runtime.sendMessage({ type: 'kokoroJsUnload' });
      if (res?.error) {
        showKokoroJsResult(`Could not unload: ${res.error}`, 'error');
      } else if (res?.unloaded) {
        showKokoroJsResult('Model unloaded - memory released.', 'success');
        setTimeout(() => { els.kokoroJsTestResult.hidden = true; }, 3000);
      } else {
        showKokoroJsResult('Model was not loaded.', 'testing');
        setTimeout(() => { els.kokoroJsTestResult.hidden = true; }, 3000);
      }
    } catch (err) {
      showKokoroJsResult(`Could not unload: ${err.message}`, 'error');
    } finally {
      els.btnUnloadKokoroJs.disabled = false;
    }
  });

  els.kokoroJsDevice.addEventListener('change', () => {
    // WebGPU needs fp32 weights and wasm needs q8; kokoro-js produces silence
    // rather than an error on a mismatched pair, so the two move together.
    save({ kokoroJsDevice: els.kokoroJsDevice.value });
    els.kokoroJsTestResult.hidden = true;
  });

  // Downloads the model (or reuses the cached copy) and speaks one sentence.
  // The offscreen document owns the load, so progress is polled from it
  // rather than pushed - a background broadcast would have no receiver
  // whenever this page is closed.
  els.btnTestKokoroJs.addEventListener('click', async () => {
    const device = els.kokoroJsDevice.value;
    els.btnTestKokoroJs.disabled = true;
    showKokoroJsResult('Preparing model - the first run downloads about 90 MB...', 'testing');

    const poll = setInterval(async () => {
      const st = await chrome.runtime.sendMessage({ type: 'kokoroJsStatus', device })
        .catch(() => null);
      if (st?.state === 'loading' && st.progress > 0) {
        showKokoroJsResult(`Downloading model... ${st.progress}%`, 'testing');
      }
    }, 500);

    try {
      const result = await chrome.runtime.sendMessage({
        type: 'kokoroJsTTS',
        text: 'Kokoro running locally in your browser. This is a test.',
        voice: els.kokoroJsVoice.value || SETTINGS_DEFAULTS.kokoroJsVoice,
        speed: parseFloat(els.rate.value) || 1.0,
        device,
        idleUnloadMinutes: Number(els.kokoroJsIdleUnload.value),
      });
      clearInterval(poll);

      if (!result || result.error) {
        showKokoroJsResult(`Test failed: ${result?.error || 'no response'}`, 'error');
        return;
      }

      const raw = atob(result.audio);
      const bytes = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
      const url = URL.createObjectURL(new Blob([bytes], { type: result.audio_format }));
      const audio = new Audio(url);
      _testAudio = audio;
      audio.volume = parseFloat(els.volume.value) || 1.0;
      const revoke = () => { URL.revokeObjectURL(url); if (_testAudio === audio) _testAudio = null; };
      const label = result.device === 'webgpu' ? 'GPU (WebGPU)' : 'CPU (WebAssembly)';
      audio.onended = () => {
        revoke();
        showKokoroJsResult(`Model ready - running on ${label}`, 'success');
        setTimeout(() => { els.kokoroJsTestResult.hidden = true; }, 3000);
      };
      audio.onerror = revoke;
      audio.play().catch(revoke);
      showKokoroJsResult(`Model ready (${label}) - playing test audio...`, 'success');
    } catch (err) {
      clearInterval(poll);
      showKokoroJsResult(`Test failed: ${err.message}`, 'error');
    } finally {
      clearInterval(poll);
      els.btnTestKokoroJs.disabled = false;
    }
  });

  // isLocalhostURL loaded from lib/config.js

  els.btnTestKokoro.addEventListener('click', async () => {
    const endpoint = els.kokoroEndpoint.value.replace(/\/+$/, '');
    const voice = els.kokoroVoice.value || SETTINGS_DEFAULTS.kokoroVoice;

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
      }).catch(() => null);
      clearTimeout(t);

      if (!response?.ok) {
        els.kokoroTestResult.textContent = response
          ? `Kokoro server at ${endpoint} returned HTTP ${response.status}`
          : `Cannot reach Kokoro server at ${endpoint}. Is the server running?`;
        els.kokoroTestResult.className = 'test-result error';
        return;
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

      els.kokoroTestResult.textContent = 'Connected - playing test audio...';
      els.kokoroTestResult.className = 'test-result success';
    } catch (err) {
      els.kokoroTestResult.textContent = `Test failed: ${err.message}`;
      els.kokoroTestResult.className = 'test-result error';
    }
  });

  els.voice.addEventListener('change', () => {
    save({ voiceURI: els.voice.value });
    // Refresh the limited-voice warning + line-focus availability for the new selection.
    const v = speechSynthesis.getVoices().find(x => x.voiceURI === els.voice.value);
    _activeVoiceLimited = Boolean(v && isLimitedVoice(v));
    els.limitedNote.hidden = !_activeVoiceLimited;
    refreshLineFocusAvailability();
  });

  els.showAllLanguages.addEventListener('change', () => {
    save({ showAllLanguages: els.showAllLanguages.checked });
    loadVoices();
  });

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

  els.skipCode.addEventListener('change', () => save({ skipCodeBlocks: els.skipCode.checked }));
  els.skipAlt.addEventListener('change', () => save({ skipAltText: els.skipAlt.checked }));
  els.skipLinks.addEventListener('change', () => save({ skipLinks: els.skipLinks.checked }));
  els.punctuationPauses.addEventListener('change', () => save({ punctuationPauses: els.punctuationPauses.checked }));
  els.focusMode.addEventListener('change', () => {
    save({ focusMode: els.focusMode.value });
    updatePreview();
  });
  els.focusDimStyle.addEventListener('change', () => {
    save({ focusDimStyle: els.focusDimStyle.value });
    updatePreview();
  });
  els.wordMarkerStyle.addEventListener('change', () => {
    save({ wordMarkerStyle: els.wordMarkerStyle.value });
    updatePreview();
  });
  els.matchingUnderline.addEventListener('change', () => {
    save({ matchingUnderline: els.matchingUnderline.checked });
    updatePreview();
  });
  els.autoScroll.addEventListener('change', () => save({ autoScroll: els.autoScroll.checked }));

  els.btnReset.addEventListener('click', () => {
    if (!confirm('Reset all settings to defaults?')) return;
    chrome.storage.local.set(SETTINGS_DEFAULTS, () => {
      chrome.tabs.query({}, (tabs) => {
        for (const tab of tabs) {
          chrome.tabs.sendMessage(tab.id, { type: 'updateSettings', settings: SETTINGS_DEFAULTS }).catch(() => {});
        }
      });
      location.reload();
    });
  });

  // --- Site selectors ---

  let _siteSelectors = {};

  function renderSiteSelectors() {
    els.siteList.replaceChildren();
    for (const [host, selector] of Object.entries(_siteSelectors)) {
      const row = document.createElement('div');
      row.className = 'site-entry';
      row.innerHTML =
        `<span class="site-entry-host"></span>` +
        `<span class="site-entry-selector"></span>` +
        `<button class="btn-delete" aria-label="Remove custom selector">` +
        `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>` +
        `</button>`;
      row.querySelector('.site-entry-host').textContent = host;
      row.querySelector('.site-entry-selector').textContent = selector;
      row.querySelector('.btn-delete').addEventListener('click', () => {
        delete _siteSelectors[host];
        save({ siteSelectors: _siteSelectors });
        renderSiteSelectors();
      });
      els.siteList.appendChild(row);
    }
  }

  // Caps chosen to stay comfortably inside chrome.storage.local's 10MB
  // quota even if the user pastes extreme values, while exceeding any
  // realistic hostname / selector length.
  const MAX_SITE_ENTRIES = 500;
  const MAX_HOST_LENGTH = 253;    // DNS hostname max
  const MAX_SELECTOR_LENGTH = 1024;

  els.btnAddSite.addEventListener('click', () => {
    const host = els.siteHostname.value.trim().toLowerCase();
    const selector = els.siteSelector.value.trim();
    if (!host || !selector) return;
    if (host.length > MAX_HOST_LENGTH || selector.length > MAX_SELECTOR_LENGTH) {
      console.warn('Listen Carefully: site entry rejected - value exceeds length cap.');
      return;
    }
    // Guard against runaway storage from repeated additions.
    if (!(host in _siteSelectors) && Object.keys(_siteSelectors).length >= MAX_SITE_ENTRIES) {
      console.warn(`Listen Carefully: site selector limit (${MAX_SITE_ENTRIES}) reached.`);
      return;
    }
    _siteSelectors[host] = selector;
    save({ siteSelectors: _siteSelectors });
    els.siteHostname.value = '';
    els.siteSelector.value = '';
    renderSiteSelectors();
  });

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
