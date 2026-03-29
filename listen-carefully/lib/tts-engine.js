/**
 * TTS Engine - supports both Web Speech Synthesis API and Kokoro (OpenAI-compatible) TTS.
 *
 * Browser backend: wraps speechSynthesis with sentence-level queue management.
 * Kokoro backend: fetches audio from local API, plays via Audio element,
 * and estimates word boundaries for highlighting.
 *
 * Chromium silently stops long utterances (~15s), so the browser backend
 * chunks text into sentences and feeds them one at a time.
 */

class TTSEngine {
  constructor() {
    this.queue = [];
    this.currentIndex = -1;
    this.currentUtterance = null;
    this.state = 'stopped'; // 'stopped' | 'playing' | 'paused'
    this._skipping = false; // Guards against cancel() triggering onend during skip
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
    this._audio = null;
    this._blobUrl = null;           // tracked for revocation on stop/skip
    this._kokoroFailCount = 0;      // consecutive failures - stops after 3
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

  getVoicesGroupedByLang() {
    const groups = {};
    for (const voice of this.voices) {
      const lang = voice.lang;
      if (!groups[lang]) groups[lang] = [];
      groups[lang].push(voice);
    }
    return groups;
  }

  _findVoice(uri) {
    return this.voices.find(v => v.voiceURI === uri) || null;
  }

  /** Cancel both backends - safe to call regardless of active backend. */
  _cancelAll() {
    this._stopKokoroPlayback();
    this._skipping = true;
    speechSynthesis.cancel();
    this._skipping = false;
  }

  /**
   * Update TTS settings. If currently playing, restarts the current sentence
   * so the new voice/rate/pitch/volume takes effect immediately.
   */
  static _SETTINGS_KEYS = [
    'voiceURI', 'rate', 'pitch', 'volume', 'ttsBackend',
    'kokoroEndpoint', 'kokoroVoice',
  ];

  updateSettings(settings) {
    const wasPlaying = this.state === 'playing';
    const prevRate = this.settings.rate;
    const prevVoice = this.settings.kokoroVoice;
    const prevEndpoint = this.settings.kokoroEndpoint;
    const prevBackend = this.settings.ttsBackend;

    // Allowlist keys to prevent prototype pollution
    for (const k of TTSEngine._SETTINGS_KEYS) {
      if (k in settings) this.settings[k] = settings[k];
    }

    if (this.state === 'paused') {
      this._settingsChangedWhilePaused = true;
    }

    // Restart current sentence so new settings apply immediately.
    if (wasPlaying && this.queue.length > 0) {
      // Kokoro: volume is client-side, update instantly without re-fetching
      if (this._isKokoro && this._audio) {
        this._audio.volume = this.settings.volume;
        const needsRefetch = this.settings.rate !== prevRate
          || this.settings.kokoroVoice !== prevVoice
          || this.settings.kokoroEndpoint !== prevEndpoint
          || this.settings.ttsBackend !== prevBackend;
        if (!needsRefetch) return;
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
    this.currentUtterance = null;
    this._kokoroFailCount = 0;
    this._setState('playing');
    this._speakNext();
  }

  /**
   * Resume from a specific sentence index (used for skip).
   */
  playFromIndex(sentences, index) {
    this._cancelAll();
    this.queue = sentences;
    this.currentIndex = index - 1;
    this._kokoroFailCount = 0;
    this._setState('playing');
    this._speakNext();
  }

  pause() {
    if (this.state !== 'playing') return;
    if (this._isKokoro) {
      if (this._audio) this._audio.pause();
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

    if (this._isKokoro && this._audio) {
      this._audio.play();
      this._resumeWordTimer();
    } else {
      speechSynthesis.resume();
    }
  }

  stop() {
    this._cancelAll();
    this.queue = [];
    this.currentIndex = -1;
    this.currentUtterance = null;
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
      this._setState('playing');
      this._speakNext();
    }
  }

  skipPrev() {
    if (this.currentIndex > 0) {
      this._cancelAll();
      this.currentIndex -= 2; // -2 because _speakNext increments by 1
      this._setState('playing');
      this._speakNext();
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
      if (event.name === 'word' && this.onBoundary) {
        this.onBoundary(event.charIndex, event.charLength, sentenceIndex);
      }
    };

    utterance.onend = () => {
      if (this.state === 'playing' && !this._skipping) {
        this._speakNext();
      }
    };

    utterance.onerror = (event) => {
      // 'interrupted' and 'canceled' are expected during skip/stop
      if (event.error !== 'interrupted' && event.error !== 'canceled') {
        console.warn('TTS utterance error:', event.error);
      }
    };

    this.currentUtterance = utterance;
    if (this.onSentenceStart) this.onSentenceStart(sentenceIndex);
    speechSynthesis.speak(utterance);
  }

  // --- Kokoro (API) backend ---

  /** Only allow fetches to loopback addresses. */
  static _isLocalhostURL(urlStr) {
    try {
      const url = new URL(urlStr);
      return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    } catch {
      return false;
    }
  }

  async _speakNextKokoro() {
    const text = this.queue[this.currentIndex];
    const sentenceIndex = this.currentIndex;
    const endpoint = (this.settings.kokoroEndpoint || 'http://localhost:8880').replace(/\/+$/, '');

    // Fire onSentenceStart immediately so the first word highlights while audio loads
    if (this.onSentenceStart) this.onSentenceStart(sentenceIndex);

    if (!TTSEngine._isLocalhostURL(endpoint)) {
      if (this.onError) this.onError('Kokoro endpoint must be a localhost address.');
      this.stop();
      return;
    }

    try {
      // Use captioned_speech for word-level timestamps; falls back gracefully
      const fetchResponse = await fetch(`${endpoint}/dev/captioned_speech`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'kokoro',
          voice: this.settings.kokoroVoice || 'af_alloy',
          input: text,
          speed: this.settings.rate || 1.0,
          response_format: 'mp3',
          stream: false,
          return_timestamps: true,
        }),
      });

      // Bail if we were stopped/skipped while waiting for the API
      if (this.state !== 'playing' || this.currentIndex !== sentenceIndex) return;

      if (!fetchResponse.ok) {
        console.warn('Kokoro TTS error:', fetchResponse.status, fetchResponse.statusText);
        this._handleKokoroFailure();
        return;
      }

      // Success - reset failure counter
      this._kokoroFailCount = 0;

      const data = await fetchResponse.json();

      // Bail if stopped/skipped during JSON parsing
      if (this.state !== 'playing' || this.currentIndex !== sentenceIndex) return;

      // Validate and cap payload to prevent OOM from malicious responses
      if (!data.audio || data.audio.length > 15_000_000) {
        console.warn('Kokoro TTS: audio payload missing or too large');
        this._handleKokoroFailure();
        return;
      }

      // Decode base64 audio → Blob with allowlisted MIME type
      const raw = atob(data.audio);
      const bytes = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
      const AUDIO_TYPES = ['audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/flac', 'audio/mp3'];
      const mimeType = AUDIO_TYPES.includes(data.audio_format) ? data.audio_format : 'audio/mpeg';
      const blob = new Blob([bytes], { type: mimeType });
      const blobUrl = URL.createObjectURL(blob);
      this._blobUrl = blobUrl;

      // Build word positions (charIndex/charLength in the sentence text)
      this._wordPositions = this._computeWordPositions(text);

      // Build word timing from API timestamps (capped to prevent DoS)
      const timestamps = (data.timestamps || []).slice(0, 5000);
      this._wordTimestamps = this._buildWordTimestamps(timestamps);

      const audio = new Audio(blobUrl);
      this._audio = audio;
      audio.volume = this.settings.volume;

      // Fallback: estimate timestamps from audio duration if API provided none
      audio.onloadedmetadata = () => {
        if (this._wordTimestamps.length === 0 && this._wordPositions.length > 0 && audio.duration > 0) {
          this._wordTimestamps = this._estimateWordTimestamps(audio.duration);
        }
      };

      // Start word sync only when audio actually begins playing
      audio.addEventListener('playing', () => {
        this._startWordSync(sentenceIndex);
      }, { once: true });

      audio.onended = () => {
        this._clearWordTimer();
        this._revokeBlobUrl();
        this._audio = null;
        if (this.state === 'playing' && this.currentIndex === sentenceIndex) {
          this._speakNext();
        }
      };

      audio.onerror = () => {
        console.warn('Kokoro audio playback error');
        this._clearWordTimer();
        this._revokeBlobUrl();
        this._audio = null;
        this._handleKokoroFailure();
      };

      audio.play().catch(() => {
        this._clearWordTimer();
        this._revokeBlobUrl();
        this._audio = null;
        this._handleKokoroFailure();
      });
    } catch (err) {
      console.warn('Kokoro TTS request failed:', err);
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

    const apiWords = allTimestamps.filter(t => /\w/.test(t.word));
    if (apiWords.length === 0) return [];

    const text = this.queue[this.currentIndex];
    const result = [];
    let apiIdx = 0;

    for (let i = 0; i < this._wordPositions.length; i++) {
      if (apiIdx >= apiWords.length) {
        result.push(result.length > 0 ? result[result.length - 1] : 0);
        continue;
      }

      // Take current API word's start_time for this position
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
          if (apiWords[j].word.replace(/[^\w]/g, '').toLowerCase() === nextClean) {
            apiIdx = j;
            break;
          }
        }
      }
    }

    return result;
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

  /** RAF loop: sync highlight to audio.currentTime using word timestamps. */
  _startWordSync(sentenceIndex) {
    this._clearWordTimer();
    this._wordTimerSentence = sentenceIndex;
    this._lastHighlightedIdx = -1;

    const tick = () => {
      if (!this._audio || this.state !== 'playing') return;

      const t = this._audio.currentTime;

      // Find the last word whose start_time <= currentTime
      let idx = 0;
      for (let i = this._wordTimestamps.length - 1; i >= 0; i--) {
        if (t >= this._wordTimestamps[i]) { idx = i; break; }
      }

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

  /** Restart the RAF loop after pause — self-syncs via audio.currentTime. */
  _resumeWordTimer() {
    if (!this._wordPositions.length || !this._audio) return;
    this._startWordSync(this._wordTimerSentence);
  }

  _clearWordTimer() {
    if (this._wordTimerRAF) {
      cancelAnimationFrame(this._wordTimerRAF);
      this._wordTimerRAF = null;
    }
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
      this._audio.pause();
      this._audio.removeAttribute('src');
      this._audio.load();
      this._audio = null;
    }
    this._revokeBlobUrl();
  }
}
