/**
 * Highlighter - wraps words in spans and highlights the current word during TTS playback.
 *
 * This is the source of truth for the word list. The flow is:
 *   1. prepare(container, skipSelectors, range?) - walk DOM, wrap words, skip unwanted
 *      elements. If a Range is provided (selection mode), only spans whose source text
 *      node intersects the range are kept.
 *   2. getSentences() - returns sentences derived from the actual wrapped spans,
 *      using block-element boundaries as sentence breaks
 *   3. highlightWord() - highlight the correct span during playback
 *
 * Highlighting maps by word-span INDEX, never by text matching.
 */

class Highlighter {
  static BLOCK_TAGS = new Set([
    'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'LI', 'DIV', 'BLOCKQUOTE', 'SECTION', 'ARTICLE',
    'TR', 'DT', 'DD', 'FIGCAPTION', 'TH', 'TD',
  ]);

  constructor() {
    this.wordSpans = [];
    this.blockBreaks = new Set();
    this.sentenceMap = [];
    this.currentSpan = null;
    this._currentSentenceSpans = null;
    this.isActive = false;
    this.container = null;
    this.skipSelectors = [];
    this._selectedTextNodes = null;
    this.focusMode = 'off';
    this.settings = {
      highlightBg: '#FFEB3B',
      highlightFg: '#000000',
      neonHighlight: true,
    };
  }

  static _validHex(str) {
    return /^#(?:[A-Fa-f0-9]{3}|[A-Fa-f0-9]{4}|[A-Fa-f0-9]{6}|[A-Fa-f0-9]{8})$/.test(str) ? str : null;
  }

  updateSettings(settings) {
    if (settings.highlightBg) {
      settings.highlightBg = Highlighter._validHex(settings.highlightBg) || this.settings.highlightBg;
    }
    if (settings.highlightFg) {
      settings.highlightFg = Highlighter._validHex(settings.highlightFg) || this.settings.highlightFg;
    }
    Object.assign(this.settings, settings);
    this._updateHighlightStyle();
  }

  /**
   * Wrap each word in the container in a <span>.
   *
   * @param {Element}  container     - DOM element containing the text
   * @param {string[]} skipSelectors - CSS selectors for elements to skip
   * @param {Range}    [range]       - if provided, only keep spans from text nodes
   *                                   that intersect this Range (selection mode)
   */
  prepare(container, skipSelectors, range) {
    this.cleanup();
    this.container = container;
    this.isActive = true;
    this.wordSpans = [];
    this.blockBreaks = new Set();
    this.sentenceMap = [];
    this.skipSelectors = skipSelectors || [];

    // Store the range for post-wrap filtering
    this._selectionRange = range || null;
    this._selectedTextNodes = null;

    this._wrapWords(container);

    // Selection mode: discard spans outside the selection range.
    // Now that words are individual spans, we can check each one precisely.
    if (this._selectionRange) {
      this.wordSpans = this.wordSpans.filter(s => this._selectionRange.intersectsNode(s));
      for (let i = 0; i < this.wordSpans.length; i++) {
        this.wordSpans[i].dataset.wordIndex = i;
      }
      this._selectionRange = null;
    }

    this._detectBlockBreaks();

    // Add focus class to dim non-active words (only in focus mode)
    if (this.focusMode && this.focusMode !== 'off' && this.container) {
      this.container.classList.add('tts-reading');
    }
  }

  /**
   * Build sentences from the wrapped word spans.
   *
   * Flushes a new sentence when:
   *   - a block break is reached (different <p>, <h*>, <li>, etc.)
   *   - a word ends with sentence-ending punctuation (.!?:;)
   *   - end of spans
   *
   * Word count per sentence always equals the span count it covers.
   */
  /**
   * @param {Object} [options]
   * @param {boolean} [options.punctuationPauses=true] - when true, punctuation
   *   (.!?:;) forces a sentence break (separate utterance = pause). When false,
   *   only block-element boundaries create breaks, letting the TTS voice handle
   *   punctuation pauses naturally.
   */
  getSentences(options) {
    const punctuationPauses = options?.punctuationPauses !== false;

    if (this.wordSpans.length === 0) return [];

    const sentences = [];
    this.sentenceMap = [];
    let currentWords = [];
    let startIdx = 0;

    for (let i = 0; i < this.wordSpans.length; i++) {
      currentWords.push(this.wordSpans[i].textContent);

      const isLastSpan = (i === this.wordSpans.length - 1);
      const isBlockBreak = this.blockBreaks.has(i);
      const endsWithPunctuation = punctuationPauses &&
        /[.!?:;]$/.test(this.wordSpans[i].textContent);

      if (isLastSpan || isBlockBreak || endsWithPunctuation) {
        const text = currentWords.join(' ');
        sentences.push(text);
        this.sentenceMap.push({
          startWordIndex: startIdx,
          wordCount: currentWords.length,
          text: text,
        });
        startIdx = i + 1;
        currentWords = [];
      }
    }

    return sentences;
  }

  // --- DOM walking and wrapping ---

  _wrapWords(container) {
    const self = this;

    const walker = document.createTreeWalker(
      container,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;

          const tag = parent.tagName;
          if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') {
            return NodeFilter.FILTER_REJECT;
          }

          // Skip text inside elements that are not visible (hidden tabs,
          // collapsed accordions, display:none sections, etc.)
          if (typeof parent.checkVisibility === 'function' && !parent.checkVisibility()) {
            return NodeFilter.FILTER_REJECT;
          }

          for (const sel of self.skipSelectors) {
            const match = parent.closest(sel);
            if (match && container.contains(match) && match !== container) {
              return NodeFilter.FILTER_REJECT;
            }
          }

          if (!node.textContent.trim()) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    const textNodes = [];
    while (walker.nextNode()) {
      textNodes.push(walker.currentNode);
    }

    for (const textNode of textNodes) {
      const text = textNode.textContent;
      if (!text.trim()) continue;

      const parent = textNode.parentElement;
      if (parent.classList && parent.classList.contains('tts-word')) continue;

      const fragment = document.createDocumentFragment();
      const parts = text.split(/(\s+)/);

      for (const part of parts) {
        if (/^\s+$/.test(part) || part === '') {
          fragment.appendChild(document.createTextNode(part));
        } else {
          const span = document.createElement('span');
          span.className = 'tts-word';
          span.dataset.wordIndex = this.wordSpans.length;
          span.textContent = part;
          this.wordSpans.push(span);
          fragment.appendChild(span);
        }
      }

      parent.replaceChild(fragment, textNode);
    }
  }

  // --- Block break detection ---

  _getBlockAncestor(el) {
    let current = el;
    while (current && current !== this.container) {
      if (Highlighter.BLOCK_TAGS.has(current.tagName)) return current;
      current = current.parentElement;
    }
    return this.container;
  }

  _detectBlockBreaks() {
    this.blockBreaks = new Set();
    if (this.wordSpans.length < 2) return;

    let prevBlock = this._getBlockAncestor(this.wordSpans[0]);

    for (let i = 1; i < this.wordSpans.length; i++) {
      const curBlock = this._getBlockAncestor(this.wordSpans[i]);
      if (curBlock !== prevBlock) {
        this.blockBreaks.add(i - 1);
      }
      prevBlock = curBlock;
    }
  }

  /**
   * Find all word spans on the same visual (rendered) line as the given word.
   * Uses getBoundingClientRect to detect which words share the same vertical position.
   */
  _getVisualLineSpans(wordIndex) {
    const span = this.wordSpans[wordIndex];
    const rect = span.getBoundingClientRect();
    const top = rect.top;
    const tolerance = rect.height * 0.5;

    const lineSpans = [span];

    // Walk backward to find line start
    for (let i = wordIndex - 1; i >= 0; i--) {
      const r = this.wordSpans[i].getBoundingClientRect();
      if (Math.abs(r.top - top) <= tolerance) {
        lineSpans.unshift(this.wordSpans[i]);
      } else {
        break;
      }
    }

    // Walk forward to find line end
    for (let i = wordIndex + 1; i < this.wordSpans.length; i++) {
      const r = this.wordSpans[i].getBoundingClientRect();
      if (Math.abs(r.top - top) <= tolerance) {
        lineSpans.push(this.wordSpans[i]);
      } else {
        break;
      }
    }

    return lineSpans;
  }

  // --- Highlighting ---

  highlightWord(charIndex, charLength, sentenceIndex) {
    if (!this.isActive || sentenceIndex >= this.sentenceMap.length) return;

    const info = this.sentenceMap[sentenceIndex];
    const sentenceText = info.text;

    const words = sentenceText.split(/\s+/).filter(w => w.length > 0);
    let offset = 0;
    let wordIndexInSentence = -1;

    for (let i = 0; i < words.length; i++) {
      const wordStart = sentenceText.indexOf(words[i], offset);
      if (charIndex >= wordStart && charIndex < wordStart + words[i].length) {
        wordIndexInSentence = i;
        break;
      }
      offset = wordStart + words[i].length;
    }

    if (wordIndexInSentence < 0) {
      this._applyHighlight(-1);
      return;
    }

    const globalWordIndex = info.startWordIndex + wordIndexInSentence;
    this._applyHighlight(globalWordIndex);
  }

  _applyHighlight(wordIndex) {
    // Clear previous word highlight
    if (this.currentSpan) {
      this.currentSpan.classList.remove('tts-word-active');
      this.currentSpan.style.backgroundColor = '';
      this.currentSpan.style.color = '';
      this.currentSpan.style.boxShadow = '';
    }

    // Clear previous sentence highlight
    if (this._currentSentenceSpans) {
      for (const s of this._currentSentenceSpans) {
        s.classList.remove('tts-sentence-active');
      }
      this._currentSentenceSpans = null;
    }

    if (wordIndex >= 0 && wordIndex < this.wordSpans.length) {
      // Focus mode: highlight surrounding context
      if (this.focusMode === 'sentence') {
        for (const info of this.sentenceMap) {
          if (wordIndex >= info.startWordIndex && wordIndex < info.startWordIndex + info.wordCount) {
            this._currentSentenceSpans = this.wordSpans.slice(info.startWordIndex, info.startWordIndex + info.wordCount);
            for (const s of this._currentSentenceSpans) {
              s.classList.add('tts-sentence-active');
            }
            break;
          }
        }
      } else if (this.focusMode === 'line') {
        this._currentSentenceSpans = this._getVisualLineSpans(wordIndex);
        for (const s of this._currentSentenceSpans) {
          s.classList.add('tts-sentence-active');
        }
      }

      // Highlight the active word
      const span = this.wordSpans[wordIndex];
      span.classList.add('tts-word-active');
      const bg = this.settings.highlightBg;
      span.style.backgroundColor = bg;
      span.style.color = this.settings.highlightFg;
      if (this.settings.neonHighlight) {
        span.style.boxShadow = `0 0 4px ${bg}80, 0 0 9px ${bg}80, 0 0 18px ${bg}80, 0 2px 8px rgba(0,0,0,0.3)`;
      }
      this.currentSpan = span;
      this._scrollToSpan(span);
    }
  }

  _scrollToSpan(span) {
    const rect = span.getBoundingClientRect();
    const viewportHeight = window.innerHeight;

    if (rect.top < viewportHeight * 0.2 || rect.bottom > viewportHeight * 0.8) {
      span.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  _updateHighlightStyle() {
    if (this.currentSpan) {
      const bg = this.settings.highlightBg;
      this.currentSpan.style.backgroundColor = bg;
      this.currentSpan.style.color = this.settings.highlightFg;
      if (this.settings.neonHighlight) {
        this.currentSpan.style.boxShadow = `0 0 4px ${bg}80, 0 0 9px ${bg}80, 0 0 18px ${bg}80, 0 2px 8px rgba(0,0,0,0.3)`;
      } else {
        this.currentSpan.style.boxShadow = '';
      }
    }
  }

  // --- Cleanup ---

  cleanup() {
    if (this.currentSpan) {
      this.currentSpan.classList.remove('tts-word-active');
      this.currentSpan.style.boxShadow = '';
      this.currentSpan = null;
    }
    if (this._currentSentenceSpans) {
      for (const s of this._currentSentenceSpans) s.classList.remove('tts-sentence-active');
      this._currentSentenceSpans = null;
    }

    // Remove focus dimming
    if (this.container) this.container.classList.remove('tts-reading');

    const allSpans = document.querySelectorAll('.tts-word');
    for (const span of allSpans) {
      const parent = span.parentNode;
      if (parent) {
        parent.replaceChild(document.createTextNode(span.textContent), span);
        parent.normalize();
      }
    }

    this.wordSpans = [];
    this.blockBreaks = new Set();
    this.sentenceMap = [];
    this.isActive = false;
    this.container = null;
    this._selectedTextNodes = null;
  }
}
