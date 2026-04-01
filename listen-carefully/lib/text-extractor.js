/**
 * Content detection - finds the main readable content area on a page.
 * Uses semantic elements first, then falls back to text-density scoring.
 */

/**
 * Readability-style content detection.
 * Finds the element with the most text density.
 */
function findMainContent() {
  // Try semantic elements first (broad set of common CMS/framework patterns)
  const candidates = [...document.querySelectorAll([
    'article', 'main', '[role="main"]', '[role="article"]',
    '#content', '.content',
    '.post-content', '.post', '.post-body',
    '.article-content', '.article-body',
    '.entry-content', '.page-content',
    '.story-body', '.main-content', '#main-content',
    '#article', '.prose',
    '[itemprop="articleBody"]',
  ].join(', '))];

  if (candidates.length > 0) {
    const best = candidates.reduce((a, b) =>
      (b.innerText || '').length > (a.innerText || '').length ? b : a
    );
    return _expandForHeading(best);
  }

  // Fallback: score block-level elements by text density
  const blocks = document.querySelectorAll('div, section');
  let best = document.body;
  let bestScore = 0;

  for (const block of blocks) {
    const text = block.innerText || '';
    const linkText = Array.from(block.querySelectorAll('a'))
      .reduce((sum, a) => sum + (a.innerText || '').length, 0);

    const textLen = text.length;
    if (textLen < 150) continue;

    const score = textLen - (linkText * 2);
    if (score > bestScore) {
      bestScore = score;
      best = block;
    }
  }

  return bestScore > 0 ? _expandForHeading(best) : document.body;
}

/**
 * If `el` has a heading sibling immediately before it, expand to the parent
 * so the title is included in the reading range.
 */
function _expandForHeading(el) {
  if (!el || el === document.body) return el;
  let prev = el.previousElementSibling;
  // Skip whitespace-only or invisible elements
  while (prev && !(prev.innerText || '').trim()) prev = prev.previousElementSibling;
  if (prev && (/^H[1-3]$/.test(prev.tagName) || prev.querySelector('h1, h2, h3'))) {
    return el.parentElement || el;
  }
  return el;
}

/**
 * Find the best content container that includes the given element.
 * Used by "read from here" and element picker to ensure the container
 * actually contains the start point.
 */
function findContainerFor(el) {
  // 1. Semantic container closest to the element
  const semantic = el.closest(
    'article, main, section, [role="main"], [role="article"]'
  );
  if (semantic) return _expandForHeading(semantic);

  // 2. findMainContent() - but only useful if it contains el
  const main = findMainContent();
  if (main && main !== document.body && main.contains(el)) return main;

  // 3. Walk up from el to find the broadest block-level ancestor with
  //    substantial text (stop before body which is too broad)
  let best = null;
  let current = el.parentElement;
  while (current && current !== document.body && current !== document.documentElement) {
    if ((current.innerText || '').length >= 100) {
      best = current;
    }
    current = current.parentElement;
  }
  if (best) return best;

  // 4. Last resort: use main content even without containment
  return main || document.body;
}
