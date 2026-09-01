/**
 * Shared constants and helpers used across content scripts, popup, and options.
 * Loaded before all other scripts via manifest.json and HTML script tags.
 */

const SETTINGS_DEFAULTS = {
  voiceURI: null,
  rate: 1.0,
  pitch: 1.0,
  volume: 1.0,
  highlightBg: '#7CF145',
  highlightFg: '#000000',
  mode: 'fullpage',
  skipCodeBlocks: true,
  skipAltText: false,
  skipLinks: false,
  punctuationPauses: true,
  focusMode: 'text',
  focusDimStyle: 'dim',
  wordMarkerStyle: 'color-underline',
  matchingUnderline: true,
  autoScroll: true,
  ttsBackend: 'browser',
  kokoroEndpoint: 'http://localhost:8880',
  kokoroVoice: 'am_adam',
  kokoroJsVoice: 'af_heart',
  kokoroJsDevice: 'wasm',
  // Minutes of inactivity before the in-browser model is unloaded and its
  // memory (VRAM on the GPU path) released; 0 keeps it resident indefinitely.
  kokoroJsIdleUnload: 5,
  siteSelectors: {},
  showAllLanguages: false,
};

const SKIP_SELECTORS = [
  'nav', 'body > header', 'body > div > header', 'footer', 'aside',
  '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]',
  '[role="complementary"]', '.sidebar', '.sidebar-buttons', '.nav', '.menu',
  '.advertisement', '.ad', '.ads', '.social-share',
  '.comments', '.comment-section', '#comments',
  'script', 'style', 'noscript', 'svg', 'canvas',
  'iframe', 'form', 'input', 'select', 'textarea',
  '.sr-only', '.visually-hidden', '.screen-reader-text',
  '[aria-hidden="true"]',
];

const KOKORO_LANGS = {
  a: 'American English', b: 'British English', e: 'Spanish', f: 'French',
  h: 'Hindi', i: 'Italian', j: 'Japanese', p: 'Portuguese', z: 'Mandarin Chinese',
};

const KOKORO_GENDERS = { f: 'Female', m: 'Male' };

// Voices bundled with kokoro-js (Kokoro-82M v1.0). They follow the same
// {lang}{gender}_{name} convention as Kokoro-FastAPI, so formatKokoroVoice
// renders them without any extra metadata.
const KOKOROJS_VOICES = [
  'af_heart', 'af_alloy', 'af_aoede', 'af_bella', 'af_jessica', 'af_kore',
  'af_nicole', 'af_nova', 'af_river', 'af_sarah', 'af_sky',
  'am_adam', 'am_echo', 'am_eric', 'am_fenrir', 'am_liam', 'am_michael',
  'am_onyx', 'am_puck', 'am_santa',
  'bf_alice', 'bf_emma', 'bf_isabella', 'bf_lily',
  'bm_daniel', 'bm_fable', 'bm_george', 'bm_lewis',
];

/** Format a Kokoro voice ID into a readable label, e.g. "Alloy - Female (American English)" */
function formatKokoroVoice(id) {
  if (!id || id.length < 4 || id[2] !== '_'
      || !(id[0] in KOKORO_LANGS) || !(id[1] in KOKORO_GENDERS)) return id;
  const name = id.split('_').slice(1).join('_');
  if (!name) return id;
  const pretty = name.replace(/^v0/, '').replace(/^./, c => c.toUpperCase()) || id;
  return `${pretty} - ${KOKORO_GENDERS[id[1]]} (${KOKORO_LANGS[id[0]]})`;
}

/**
 * Both Kokoro backends produce plain audio without word timestamps handled
 * identically downstream, so playback, pausing, and word-sync branch on this
 * rather than on an exact backend name.
 */
function isKokoroBackend(backend) {
  return backend === 'kokoro' || backend === 'kokorojs';
}

/** Check if a URL points to a loopback address (localhost, 127.0.0.1, ::1). */
function isLocalhostURL(urlStr) {
  try {
    const url = new URL(urlStr);
    return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}

/** Wrapper around chrome.storage.local.set that logs quota errors. */
function safeSave(partial, callback) {
  chrome.storage.local.set(partial, () => {
    if (chrome.runtime.lastError) {
      console.warn('Storage save failed:', chrome.runtime.lastError.message);
    }
    if (callback) callback();
  });
}

// --- Voice availability + auto-pick ---

/**
 * Voice families that do not fire `boundary` events for word-level
 * highlighting - the marker would freeze on the first word. They remain
 * selectable (sentence focus, color, and dim modes still work), but are
 * excluded from auto-pick and trigger the inline warning + word-marker
 * suppression when active. Add patterns to the array to extend the list;
 * the rest of the pipeline keys off `isLimitedVoice()`.
 */
const _LIMITED_VOICE_PATTERNS = [
  /^Google\s/i,
];

function isLimitedVoice(voice) {
  return _LIMITED_VOICE_PATTERNS.some(re => re.test(voice.name));
}

/** User's preferred locale tags from the browser, lowercased. */
function getUserLangTags() {
  const langs = (navigator.languages && navigator.languages.length)
    ? navigator.languages
    : [navigator.language || 'en-US'];
  return langs.map(l => String(l).toLowerCase());
}

/** Primary subtags only, e.g. ['en','nl'] - used for optgroup filtering. */
function getUserLangPrefixes() {
  return [...new Set(getUserLangTags().map(l => l.split('-')[0]))];
}

// "Premium" tier signals: explicit suffix tags `(Natural)` / `(Premium)` /
// `(Enhanced)`, plus the standalone word `Online` (Edge cloud voices like
// "Microsoft Ava Online" are network-routed and consistently higher quality
// than local Desktop SAPI5).
const _PREMIUM_VOICE_RE = /\((Natural|Premium|Enhanced)\)|\bOnline\b/i;

/**
 * Pick the best default voice for the current user, by walking
 * navigator.languages in order and applying a 6-tier match per language:
 *   1. Exact regional match + premium       (e.g. en-US "Ava (Natural)")
 *   2. Exact regional match + system default (voice.default === true)
 *   3. Exact regional match, any            (e.g. en-US "Zira Desktop")
 *   4. Same primary subtag + premium        (e.g. en-* "Hazel (Natural)")
 *   5. Same primary subtag + system default
 *   6. Same primary subtag, any             (e.g. en-* "Daniel Desktop")
 * The system-default tier prevents macOS from landing on a novelty voice
 * (Albert / Bad News / Pipe Organ) when no premium is installed.
 * Returns null if nothing matches the user's languages, so the caller can
 * fall back to the browser's own default.
 */
function pickDefaultVoice(voices) {
  const usable = voices.filter(v => !isLimitedVoice(v));
  if (usable.length === 0) return null;

  // English is appended as a last-resort tier - most web content is English,
  // and a working English voice beats no voice at all when the user's
  // configured languages have nothing installed.
  const tags = [...getUserLangTags(), 'en-us', 'en-gb', 'en'];

  for (const tag of tags) {
    const primary = tag.split('-')[0];
    const exact = usable.filter(v => v.lang.toLowerCase() === tag);
    const sameLng = usable.filter(v => v.lang.toLowerCase().split('-')[0] === primary);

    // The system-default tier (voice.default === true) sits between premium
    // and "any". Prevents macOS users from landing on a novelty voice
    // (Albert / Bad News / Pipe Organ) when no premium is installed - the
    // OS marks the user-selected default voice (Samantha on macOS, Zira
    // Desktop on Windows) which is a reliable quality signal.
    const pick = exact.find(v => _PREMIUM_VOICE_RE.test(v.name))
              || exact.find(v => v.default)
              || exact[0]
              || sameLng.find(v => _PREMIUM_VOICE_RE.test(v.name))
              || sameLng.find(v => v.default)
              || sameLng[0];
    if (pick) return pick.voiceURI;
  }
  return null;
}

/**
 * Filter voices for dropdown rendering: unless showAll is set, keeps only
 * voices whose primary subtag matches the user's languages. The currently
 * saved voice's language is always kept visible so the user never loses
 * their selection on a foreign voice. Limited voices (per
 * `_LIMITED_VOICE_PATTERNS`) are kept - they're usable for full-sentence
 * reading; the per-voice warning + word-marker suppression handles their
 * boundary-event limitation elsewhere.
 */
function filterVoicesForDropdown(voices, savedURI, showAll) {
  if (showAll) return voices;

  const allowed = new Set(getUserLangPrefixes());
  if (savedURI) {
    const saved = voices.find(v => v.voiceURI === savedURI);
    if (saved) allowed.add(saved.lang.toLowerCase().split('-')[0]);
  }
  return voices.filter(v => allowed.has(v.lang.toLowerCase().split('-')[0]));
}
