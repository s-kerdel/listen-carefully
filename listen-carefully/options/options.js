/**
 * Options Page Script - full settings panel with voice preview.
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

  const DEFAULTS = {
    voiceURI: null,
    rate: 1.0,
    pitch: 1.0,
    volume: 1.0,
    highlightBg: '#FFEB3B',
    highlightFg: '#000000',
    skipCodeBlocks: true,
    skipAltText: false,
    skipLinks: false,
    neonHighlight: true,
    punctuationPauses: true,
    focusMode: 'off',
    autoScroll: true,
  };

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

  chrome.storage.local.get(DEFAULTS, (s) => {
    els.rate.value = s.rate;
    els.rateValue.textContent = s.rate.toFixed(1) + 'x';
    els.volume.value = s.volume;
    els.volumeValue.textContent = Math.round(s.volume * 100) + '%';
    els.pitch.value = s.pitch;
    els.pitchValue.textContent = s.pitch.toFixed(1);
    els.highlightBg.value = validHex(s.highlightBg) || DEFAULTS.highlightBg;
    els.highlightFg.value = validHex(s.highlightFg) || DEFAULTS.highlightFg;
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
    const bg = validHex(els.highlightBg.value) || DEFAULTS.highlightBg;
    const fg = validHex(els.highlightFg.value) || DEFAULTS.highlightFg;
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
      const bg = validHex(btn.dataset.bg) || DEFAULTS.highlightBg;
      const fg = validHex(btn.dataset.fg) || DEFAULTS.highlightFg;
      els.highlightBg.value = bg;
      els.highlightFg.value = fg;
      updatePreview();
      save({ highlightBg: bg, highlightFg: fg });
    });
  });

  // --- Event listeners ---

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

  // --- Voice preview ---

  els.btnPreview.addEventListener('click', () => {
    speechSynthesis.cancel();
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
