/**
 * Shared constants and helpers used across content scripts, popup, and options.
 * Loaded before all other scripts via manifest.json and HTML script tags.
 */

const SETTINGS_DEFAULTS = {
  voiceURI: null,
  rate: 1.0,
  pitch: 1.0,
  volume: 1.0,
  highlightBg: '#FFEB3B',
  highlightFg: '#000000',
  mode: 'fullpage',
  skipCodeBlocks: true,
  skipAltText: false,
  skipLinks: false,
  neonHighlight: true,
  punctuationPauses: true,
  focusMode: 'off',
  autoScroll: true,
  ttsBackend: 'browser',
  kokoroEndpoint: 'http://localhost:8880',
  kokoroVoice: 'af_alloy',
};

const SKIP_SELECTORS = [
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

const KOKORO_LANGS = {
  a: 'American English', b: 'British English', e: 'Spanish', f: 'French',
  h: 'Hindi', i: 'Italian', j: 'Japanese', p: 'Portuguese', z: 'Mandarin Chinese',
};

const KOKORO_GENDERS = { f: 'Female', m: 'Male' };

/** Format a Kokoro voice ID into a readable label, e.g. "Alloy - Female (American English)" */
function formatKokoroVoice(id) {
  if (!id || id.length < 4 || id[2] !== '_'
      || !(id[0] in KOKORO_LANGS) || !(id[1] in KOKORO_GENDERS)) return id;
  const name = id.split('_').slice(1).join('_');
  if (!name) return id;
  const pretty = name.replace(/^v0/, '').replace(/^./, c => c.toUpperCase()) || id;
  return `${pretty} - ${KOKORO_GENDERS[id[1]]} (${KOKORO_LANGS[id[0]]})`;
}
