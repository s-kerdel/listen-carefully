/**
 * TTS Engine - supports both Web Speech Synthesis API and Kokoro (OpenAI-compatible) TTS.
 *
 * Browser backend: wraps speechSynthesis with sentence-level queue management.
 * Kokoro backend: fetches audio from local API, plays via Audio element
 * (with AudioContext fallback for CSP-restricted pages), cleans non-word
 * token prefixes before synthesis, and estimates word boundaries for
 * highlighting.
 *
 * Chromium silently stops long utterances (~15s), so the browser backend
 * chunks text into sentences and feeds them one at a time.
 */

class TTSEngine {
  constructor() {
    this.queue = [];
    this.currentIndex = -1;
    this._activeSpeech = null;
    this._browserFailCount = 0;
    this.state = 'stopped'; // 'stopped' | 'playing' | 'paused'
    this.voices = [];
    this.settings = {
      voiceURI: null,
      rate: 1.0,
      pitch: 1.0,
      volume: 1.0,
      ttsBackend: 'browser',
      kokoroEndpoint: 'http://localhost:8880',
      kokoroVoice: 'af_alloy',
    };

    // Kokoro playback state
    this._audio = null;             // HTMLAudioElement (primary path)
    this._blobUrl = null;           // tracked for revocation on stop/skip
    this._audioCtx = null;          // lazily created, only for CSP fallback
    this._gainNode = null;          // created with audioCtx, reused
    this._sourceNode = null;        // AudioBufferSourceNode (CSP fallback path)
    this._playbackStartTime = 0;    // audioCtx.currentTime when source started
    this._cspFallback = false;      // true after Audio element blocked by page CSP
    this._kokoroFailCount = 0;      // consecutive failures - stops after 3
    this._cancelGen = 0;            // incremented on cancel to invalidate in-flight fetches
    this._restartTimer = null;      // debounce timer for Kokoro settings restart
    this._wordTimerRAF = null;      // requestAnimationFrame ID
    this._wordPositions = [];       // [{charIndex, charLength}] per word in sentence
    this._wordTimestamps = [];      // start time (seconds) per word
    this._lastHighlightedIdx = -1;
    this._wordTimerSentence = -1;

    // Callbacks - set by content.js
    this.onBoundary = null;    // (charIndex, charLength, sentenceIndex) => void
    this.onStateChange = null; // (state) => void
    this.onSentenceStart = null; // (sentenceIndex) => void
    this.onEnd = null;          // () => void
    this.onError = null;        // (message) => void

    this._loadVoices();
    speechSynthesis.addEventListener('voiceschanged', () => this._loadVoices());
  }

  get _isKokoro() {
    return this.settings.ttsBackend === 'kokoro';
  }

  _loadVoices() {
    this.voices = speechSynthesis.getVoices();
  }

  getVoices() {
    return this.voices;
  }

  _findVoice(uri) {
    return this.voices.find(v => v.voiceURI === uri) || null;
  }

  /** Cancel both backends - safe to call regardless of active backend. */
  _cancelAll() {
    clearTimeout(this._restartTimer);
    clearTimeout(this._skipDebounce);
    this._pendingSkip = false;
    this._cancelGen++;              // invalidate any in-flight Kokoro fetch
    this._stopKokoroPlayback();
    // Clear active speech BEFORE cancel() so stale onend events
    // (fired sync on Firefox, async on Chrome) are ignored.
    this._activeSpeech = null;
    speechSynthesis.cancel();
  }

  /**
   * Update TTS settings. If currently playing, restarts the current sentence
   * so the new voice/rate/pitch/volume takes effect immediately.
   */
  static _SETTINGS_KEYS = [
    'voiceURI', 'rate', 'pitch', 'volume', 'ttsBackend',
    'kokoroEndpoint', 'kokoroVoice',
  ];

  // Spoken expansions for leading non-word prefixes in Kokoro text.
  // Prevents timestamp truncation while keeping symbols audible.
  static _PREFIX_MAP = { '/': 'slash', '@': 'at', '#': 'hash' };

  updateSettings(settings) {
    const wasPlaying = this.state === 'playing';
    const prev = { ...this.settings };

    // Allowlist keys to prevent prototype pollution
    for (const k of TTSEngine._SETTINGS_KEYS) {
      if (k in settings) this.settings[k] = settings[k];
    }

    // Check if anything actually changed
    const changed = TTSEngine._SETTINGS_KEYS.some(k => this.settings[k] !== prev[k]);
    if (!changed) return;

    if (this.state === 'paused') {
      this._settingsChangedWhilePaused = true;
    }

    // Restart current sentence so new settings apply immediately.
    if (wasPlaying && this.queue.length > 0) {
      // Kokoro: volume is client-side, update instantly without re-fetching
      if (this._isKokoro && (this._audio || this._sourceNode)) {
        if (this._audio) this._audio.volume = this.settings.volume;
        else this._gainNode.gain.value = this.settings.volume;
        const needsRefetch = this.settings.rate !== prev.rate
          || this.settings.kokoroVoice !== prev.kokoroVoice
          || this.settings.kokoroEndpoint !== prev.kokoroEndpoint
          || this.settings.ttsBackend !== prev.ttsBackend;
        if (!needsRefetch) return;
      }

      // Debounce Kokoro restarts so rapid slider adjustments don't flood the server
      if (this._isKokoro) {
        this._cancelAll();
        const idx = this.currentIndex;
        this._restartTimer = setTimeout(() => {
          if (this.state !== 'playing') {
            // Paused during debounce: tell resume() to re-speak with new settings
            if (this.state === 'paused') this._settingsChangedWhilePaused = true;
            return;
          }
          this.currentIndex = idx - 1;
          this._speakNext();
        }, 300);
        return;
      }

      const idx = this.currentIndex;
      this._cancelAll();
      this.currentIndex = idx - 1; // _speakNext increments
      this._speakNext();
    }
  }

  /**
   * Load sentences into the queue and start playing.
   */
  play(sentences) {
    // Cancel previous playback (including paused) without triggering onEnd.
    // stop() fires onEnd which cleans up the highlighter - we must NOT do
    // that here because the caller has already set up new highlight state.
    this._cancelAll();

    this.queue = sentences;
    this.currentIndex = -1;
    this._kokoroFailCount = 0;
    this._browserFailCount = 0;
    this._settingsChangedWhilePaused = false;
    this._setState('playing');
    this._speakNext();
  }

  pause() {
    if (this.state !== 'playing') return;
    if (this._isKokoro) {
      if (this._audio) this._audio.pause();
      else if (this._audioCtx && this._audioCtx.state === 'running') this._audioCtx.suspend();
      this._clearWordTimer();
    } else {
      speechSynthesis.pause();
    }
    this._pausedAt = Date.now();
    this._setState('paused');
  }

  resume() {
    if (this.state !== 'paused') return;

    // Re-speak if settings changed while paused, or if Chrome killed the
    // browser utterance after ~15s of pause.
    const elapsed = Date.now() - (this._pausedAt || 0);
    const needsRespeak = this._settingsChangedWhilePaused
      || (!this._isKokoro && elapsed > 14000);

    if (needsRespeak) {
      this._settingsChangedWhilePaused = false;
      this._cancelAll();
      this.currentIndex -= 1; // _speakNext increments
      this._setState('playing');
      this._speakNext();
      return;
    }

    this._setState('playing');

    if (this._isKokoro) {
      if (this._audio) {
        this._audio.play();
        this._resumeWordTimer();
      } else if (this._sourceNode) {
        if (this._audioCtx && this._audioCtx.state === 'suspended') this._audioCtx.resume();
        this._resumeWordTimer();
      } else if (this._pendingSkip) {
        // Skip was pending when paused — play the skipped-to sentence
        this._pendingSkip = false;
        clearTimeout(this._skipDebounce);
        this._speakNextKokoro();
      } else {
        // Audio finished while paused — advance to next sentence
        this._speakNext();
      }
    } else {
      speechSynthesis.resume();
      // Utterance may have finished while paused — if so, resume does nothing.
      // Detect this: if speechSynthesis is no longer speaking/pending after a
      // short tick, the utterance ended during pause and we need to advance.
      setTimeout(() => {
        if (this.state === 'playing' && !speechSynthesis.speaking && !speechSynthesis.pending) {
          this._speakNext();
        }
      }, 100);
    }
  }

  stop() {
    this._cancelAll();
    this.queue = [];
    this.currentIndex = -1;
    this._setState('stopped');
    if (this.onEnd) this.onEnd();
  }

  togglePlayPause(sentences) {
    if (this.state === 'playing') {
      this.pause();
    } else if (this.state === 'paused') {
      this.resume();
    } else if (sentences) {
      this.play(sentences);
    }
  }

  skipNext() {
    if (this.currentIndex < this.queue.length - 1) {
      this._cancelAll();
      this.currentIndex++;
      this._setState('playing');
      this._skipToCurrentSentence();
    }
  }

  skipPrev() {
    if (this.queue.length === 0) return;
    this._cancelAll();
    this.currentIndex = Math.max(0, this.currentIndex - 1);
    this._setState('playing');
    this._skipToCurrentSentence();
  }

  /** Instant visual feedback + debounced Kokoro fetch for skip operations.
   *  Prevents GPU-heavy TTS requests during rapid skipping. */
  _skipToCurrentSentence() {
    // Visual feedback is immediate — highlight jumps to the new sentence
    if (this.onSentenceStart) this.onSentenceStart(this.currentIndex);

    if (this._isKokoro) {
      // Debounce: only fetch audio once the user stops skipping
      this._pendingSkip = true;
      clearTimeout(this._skipDebounce);
      this._skipDebounce = setTimeout(() => {
        if (this.state === 'playing') {
          this._pendingSkip = false;
          this._speakNextKokoro();
        }
      }, 300);
    } else {
      this._speakNextBrowser();
    }
  }

  getCurrentSentenceIndex() {
    return this.currentIndex;
  }

  _setState(state) {
    this.state = state;
    if (this.onStateChange) this.onStateChange(state);
  }

  // --- Sentence dispatcher ---

  _speakNext() {
    this.currentIndex++;

    if (this.currentIndex >= this.queue.length) {
      this._setState('stopped');
      if (this.onEnd) this.onEnd();
      return;
    }

    if (this._isKokoro) {
      this._speakNextKokoro();
    } else {
      this._speakNextBrowser();
    }
  }

  // --- Browser (Web Speech) backend ---

  _speakNextBrowser() {
    const text = this.queue[this.currentIndex];
    const utterance = new SpeechSynthesisUtterance(text);
    const voice = this._findVoice(this.settings.voiceURI);
    if (voice) utterance.voice = voice;
    utterance.rate = this.settings.rate;
    utterance.pitch = this.settings.pitch;
    utterance.volume = this.settings.volume;

    const sentenceIndex = this.currentIndex;

    utterance.onboundary = (event) => {
      if (event.name === 'word' && this.onBoundary && this._activeSpeech === utterance) {
        this.onBoundary(event.charIndex, event.charLength, sentenceIndex);
      }
    };

    utterance.onend = () => {
      if (this._activeSpeech === utterance && this.state === 'playing') {
        this._browserFailCount = 0;
        this._speakNext();
      }
    };

    utterance.onerror = (event) => {
      if (event.error === 'interrupted' || event.error === 'canceled') return;
      console.warn('TTS utterance error:', event.error);
      if (this._activeSpeech !== utterance) return;
      // Real error: skip to next sentence, or stop after 3 consecutive failures
      this._browserFailCount++;
      if (this._browserFailCount >= 3) {
        if (this.onError) this.onError('Speech synthesis failed. Try a different voice.');
        this.stop();
      } else if (this.state === 'playing') {
        this._speakNext();
      }
    };

    this._activeSpeech = utterance;
    if (this.onSentenceStart) this.onSentenceStart(sentenceIndex);
    speechSynthesis.speak(utterance);
  }

  // --- Kokoro (API) backend ---

  async _speakNextKokoro() {
    const text = this.queue[this.currentIndex];
    const sentenceIndex = this.currentIndex;
    const gen = this._cancelGen;
    const endpoint = (this.settings.kokoroEndpoint || 'http://localhost:8880').replace(/\/+$/, '');

    // Clean text for Kokoro: expand or strip leading non-word chars from
    // tokens to prevent Kokoro from truncating timestamps at special chars.
    // Known prefixes are spoken (e.g. "/" → "slash"); unknown ones are
    // stripped (e.g. "-a" → "a"). Original text is kept for highlight mapping.
    const kokoroText = text.split(' ')
      .map(w => {
        const m = w.match(/^([^\w]+)(.*)/);
        if (!m) return w;
        const [, prefix, rest] = m;
        if (!rest) return '';
        const spoken = TTSEngine._PREFIX_MAP[prefix];
        return spoken ? spoken + ' ' + rest : rest;
      })
      .filter(w => w.length > 0)
      .join(' ');

    // Fire onSentenceStart immediately so the first word highlights while audio loads
    if (this.onSentenceStart) this.onSentenceStart(sentenceIndex);

    try {
      // Route through background service worker to avoid per-site permission prompts.
      // Background validates localhost and returns JSON (base64 audio + timestamps).
      const data = await chrome.runtime.sendMessage({
        type: 'kokoroTTS',
        text: kokoroText,
        endpoint,
        voice: this.settings.kokoroVoice || 'af_alloy',
        speed: this.settings.rate || 1.0,
      });

      // Bail if cancelled (settings change / stop / skip) while fetch was in-flight
      if (this._cancelGen !== gen) return;
      if (this.state !== 'playing' || this.currentIndex !== sentenceIndex) return;

      if (!data || data.error) {
        console.warn('Kokoro TTS error:', data?.error || 'No response');
        this._handleKokoroFailure();
        return;
      }

      // Success - reset failure counter and clear any error shown in the popup
      if (this._kokoroFailCount > 0) {
        this._kokoroFailCount = 0;
        this._setState('playing');
      }

      // Validate and cap payload to prevent OOM from malicious responses
      if (!data.audio || data.audio.length > 15_000_000) {
        console.warn('Kokoro TTS: audio payload missing or too large');
        this._handleKokoroFailure();
        return;
      }

      // Decode base64 audio
      const raw = atob(data.audio);
      const bytes = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);

      // Build word positions (charIndex/charLength in the sentence text)
      this._wordPositions = this._computeWordPositions(text);

      // Build word timing from API timestamps (capped to prevent DoS)
      const timestamps = (data.timestamps || []).slice(0, 5000);
      this._wordTimestamps = this._buildWordTimestamps(timestamps);

      if (this._cspFallback) {
        await this._kokoroPlayAudioCtx(bytes, sentenceIndex, gen);
      } else {
        this._kokoroPlayAudio(bytes, data.audio_format, sentenceIndex, gen);
      }
    } catch (err) {
      console.warn('Kokoro TTS request failed:', err);
      this._handleKokoroFailure();
    }
  }

  // --- Kokoro playback paths ---

  /** Primary path: play via HTMLAudioElement (low memory, streaming decode). */
  _kokoroPlayAudio(bytes, audioFormat, sentenceIndex, gen) {
    const AUDIO_TYPES = ['audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/flac', 'audio/mp3'];
    const mimeType = AUDIO_TYPES.includes(audioFormat) ? audioFormat : 'audio/mpeg';
    const blob = new Blob([bytes], { type: mimeType });
    const blobUrl = URL.createObjectURL(blob);
    this._blobUrl = blobUrl;

    const audio = new Audio(blobUrl);
    this._audio = audio;
    audio.volume = this.settings.volume;

    // Fallback: estimate timestamps from audio duration if API provided none
    audio.onloadedmetadata = () => {
      if (this._audio !== audio) return;
      if (this._wordTimestamps.length === 0 && this._wordPositions.length > 0 && audio.duration > 0) {
        this._wordTimestamps = this._estimateWordTimestamps(audio.duration);
      }
    };

    // Start word sync only when audio actually begins playing
    audio.addEventListener('playing', () => {
      if (this._audio === audio) this._startWordSync(sentenceIndex);
    }, { once: true });

    // Guard all callbacks: _stopKokoroPlayback sets this._audio = null
    // before the old element's async events fire, so checking identity
    // prevents double-advancing.
    audio.onended = () => {
      if (this._audio !== audio) return;
      this._clearWordTimer();
      this._revokeBlobUrl();
      this._audio = null;
      if (this.state === 'playing' && this.currentIndex === sentenceIndex) {
        this._speakNext();
      }
    };

    audio.onerror = () => {
      if (this._audio !== audio) return;
      console.info('Kokoro: Audio element blocked by page CSP — using AudioContext fallback');
      this._clearWordTimer();
      this._revokeBlobUrl();
      this._audio = null;
      // Retry this sentence via AudioContext; bytes.buffer is still valid
      this._kokoroPlayAudioCtx(bytes, sentenceIndex, gen);
    };

    audio.play().catch((err) => {
      if (err.name === 'AbortError' || this._audio !== audio) return;
      console.info('Kokoro: audio.play() blocked by page CSP — using AudioContext fallback');
      this._clearWordTimer();
      this._revokeBlobUrl();
      this._audio = null;
      this._kokoroPlayAudioCtx(bytes, sentenceIndex, gen);
    });
  }

  /** CSP fallback: play via AudioContext.decodeAudioData (bypasses media-src). */
  async _kokoroPlayAudioCtx(bytes, sentenceIndex, gen) {
    try {
      const audioCtx = this._getOrCreateAudioCtx();
      if (audioCtx.state === 'suspended') await audioCtx.resume();

      const audioBuffer = await audioCtx.decodeAudioData(bytes.buffer);

      // Async boundary — re-check cancel/state
      if (this._cancelGen !== gen) return;
      if (this.state !== 'playing' || this.currentIndex !== sentenceIndex) return;

      // Fallback: estimate timestamps from decoded duration if API provided none
      if (this._wordTimestamps.length === 0 && this._wordPositions.length > 0 && audioBuffer.duration > 0) {
        this._wordTimestamps = this._estimateWordTimestamps(audioBuffer.duration);
      }

      // Create one-shot source node for this sentence
      const sourceNode = audioCtx.createBufferSource();
      sourceNode.buffer = audioBuffer;
      sourceNode.connect(this._gainNode);
      this._sourceNode = sourceNode;
      this._playbackStartTime = audioCtx.currentTime;

      sourceNode.onended = () => {
        if (this._sourceNode !== sourceNode) return;
        this._clearWordTimer();
        this._sourceNode = null;
        if (this.state === 'playing' && this.currentIndex === sentenceIndex) {
          this._speakNext();
        }
      };

      sourceNode.start();
      this._cspFallback = true; // Confirmed: Audio blocked, AudioCtx works
      this._startWordSync(sentenceIndex);
    } catch (err) {
      console.warn('Kokoro AudioContext fallback failed:', err);
      this._handleKokoroFailure();
    }
  }

  /** Shared failure handler: count consecutive errors, stop after 3. */
  _handleKokoroFailure() {
    this._kokoroFailCount++;
    if (this._kokoroFailCount >= 3) {
      if (this.onError) this.onError('Kokoro TTS not responding. Is the service running?');
      this.stop();
      return;
    }
    if (this.onError) this.onError(`Kokoro TTS: connection failed, retrying... (${this._kokoroFailCount}/3)`);
    if (this.state === 'playing') this._speakNext();
  }

  // --- Word sync (shared by real timestamps and estimation) ---

  /** Build [{charIndex, charLength}] for each word in the sentence text.
   *  Skips punctuation-only tokens to stay aligned with API word entries. */
  _computeWordPositions(text) {
    const positions = [];
    const regex = /\S+/g;
    let match;
    while ((match = regex.exec(text)) !== null) {
      if (/\w/.test(match[0])) {
        positions.push({ charIndex: match.index, charLength: match[0].length });
      }
    }
    return positions;
  }

  /**
   * Map API timestamps to our word positions.
   * Uses forward scan with text-matching lookahead to handle normalization
   * (e.g. "42"→"forty-two", "$50"→"fifty dollars") without losing sync.
   */
  _buildWordTimestamps(allTimestamps) {
    if (allTimestamps.length === 0 || this._wordPositions.length === 0) return [];

    const apiWords = allTimestamps.filter(t => typeof t.word === 'string' && /\w/.test(t.word));
    if (apiWords.length === 0) return [];

    // Pre-clean API words once instead of per-comparison in the lookahead
    const apiClean = apiWords.map(t => t.word.replace(/[^\w]/g, '').toLowerCase());

    const text = this.queue[this.currentIndex];
    const result = [];
    let apiIdx = 0;

    for (let i = 0; i < this._wordPositions.length && apiIdx < apiWords.length; i++) {
      result.push(apiWords[apiIdx].start_time);
      apiIdx++;

      // Lookahead: find where the NEXT text token appears in the API words.
      // This skips over expanded words (e.g. "#3"→"number","three")
      // so the next position re-syncs to the correct API entry.
      if (i + 1 < this._wordPositions.length && apiIdx < apiWords.length) {
        const nextPos = this._wordPositions[i + 1];
        const nextClean = text.substr(nextPos.charIndex, nextPos.charLength)
          .replace(/[^\w]/g, '').toLowerCase();

        const maxLook = Math.min(apiIdx + 10, apiWords.length);
        for (let j = apiIdx; j < maxLook; j++) {
          if (apiClean[j] === nextClean) {
            apiIdx = j;
            break;
          }
        }
      }
    }

    // Interpolate remaining positions when API had fewer words than text
    this._interpolateTimestamps(result, apiWords);
    return result;
  }

  /** Fill remaining word positions with char-length-weighted timestamps. */
  _interpolateTimestamps(result, apiWords) {
    const total = this._wordPositions.length;
    if (result.length >= total) return;

    const lastTime = result.length > 0 ? result[result.length - 1] : 0;
    const endTime = apiWords.length > 0
      ? (apiWords[apiWords.length - 1].end_time || lastTime * 1.15)
      : lastTime;
    const gap = Math.max(0, endTime - lastTime);
    const remaining = this._wordPositions.slice(result.length);
    const remChars = remaining.reduce((s, p) => s + p.charLength, 0) || 1;
    let cum = 0;
    for (const pos of remaining) {
      result.push(lastTime + (cum / remChars) * gap);
      cum += pos.charLength;
    }
  }

  /** Fallback: estimate start times weighted by character length. */
  _estimateWordTimestamps(duration) {
    const totalChars = this._wordPositions.reduce((sum, p) => sum + p.charLength, 0);
    let cumChars = 0;
    return this._wordPositions.map(p => {
      const t = (cumChars / totalChars) * duration;
      cumChars += p.charLength;
      return t;
    });
  }

  /** RAF loop: sync highlight to playback time using word timestamps. */
  _startWordSync(sentenceIndex, resetHighlight = true) {
    this._clearWordTimer();
    this._wordTimerSentence = sentenceIndex;
    if (resetHighlight) this._lastHighlightedIdx = -1;

    const tick = () => {
      if ((!this._audio && !this._sourceNode) || this.state !== 'playing') return;

      const t = this._audio
        ? this._audio.currentTime
        : this._audioCtx.currentTime - this._playbackStartTime;
      const ts = this._wordTimestamps;

      // Forward scan from last position — audio time only moves forward,
      // so we never need to re-check earlier timestamps.
      // Advance at most 1 word per tick so every word gets at least one
      // frame of highlight even when timestamps are clustered/duplicated.
      let idx = Math.max(0, this._lastHighlightedIdx);
      if (idx + 1 < ts.length && t >= ts[idx + 1]) idx++;

      if (idx !== this._lastHighlightedIdx && idx < this._wordPositions.length) {
        this._lastHighlightedIdx = idx;
        const pos = this._wordPositions[idx];
        if (this.onBoundary) {
          this.onBoundary(pos.charIndex, pos.charLength, this._wordTimerSentence);
        }
      }

      this._wordTimerRAF = requestAnimationFrame(tick);
    };

    this._wordTimerRAF = requestAnimationFrame(tick);
  }

  /** Restart the RAF loop after pause — preserves highlight position. */
  _resumeWordTimer() {
    if (!this._wordPositions.length || (!this._audio && !this._sourceNode)) return;
    this._startWordSync(this._wordTimerSentence, false);
  }

  _clearWordTimer() {
    if (this._wordTimerRAF) {
      cancelAnimationFrame(this._wordTimerRAF);
      this._wordTimerRAF = null;
    }
  }

  _getOrCreateAudioCtx() {
    if (!this._audioCtx) {
      this._audioCtx = new AudioContext();
      this._gainNode = this._audioCtx.createGain();
      this._gainNode.connect(this._audioCtx.destination);
    }
    this._gainNode.gain.value = this.settings.volume;
    return this._audioCtx;
  }

  _revokeBlobUrl() {
    if (this._blobUrl) {
      URL.revokeObjectURL(this._blobUrl);
      this._blobUrl = null;
    }
  }

  _stopKokoroPlayback() {
    this._clearWordTimer();
    if (this._audio) {
      const a = this._audio;
      this._audio = null;
      a.onended = null;
      a.onerror = null;
      a.onloadedmetadata = null;
      a.pause();
      a.removeAttribute('src');
      a.load();
    }
    if (this._sourceNode) {
      const s = this._sourceNode;
      this._sourceNode = null;       // nullify BEFORE stop (identity guard)
      s.onended = null;
      try { s.stop(); } catch (e) {} // throws if already stopped
      s.disconnect();
    }
    this._revokeBlobUrl();
  }
}
