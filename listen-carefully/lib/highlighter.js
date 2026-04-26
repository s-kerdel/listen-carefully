/**
 * Highlighter - paints the active word during TTS playback via the CSS
 * Custom Highlight API. The page DOM is never mutated.
 *
 * Flow: prepare() walks the DOM and records a word list → getSentences()
 * builds sentences from that list → highlightWord() maps boundary events
 * to word indexes and paints via CSS.highlights. Mapping is always by
 * index, never by text match, so punctuation can't cause drift.
 */

class Highlighter {
  static BLOCK_TAGS = new Set([
    'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'LI', 'DIV', 'BLOCKQUOTE', 'SECTION', 'ARTICLE',
    'TR', 'DT', 'DD', 'FIGCAPTION', 'TH', 'TD',
  ]);

  static HIGHLIGHT_WORD = 'lc-word-active';
  static HIGHLIGHT_SENTENCE = 'lc-sentence-active';
  static HIGHLIGHT_DIM = 'lc-dim';
  static FOCUS_CLASS = 'lc-focus-active';
  static VALID_MARKER_STYLES = new Set(['color-underline', 'color-underline-continuous', 'color', 'bg-only']);
  // 'bg-only' uses the default ::highlight() rules directly - no class.
  static _MARKER_CLASS_BY_STYLE = {
    'color': 'lc-word-color',
    'color-underline': 'lc-word-color-underline',
    'color-underline-continuous': 'lc-word-color-underline-continuous',
  };

  constructor() {
    this.words = [];           // [{node, start, end, block, text}]
    this.blockBreaks = new Set();
    this.sentenceMap = [];
    this.currentWordIndex = -1;
    this.isActive = false;
    this.container = null;
    this.skipSelectors = [];
    this._selectedTextNodes = null;
    this.focusMode = 'off';
    this.settings = {
      highlightBg: '#FFEB3B',
      highlightFg: '#000000',
      autoScroll: true,
      focusDimStyle: 'dim',
      wordMarkerStyle: 'color-underline',
      matchingUnderline: true,
    };

    this._supported = typeof CSS !== 'undefined'
      && CSS.highlights
      && typeof Highlight === 'function';
    this._wordHL = null;
    this._sentenceHL = null;
    this._dimHL = null;

    // rAF ease loop toward _scrollTarget; pauses on user-initiated scrolls.
    this._scrollRAF = null;
    this._scrollTarget = null;
    this._scrollExpected = null;
    this._userScrollPauseUntil = 0;
    this._scrollListener = null;
  }

  static _validHex(str) {
    return /^#(?:[A-Fa-f0-9]{3}|[A-Fa-f0-9]{4}|[A-Fa-f0-9]{6}|[A-Fa-f0-9]{8})$/.test(str) ? str : null;
  }

  static _SETTINGS_KEYS = ['highlightBg', 'highlightFg', 'autoScroll', 'focusDimStyle', 'wordMarkerStyle', 'matchingUnderline'];

  updateSettings(settings) {
    const prevDimStyle = this.settings.focusDimStyle;
    const prevMarkerStyle = this.settings.wordMarkerStyle;
    for (const k of Highlighter._SETTINGS_KEYS) {
      if (!(k in settings)) continue;
      if (k === 'highlightBg' || k === 'highlightFg') {
        const valid = Highlighter._validHex(settings[k]);
        if (valid) this.settings[k] = valid;
      } else if (k === 'focusDimStyle') {
        this.settings[k] = (settings[k] === 'band') ? 'band' : 'dim';
      } else if (k === 'wordMarkerStyle') {
        this.settings[k] = Highlighter.VALID_MARKER_STYLES.has(settings[k])
          ? settings[k] : 'color-underline';
      } else if (k === 'matchingUnderline') {
        this.settings[k] = settings[k] !== false;
      } else {
        this.settings[k] = settings[k];
      }
    }
    this._applyStyleVars();
    this._refreshMarkerClass();
    // Repaint mid-playback when a style toggle that affects rendering flipped.
    if (this.currentWordIndex >= 0
        && (this.settings.focusDimStyle !== prevDimStyle
          || this.settings.wordMarkerStyle !== prevMarkerStyle)) {
      this._refreshFocusClass();
      this._applyHighlight(this.currentWordIndex);
    }
  }

  /**
   * Record the words inside `container` without touching the DOM.
   *
   * @param {Element}  container     - DOM element containing the text
   * @param {string[]} skipSelectors - CSS selectors for elements to skip
   * @param {Range}    [range]       - if provided, only keep words whose text
   *                                   slice intersects this Range (selection mode)
   */
  prepare(container, skipSelectors, range) {
    this.cleanup();
    this.container = container;
    this.isActive = true;
    this.words = [];
    this.blockBreaks = new Set();
    this.sentenceMap = [];
    this.skipSelectors = skipSelectors || [];

    this._selectedTextNodes = null;
    this._selectionStartNode = null;
    this._selectionStartOffset = 0;
    this._selectionEndNode = null;
    this._selectionEndOffset = Infinity;
    if (range) {
      this._selectedTextNodes = new Set();
      const startNode = range.startContainer.nodeType === Node.TEXT_NODE ? range.startContainer : null;
      const endNode = range.endContainer.nodeType === Node.TEXT_NODE ? range.endContainer : null;
      this._selectionStartNode = startNode;
      this._selectionStartOffset = range.startOffset;
      this._selectionEndNode = endNode;
      this._selectionEndOffset = range.endOffset;

      const tw = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
      while (tw.nextNode()) {
        if (range.intersectsNode(tw.currentNode)) {
          this._selectedTextNodes.add(tw.currentNode);
        }
      }
    }

    this._collectWords(container);
    this._selectedTextNodes = null;
    this._detectBlockBreaks();
    this._applyStyleVars();
    this._refreshFocusClass();
    this._refreshMarkerClass();
  }

  /**
   * Build sentences from the recorded words.
   *
   * Flushes a sentence when:
   *   - a block break is reached (different <p>, <h*>, <li>, etc.)
   *   - a word ends with sentence-ending punctuation (.!?:;), if enabled
   *   - end of words
   *
   * Word count per sentence always equals the word-entry count it covers.
   *
   * @param {Object} [options]
   * @param {boolean} [options.punctuationPauses=true] - when true, punctuation
   *   (.!?:;) forces a sentence break (separate utterance = pause). When false,
   *   only block-element boundaries create breaks.
   */
  getSentences(options) {
    const punctuationPauses = options?.punctuationPauses !== false;

    if (this.words.length === 0) return [];

    const sentences = [];
    this.sentenceMap = [];
    let currentWords = [];
    let startIdx = 0;

    for (let i = 0; i < this.words.length; i++) {
      currentWords.push(this.words[i].text);

      const isLast = (i === this.words.length - 1);
      const isBlockBreak = this.blockBreaks.has(i);
      const endsWithPunctuation = punctuationPauses
        && /[.!?:;]$/.test(this.words[i].text);

      if (isLast || isBlockBreak || endsWithPunctuation) {
        const text = currentWords.join(' ');
        // Pre-compute char offset for each word so highlightWord() is O(1)
        const charOffsets = [];
        let pos = 0;
        for (const w of currentWords) {
          const idx = text.indexOf(w, pos);
          charOffsets.push(idx);
          pos = idx + w.length;
        }
        sentences.push(text);
        this.sentenceMap.push({
          startWordIndex: startIdx,
          wordCount: currentWords.length,
          text,
          charOffsets,
        });
        startIdx = i + 1;
        currentWords = [];
      }
    }

    return sentences;
  }

  // --- DOM walking (read-only) ---

  _collectWords(container) {
    const textNodes = [];
    this._walkForTextNodes(container, textNodes);

    const selectionFilter = this._selectedTextNodes;
    const blockCache = new Map();

    for (const textNode of textNodes) {
      const text = textNode.textContent;
      if (!text.trim()) continue;

      const parent = textNode.parentElement;
      if (selectionFilter && !selectionFilter.has(textNode)) continue;

      let block = blockCache.get(parent);
      if (block === undefined) {
        block = this._getBlockAncestor(parent);
        blockCache.set(parent, block);
      }

      const parts = text.split(/(\s+)/);
      let charPos = 0;
      for (const part of parts) {
        if (part === '') continue;
        if (!/^\s+$/.test(part)) {
          const start = charPos;
          const end = charPos + part.length;
          let include = true;
          if (selectionFilter) {
            const afterStart = textNode !== this._selectionStartNode || end > this._selectionStartOffset;
            const beforeEnd = textNode !== this._selectionEndNode || start < this._selectionEndOffset;
            include = afterStart && beforeEnd;
          }
          if (include) {
            this.words.push({ node: textNode, start, end, block, text: part });
          }
        }
        charPos += part.length;
      }
    }
  }

  // Recursively collects text nodes from a root element and any open
  // shadow roots nested beneath it. Shadow roots whose host matches a
  // skip selector are not entered.
  _walkForTextNodes(root, out) {
    const self = this;
    const walker = document.createTreeWalker(
      root,
      NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            // Only emit shadow hosts so the outer loop can recurse into
            // them; every other element is transparent to the walker.
            return node.shadowRoot ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
          }
          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;
          const tag = parent.tagName;
          if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') {
            return NodeFilter.FILTER_REJECT;
          }
          if (typeof parent.checkVisibility === 'function' && !parent.checkVisibility()) {
            return NodeFilter.FILTER_REJECT;
          }
          for (const sel of self.skipSelectors) {
            try {
              const match = parent.closest(sel);
              if (match && root.contains(match) && match !== root) {
                return NodeFilter.FILTER_REJECT;
              }
            } catch { /* invalid selector - ignore, don't reject the node */ }
          }
          if (!node.textContent.trim()) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );
    let node;
    while ((node = walker.nextNode())) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        let skipHost = false;
        for (const sel of this.skipSelectors) {
          try { if (node.closest(sel)) { skipHost = true; break; } }
          catch { /* invalid selector - ignore */ }
        }
        if (!skipHost) this._walkForTextNodes(node.shadowRoot, out);
      } else {
        out.push(node);
      }
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
    if (this.words.length < 2) return;

    let prevBlock = this.words[0].block;
    for (let i = 1; i < this.words.length; i++) {
      const curBlock = this.words[i].block;
      if (curBlock !== prevBlock) {
        this.blockBreaks.add(i - 1);
      }
      prevBlock = curBlock;
    }
  }

  // --- Range / rect helpers ---

  _makeRange(node, start, end) {
    if (!node || !node.isConnected) return null;
    const len = node.nodeValue?.length ?? 0;
    if (start < 0 || end > len || start > end) return null;
    try {
      const r = document.createRange();
      r.setStart(node, start);
      r.setEnd(node, end);
      return r;
    } catch {
      return null;
    }
  }

  _getWordRect(idx) {
    const w = this.words[idx];
    if (!w) return null;
    const r = this._makeRange(w.node, w.start, w.end);
    if (!r) return null;
    try { return r.getBoundingClientRect(); } catch { return null; }
  }

  /**
   * Find the visual-line word range centred on `wordIndex` by comparing
   * bounding-rect tops against a half-height tolerance.
   */
  _getVisualLineRange(wordIndex) {
    const rect = this._getWordRect(wordIndex);
    if (!rect) return [wordIndex, wordIndex];
    const top = rect.top;
    const tolerance = rect.height * 0.5;

    let start = wordIndex;
    for (let i = wordIndex - 1; i >= 0; i--) {
      const r = this._getWordRect(i);
      if (!r || Math.abs(r.top - top) > tolerance) break;
      start = i;
    }
    let end = wordIndex;
    for (let i = wordIndex + 1; i < this.words.length; i++) {
      const r = this._getWordRect(i);
      if (!r || Math.abs(r.top - top) > tolerance) break;
      end = i;
    }
    return [start, end];
  }

  /**
   * Add ranges covering words [startIdx, startIdx+count) to the sentence
   * highlight. Consecutive words in the same text node are coalesced into
   * a single range to keep the highlight set compact.
   */
  _addSentenceRanges(startIdx, count) {
    if (!this._sentenceHL) return;
    const end = startIdx + count;
    let i = startIdx;
    while (i < end) {
      const node = this.words[i].node;
      const rangeStart = this.words[i].start;
      let j = i;
      while (j + 1 < end && this.words[j + 1].node === node) j++;
      const rangeEnd = this.words[j].end;
      const r = this._makeRange(node, rangeStart, rangeEnd);
      if (r) this._sentenceHL.add(r);
      i = j + 1;
    }
  }

  // --- Highlighting ---

  highlightWord(charIndex, charLength, sentenceIndex) {
    if (!this.isActive || sentenceIndex >= this.sentenceMap.length) return;

    const info = this.sentenceMap[sentenceIndex];
    const offsets = info.charOffsets;

    let wordIndexInSentence = -1;
    for (let i = offsets.length - 1; i >= 0; i--) {
      if (offsets[i] >= 0 && charIndex >= offsets[i]) {
        wordIndexInSentence = i;
        break;
      }
    }

    if (wordIndexInSentence < 0) {
      this._applyHighlight(-1);
      return;
    }

    this._applyHighlight(info.startWordIndex + wordIndexInSentence);
  }

  _applyHighlight(wordIndex) {
    // Re-create Highlight objects instead of .clear()-ing: Chromium does
    // not always invalidate a highlight's painted region on clear.
    this._resetHighlights();
    this.currentWordIndex = -1;

    if (!this._supported || wordIndex < 0 || wordIndex >= this.words.length) {
      return;
    }

    const w = this.words[wordIndex];
    const wordRange = this._makeRange(w.node, w.start, w.end);
    if (!wordRange) return;

    this._wordHL.add(wordRange);
    this.currentWordIndex = wordIndex;

    // Active context window: the sentence, text block, or visual line
    // the active word belongs to, as a [ctxStart, ctxEnd) half-open range.
    let ctxStart = wordIndex;
    let ctxEnd = wordIndex + 1;
    if (this.focusMode === 'sentence' || this.focusMode === 'text') {
      for (const info of this.sentenceMap) {
        if (wordIndex >= info.startWordIndex && wordIndex < info.startWordIndex + info.wordCount) {
          ctxStart = info.startWordIndex;
          ctxEnd = info.startWordIndex + info.wordCount;
          break;
        }
      }
    } else if (this.focusMode === 'line') {
      const [start, end] = this._getVisualLineRange(wordIndex);
      ctxStart = start;
      ctxEnd = end + 1;
    }

    if (this.focusMode !== 'off' && this.settings.focusDimStyle === 'band') {
      this._addSentenceRanges(ctxStart, ctxEnd - ctxStart);
    }
    if (this.focusMode !== 'off' && this.settings.focusDimStyle === 'dim') {
      this._addDimRanges(ctxStart, ctxEnd);
    }

    this._scrollToRange(wordRange);
  }

  /** Populate lc-dim with every word outside [excludeStart, excludeEnd). */
  _addDimRanges(excludeStart, excludeEnd) {
    if (!this._dimHL || this.words.length === 0) return;
    const N = this.words.length;

    const emit = (from, to) => {
      let i = from;
      while (i < to) {
        const node = this.words[i].node;
        const rangeStart = this.words[i].start;
        let j = i;
        while (j + 1 < to && this.words[j + 1].node === node) j++;
        const rangeEnd = this.words[j].end;
        const r = this._makeRange(node, rangeStart, rangeEnd);
        if (r) this._dimHL.add(r);
        i = j + 1;
      }
    };

    if (excludeStart > 0) emit(0, Math.min(excludeStart, N));
    if (excludeEnd < N) emit(Math.max(0, excludeEnd), N);
  }

  _resetHighlights() {
    if (!this._supported) return;
    this._dimHL = new Highlight();
    this._sentenceHL = new Highlight();
    this._wordHL = new Highlight();
    // Higher priority paints on top: word > sentence > dim.
    this._dimHL.priority = 0;
    this._sentenceHL.priority = 1;
    this._wordHL.priority = 2;
    CSS.highlights.set(Highlighter.HIGHLIGHT_DIM, this._dimHL);
    CSS.highlights.set(Highlighter.HIGHLIGHT_SENTENCE, this._sentenceHL);
    CSS.highlights.set(Highlighter.HIGHLIGHT_WORD, this._wordHL);
  }

  _clearHighlights() {
    if (!this._supported) return;
    CSS.highlights.delete(Highlighter.HIGHLIGHT_DIM);
    CSS.highlights.delete(Highlighter.HIGHLIGHT_SENTENCE);
    CSS.highlights.delete(Highlighter.HIGHLIGHT_WORD);
    this._dimHL = null;
    this._sentenceHL = null;
    this._wordHL = null;
  }

  _scrollToRange(range) {
    if (!this.settings.autoScroll) return;
    // Yield to the user if they scrolled manually in the last 1.5 s.
    if (Date.now() < this._userScrollPauseUntil) return;
    // Lazily attach the user-scroll watcher on first use.
    if (!this._scrollListener) {
      this._scrollListener = () => {
        // Only idle scrolls (no active animation) mean the user did it.
        if (this._scrollRAF == null) this._userScrollPauseUntil = Date.now() + 1500;
      };
      window.addEventListener('scroll', this._scrollListener, { passive: true });
    }

    let rect;
    try { rect = range.getBoundingClientRect(); } catch { return; }
    if (!rect || (rect.width === 0 && rect.height === 0)) return;
    const vh = window.innerHeight;

    // Quiet while the word is within 10-90 % of viewport; retarget only
    // at the edges and reposition to ~25 % from top (leaves a page of
    // reading space below).
    if (rect.top >= vh * 0.1 && rect.bottom <= vh * 0.9) return;
    const wordCenter = rect.top + rect.height / 2;
    this._scrollTarget = window.scrollY + (wordCenter - vh * 0.25);
    if (this._scrollRAF == null) this._scrollRAF = requestAnimationFrame(this._scrollStep);
  }

  _scrollStep = () => {
    const current = window.scrollY;
    // Detect a user scroll mid-animation: scrollY deviated from where
    // we last put it. Abort and hand control back to the user.
    if (this._scrollExpected != null
        && Math.abs(current - this._scrollExpected) > 3) {
      this._scrollRAF = null;
      this._scrollTarget = null;
      this._scrollExpected = null;
      this._userScrollPauseUntil = Date.now() + 1500;
      return;
    }
    const target = this._scrollTarget;
    if (target == null) { this._scrollRAF = null; this._scrollExpected = null; return; }
    const dist = target - current;
    if (Math.abs(dist) < 0.5) {
      window.scrollTo(0, target);
      this._scrollExpected = target;
      this._scrollRAF = null;
      this._scrollTarget = null;
      return;
    }
    // 12 % of remaining distance per frame (~300 ms convergence).
    const next = current + dist * 0.12;
    window.scrollTo(0, next);
    this._scrollExpected = next;
    this._scrollRAF = requestAnimationFrame(this._scrollStep);
  };

  _cancelScrollLoop() {
    if (this._scrollRAF != null) {
      cancelAnimationFrame(this._scrollRAF);
      this._scrollRAF = null;
    }
    this._scrollTarget = null;
    this._scrollExpected = null;
    if (this._scrollListener) {
      window.removeEventListener('scroll', this._scrollListener);
      this._scrollListener = null;
    }
    this._userScrollPauseUntil = 0;
  }

  _applyStyleVars() {
    if (!this.container) return;
    const style = this.container.style;
    style.setProperty('--lc-hl-bg', this.settings.highlightBg);
    style.setProperty('--lc-hl-fg', this.settings.highlightFg);
    // In 'band' mode the sentence range needs an explicit color to beat
    // the container's !important dim rule; otherwise let ::highlight's
    // `currentColor` fallback preserve the page's original text color.
    if (this.settings.focusDimStyle === 'band' && this.focusMode && this.focusMode !== 'off') {
      style.setProperty('--lc-sentence-color', this.settings.highlightFg);
    } else {
      style.removeProperty('--lc-sentence-color');
    }
    // Underline color in 'color-underline' marker: primary by default,
    // secondary when the "matching underline" toggle is off.
    if (this.settings.matchingUnderline === false) {
      style.setProperty('--lc-underline-color', 'var(--lc-hl-fg)');
    } else {
      style.removeProperty('--lc-underline-color');
    }
  }

  _clearStyleVars() {
    if (!this.container) return;
    const style = this.container.style;
    style.removeProperty('--lc-hl-bg');
    style.removeProperty('--lc-hl-fg');
    style.removeProperty('--lc-sentence-color');
    style.removeProperty('--lc-underline-color');
  }

  _refreshFocusClass() {
    if (!this.container) return;
    // Class-based dim only applies in 'band' mode; 'dim' uses lc-dim instead.
    const on = this.focusMode
      && this.focusMode !== 'off'
      && this.settings.focusDimStyle === 'band';
    this.container.classList.toggle(Highlighter.FOCUS_CLASS, !!on);
  }

  _refreshMarkerClass() {
    if (!this.container) return;
    const cl = this.container.classList;
    for (const cls of Object.values(Highlighter._MARKER_CLASS_BY_STYLE)) {
      cl.remove(cls);
    }
    const target = Highlighter._MARKER_CLASS_BY_STYLE[this.settings.wordMarkerStyle];
    if (target) cl.add(target);
  }

  // --- Cleanup ---

  cleanup() {
    this._clearHighlights();
    this._cancelScrollLoop();
    if (this.container) {
      const cl = this.container.classList;
      cl.remove(Highlighter.FOCUS_CLASS);
      for (const cls of Object.values(Highlighter._MARKER_CLASS_BY_STYLE)) cl.remove(cls);
    }
    this._clearStyleVars();

    this.words = [];
    this.blockBreaks = new Set();
    this.sentenceMap = [];
    this.currentWordIndex = -1;
    this.isActive = false;
    this.container = null;
    this._selectedTextNodes = null;
    this._selectionStartNode = null;
    this._selectionStartOffset = 0;
    this._selectionEndNode = null;
    this._selectionEndOffset = Infinity;
  }
}
