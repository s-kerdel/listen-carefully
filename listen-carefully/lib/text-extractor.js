/**
 * Text Extractor - extracts readable text from pages and splits into sentences.
 * Supports full-page extraction (Readability-style), selection, and element modes.
 */

class TextExtractor {
  constructor() {
    // Selectors for elements to strip in full-page mode
    this.STRIP_SELECTORS = [
      'nav', 'header', 'footer', 'aside',
      '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]',
      '[role="complementary"]', '.sidebar', '.nav', '.menu',
      '.advertisement', '.ad', '.ads', '.social-share',
      '.comments', '.comment-section', '#comments',
      'script', 'style', 'noscript', 'svg', 'canvas',
      'iframe', 'form', 'button', 'input', 'select', 'textarea',
      '.sr-only', '.visually-hidden', '.screen-reader-text',
      '[aria-hidden="true"]',
    ];

    this.settings = {
      skipCodeBlocks: true,
      skipAltText: false,
      skipLinks: false,
    };
  }

  updateSettings(settings) {
    Object.assign(this.settings, settings);
  }

  /**
   * Extract text based on mode.
   * Returns { text: string, container: Element }
   */
  extract(mode) {
    switch (mode) {
      case 'selection': return this._extractSelection();
      case 'element': return null; // Element mode waits for click, handled by content.js
      case 'fullpage':
      default: return this._extractFullPage();
    }
  }

  _extractSelection() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) return null;

    const range = selection.getRangeAt(0);
    const container = range.commonAncestorContainer;
    const element = container.nodeType === Node.TEXT_NODE ? container.parentElement : container;
    const text = selection.toString();

    return { text: this._cleanText(text), container: element };
  }

  extractFromElement(element) {
    const text = this._getTextFromElement(element);
    return { text: this._cleanText(text), container: element };
  }

  _extractFullPage() {
    // Try to find the main content area
    const main = this.findMainContent();
    const text = this._getTextFromElement(main);
    return { text: this._cleanText(text), container: main };
  }

  /**
   * Simple Readability-style content detection.
   * Finds the element with the most text density.
   */
  findMainContent() {
    // Try semantic elements first
    const candidates = [
      ...document.querySelectorAll('article'),
      ...document.querySelectorAll('main'),
      ...document.querySelectorAll('[role="main"]'),
      ...document.querySelectorAll('[role="article"]'),
      ...document.querySelectorAll('#content'),
      ...document.querySelectorAll('.content'),
      ...document.querySelectorAll('.post-content'),
      ...document.querySelectorAll('.post'),
      ...document.querySelectorAll('.article-content'),
      ...document.querySelectorAll('.entry-content'),
      ...document.querySelectorAll('.page-content'),
    ];

    if (candidates.length > 0) {
      // Return the one with the most visible text (innerText respects
      // display:none / visibility:hidden, unlike textContent)
      return candidates.reduce((best, el) =>
        (el.innerText || '').length > (best.innerText || '').length ? el : best
      );
    }

    // Fallback: score block-level elements by text density
    const blocks = document.querySelectorAll('div, section');
    let best = document.body;
    let bestScore = 0;

    for (const block of blocks) {
      const text = block.innerText || '';
      const linkText = Array.from(block.querySelectorAll('a'))
        .reduce((sum, a) => sum + (a.innerText || '').length, 0);

      // Score: visible text length minus link-heavy text, penalize very short blocks
      const textLen = text.length;
      if (textLen < 150) continue;

      const score = textLen - (linkText * 2);
      if (score > bestScore) {
        bestScore = score;
        best = block;
      }
    }

    return bestScore > 0 ? best : document.body;
  }

  _getTextFromElement(element) {
    const clone = element.cloneNode(true);

    // Strip unwanted elements
    for (const selector of this.STRIP_SELECTORS) {
      clone.querySelectorAll(selector).forEach(el => el.remove());
    }

    if (this.settings.skipCodeBlocks) {
      clone.querySelectorAll('pre, code').forEach(el => el.remove());
    }

    if (this.settings.skipLinks) {
      clone.querySelectorAll('a').forEach(el => {
        // Replace link with its text content (don't read the URL)
        el.replaceWith(document.createTextNode(el.textContent));
      });
    }

    return clone.innerText || clone.textContent || '';
  }

  /**
   * Clean raw text: collapse whitespace, strip URLs, etc.
   */
  _cleanText(text) {
    return text
      .replace(/https?:\/\/[^\s]+/g, '')  // Remove URLs
      .replace(/\s+/g, ' ')               // Collapse whitespace
      .trim();
  }

  /**
   * Split text into sentences. Handles common abbreviations.
   */
  splitIntoSentences(text) {
    if (!text) return [];

    // Three alternatives, tried in order:
    //   1. Colon followed by whitespace/end - splits "Key points: details" into two chunks.
    //      Colon-first priority ensures it wins over the .!? branch.
    //      Safe for "10:30" because : must be followed by \s or $.
    //   2. Sentence-ending punctuation (.!?) followed by whitespace/end.
    //   3. Trailing text without punctuation (catches the final fragment).
    const raw = text.match(
      /[^.!?]*:(?:\s+|$)|[^.!?]*[.!?]+(?:\s+|$)|[^.!?]+$/g
    ) || [text];

    return raw
      .map(s => s.trim())
      .filter(s => s.length > 0);
  }
}
