/**
 * TTS Engine - wraps Web Speech Synthesis API with sentence-level queue management.
 * Chromium silently stops long utterances (~15s), so we chunk text into sentences
 * and feed them one at a time.
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
    };

    // Callbacks - set by content.js
    this.onBoundary = null;   // (charIndex, charLength, sentenceIndex) => void
    this.onStateChange = null; // (state) => void
    this.onSentenceStart = null; // (sentenceIndex) => void
    this.onEnd = null;         // () => void

    this._loadVoices();
    speechSynthesis.addEventListener('voiceschanged', () => this._loadVoices());
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

  /**
   * Update TTS settings. If currently playing, restarts the current sentence
   * so the new voice/rate/pitch/volume takes effect immediately.
   */
  updateSettings(settings) {
    const wasPlaying = this.state === 'playing';
    Object.assign(this.settings, settings);

    if (wasPlaying && this.queue.length > 0) {
      // Restart current sentence with new settings
      const idx = this.currentIndex;
      this._skipping = true;
      speechSynthesis.cancel();
      this._skipping = false;
      this.currentIndex = idx - 1; // _speakNext increments
      this._speakNext();
    }
  }

  /**
   * Load sentences into the queue and start playing.
   */
  play(sentences) {
    if (this.state === 'paused' && this.queue.length > 0) {
      this.resume();
      return;
    }

    // Cancel previous playback without triggering onEnd.
    // stop() fires onEnd which cleans up the highlighter - we must NOT do
    // that here because the caller has already set up new highlight state.
    this._skipping = true;
    speechSynthesis.cancel();
    this._skipping = false;

    this.queue = sentences;
    this.currentIndex = -1;
    this.currentUtterance = null;
    this._setState('playing');
    this._speakNext();
  }

  /**
   * Resume from a specific sentence index (used for skip).
   */
  playFromIndex(sentences, index) {
    this._skipping = true;
    speechSynthesis.cancel();
    this._skipping = false;
    this.queue = sentences;
    this.currentIndex = index - 1;
    this._setState('playing');
    this._speakNext();
  }

  pause() {
    if (this.state !== 'playing') return;
    speechSynthesis.pause();
    this._setState('paused');
  }

  resume() {
    if (this.state !== 'paused') return;
    speechSynthesis.resume();
    this._setState('playing');
  }

  stop() {
    this._skipping = true;
    speechSynthesis.cancel();
    this._skipping = false;
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
      this._skipping = true;
      speechSynthesis.cancel();
      this._skipping = false;
      this._setState('playing');
      this._speakNext();
    }
  }

  skipPrev() {
    if (this.currentIndex > 0) {
      this._skipping = true;
      speechSynthesis.cancel();
      this.currentIndex -= 2; // -2 because _speakNext increments by 1
      this._skipping = false;
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

  _speakNext() {
    this.currentIndex++;

    if (this.currentIndex >= this.queue.length) {
      this._setState('stopped');
      if (this.onEnd) this.onEnd();
      return;
    }

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
}
