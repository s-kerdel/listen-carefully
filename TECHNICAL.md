# Technical Documentation: Listen Carefully

## 1. Overview

Listen Carefully is a Chromium-based browser extension that converts webpage text to speech. It supports two TTS backends: the built-in Web Speech API (default) and an optional local Kokoro TTS server. It highlights the currently spoken word in real time on the page, supports multiple reading modes, and operates entirely within the browser with no external network dependencies. The Kokoro backend communicates only with localhost.

The extension is built on Manifest V3 and targets Chrome and Brave on Windows 11, where Microsoft neural voices provide high quality speech synthesis through the operating system.

## 2. Architecture

The extension consists of four layers that communicate through Chrome's messaging API.

### 2.1 Background Service Worker

File: `background.js`

The service worker is the only component that persists across tab changes. It has three responsibilities: switching the toolbar icon between light and dark variants based on the active page's color scheme, managing the right-click context menu entry ("Read from here"), and proxying Kokoro TTS API requests.

Kokoro fetches are routed through the service worker rather than the content script to avoid Chrome's per-site permission prompts for cross-origin localhost requests. The service worker validates the endpoint against localhost, fetches from the Kokoro API, and returns the JSON response (base64 audio + timestamps) via `sendResponse`. This is fully JSON-serializable and avoids the ArrayBuffer transfer limitations of Chrome extension messaging.

### 2.2 Content Script Layer

Files: `content.js`, `lib/config.js`, `lib/tts-engine.js`, `lib/highlighter.js`, `lib/text-extractor.js`

These five files are injected into every page via the `content_scripts` manifest entry. They run in an isolated world, meaning they share the page's DOM but not its JavaScript scope. The `speechSynthesis` API is only available in this context, not in the service worker.

`lib/config.js` is loaded first and defines shared constants (`SETTINGS_DEFAULTS`, `SKIP_SELECTORS`, Kokoro voice formatting) used by all other scripts. It is also loaded by the popup and options page via `<script>` tags.

`content.js` is the orchestrator. It wires up callbacks between the engine and highlighter, handles all incoming messages from the popup and background script, registers keyboard shortcuts, and manages the reading lifecycle.

### 2.3 Popup

Files: `popup/popup.html`, `popup/popup.js`, `popup/popup.css`

The popup is the primary user interface. It opens when the user clicks the toolbar icon and provides playback controls, mode selection, voice selection, and speed and volume sliders. The popup has no direct access to the page DOM or to `speechSynthesis`. All actions are forwarded to the content script via `chrome.tabs.sendMessage`.

When playback is paused, the play button label changes from "Read" to "Resume" and sends a `togglePlayPause` message instead of `play`, so that clicking it resumes from the current position rather than restarting.

The popup polls the content script every 500ms to keep its state synchronized, since runtime messages can be missed if the popup opens after playback has already started.

### 2.4 Options Page

Files: `options/options.html`, `options/options.js`, `options/options.css`

The options page provides the full settings panel including pitch control, highlight color pickers with presets, content filtering toggles, and a voice preview feature. Unlike the popup, the options page opens in a full tab and has direct access to `speechSynthesis` for voice enumeration and preview playback.

## 3. Core Modules

### 3.1 TTSEngine (`lib/tts-engine.js`)

This class manages a sentence-level playback queue and supports two backends: the Web Speech Synthesis API (browser) and Kokoro (local API). The queue design exists to work around a known Chromium limitation where utterances longer than approximately 15 seconds are silently terminated by the browser. The active backend is determined by the `ttsBackend` setting (`'browser'` or `'kokoro'`).

Each sentence is spoken individually. The browser backend uses `SpeechSynthesisUtterance` objects; the Kokoro backend fetches audio from `POST /dev/captioned_speech` and plays it via an `Audio` element. When a sentence finishes, the engine automatically advances to the next. The engine exposes five callbacks:

```
onBoundary(charIndex, charLength, sentenceIndex)    Called on each word boundary during speech.
onSentenceStart(sentenceIndex)                       Called when a new sentence begins.
onStateChange(state)                                 Called when playback state changes (playing, paused, stopped).
onEnd()                                              Called when the entire queue has been spoken.
onError(message)                                     Called when the Kokoro backend fails (e.g. service unreachable).
```

Stale event handling uses identity checks rather than flags. Each backend tracks its active playback object (`_activeSpeech` for browser utterances, `_audio` for Kokoro audio elements). When `_cancelAll()` runs, it nulls these references before calling `speechSynthesis.cancel()`, so any stale `onend` events — fired synchronously on Firefox or asynchronously on Chrome — see a mismatch and are ignored. All Kokoro audio callbacks (`onended`, `onerror`, `playing`) also check `this._audio === audio` to prevent stale events from a replaced audio element.

Both backends have error recovery with a 3-strike counter. If a sentence fails, the engine skips to the next. After 3 consecutive failures it stops with an error message. Success resets the counter.

Settings changes (voice, rate, pitch, volume) take effect immediately during playback by cancelling and restarting the current sentence with the new parameters. If no settings actually changed, the restart is skipped to avoid an audible glitch. For the Kokoro backend, volume changes are applied directly to the `Audio` element without re-fetching. If settings are changed while paused, a `_settingsChangedWhilePaused` flag causes the next `resume()` call to re-speak the current sentence with the updated parameters.

#### 3.1.1 Kokoro Word Highlighting

The browser backend receives native `onboundary` events with exact character positions. The Kokoro backend uses word-level timestamps from the API response to achieve the same effect.

The `/dev/captioned_speech` endpoint returns base64-encoded audio alongside a `timestamps` array containing `{word, start_time, end_time}` entries. English voices support timestamps; non-English voices return `null`, triggering a character-length-weighted estimation fallback.

Word highlighting is synchronized via a `requestAnimationFrame` loop that reads `audio.currentTime` and finds the matching word timestamp. This approach is drift-free and self-correcting in both directions.

Kokoro normalizes text before synthesis (e.g. `"42"` becomes `"forty-two"`, `"$50"` becomes `"fifty dollars"`). The timestamp mapping uses a forward scan with text-matching lookahead to re-sync after expanded tokens. Punctuation-only API entries (commas, periods) are skipped in the scan, but their timing gaps are preserved because the next word's `start_time` is naturally after the pause.

#### 3.1.2 Security

Localhost access is declared as `optional_host_permissions` in the manifest. The permission is only requested when the user enables the Kokoro backend in settings. If the user denies the permission, the backend selection reverts to Browser.

Settings updates use an allowlisted key loop instead of `Object.assign` to prevent prototype pollution. The Kokoro endpoint is validated against localhost (`127.0.0.1`, `localhost`, `[::1]`) before every fetch. Base64 audio payloads are capped at 15MB, MIME types are allowlisted, and timestamp arrays are capped at 5000 entries with type validation on each entry. Blob URLs are revoked on all exit paths. Stale async responses are guarded via object identity checks after all `await` points. A 3-strike failure counter stops playback if either backend fails repeatedly.

### 3.2 Highlighter (`lib/highlighter.js`)

The Highlighter is the single source of truth for the word list. It performs three operations in sequence:

1. **Prepare.** Walks the container's DOM using a `TreeWalker`, visits every text node, and wraps each word in a `<span class="tts-word">` element. Text nodes inside elements matching the skip selectors (navigation, ads, code blocks, screen-reader-only text, `aria-hidden` elements, etc.) are excluded. Text inside elements that are not visible (`display: none`, `visibility: hidden`) is also excluded via `Element.checkVisibility()`. If a selection `Range` is provided, the Highlighter collects the set of text nodes that intersect the range *before* wrapping (since wrapping replaces text nodes and invalidates the range), then tags each span created from those nodes. After wrapping, only tagged spans are retained.

2. **Build sentences.** The `getSentences()` method constructs sentence strings directly from the wrapped spans. A new sentence boundary is created when a block-level element boundary is detected (e.g., between two `<p>` tags) or when a word ends with sentence-ending punctuation. Because sentences are derived from the actual spans, the word count per sentence is always identical to the span count it covers.

3. **Highlight.** During playback, `highlightWord()` receives the character index and sentence index from the TTS engine's boundary event, maps them to a global word span index, and applies inline styles to the active span. The mapping is always index-based, never text-based, which prevents highlighting drift caused by punctuation or whitespace differences.

The Highlighter also implements focus mode, which dims all words except the active sentence or visual line using CSS opacity. Visual line detection works by comparing `getBoundingClientRect().top` values of adjacent spans.

On cleanup, all injected spans are replaced with their original text nodes. Parent elements are collected in a `Set` and `Node.normalize()` is called once per unique parent to merge adjacent text nodes back together. This ensures no residual DOM modifications remain after the extension stops.

The Highlighter's `updateSettings` method uses a key allowlist to prevent stray properties from accumulating, and validates hex color values before applying them.

### 3.3 Content Detection (`lib/text-extractor.js`)

This module provides two standalone functions for finding readable content on a page.

`findMainContent()` identifies the main content area using a heuristic approach. It first checks for semantic elements (`<article>`, `<main>`, `[role="main"]`) and common content class names (`.prose`, `.post-content`, `[itemprop="articleBody"]`, etc.). If none are found, it falls back to scoring `<div>` and `<section>` elements by text density, penalizing elements with a high ratio of link text. Scoring uses `innerText` rather than `textContent` so that hidden content (collapsed accordions, inactive tabs, etc.) does not inflate element scores.

`findContainerFor(el)` finds the best content container that includes a given element. This is used by "Read from here" and element picker modes to ensure the container actually contains the starting point. It tries semantic ancestors first, then checks if `findMainContent()` contains the element, then walks up the DOM to find the broadest block-level ancestor with substantial text.

The "Read from here" context menu uses `document.caretPositionFromPoint()` / `document.caretRangeAtPoint()` to resolve the right-click position to the nearest text node, rather than relying on the raw `event.target` which may be a non-text element.

## 4. Message Flow

All inter-component communication uses `chrome.runtime.sendMessage` and `chrome.tabs.sendMessage`. Every message listener validates the sender with `sender.id === chrome.runtime.id` to reject messages from other extensions or web pages.

### 4.1 Playback Initiation

```
User clicks Play in popup
    popup.js sends {type: 'play', mode: 'fullpage'} to content script
    content.js calls startReading()
    findMainContent() identifies the container
    Highlighter.prepare() wraps words in spans
    Highlighter.getSentences() builds the sentence list
    TTSEngine.play(sentences) begins speaking
    TTSEngine fires onSentenceStart(0) → content.js sends progress with wordCount/wordsRead
    TTSEngine fires onStateChange('playing')
    content.js sends {type: 'stateChanged', state: 'playing'} to popup
    popup.js updates button visibility and progress bar
```

### 4.2 Word Highlighting During Playback

Browser backend:
```
Browser fires SpeechSynthesisUtterance boundary event
    TTSEngine calls onBoundary(charIndex, charLength, sentenceIndex)
    content.js forwards to Highlighter.highlightWord()
    Highlighter maps charIndex to global word span index
    Highlighter applies inline styles to the active span
    Highlighter scrolls the span into view if auto-scroll is enabled
```

Kokoro backend:
```
requestAnimationFrame tick reads audio.currentTime
    TTSEngine finds matching word via timestamp lookup
    TTSEngine calls onBoundary(charIndex, charLength, sentenceIndex)
    (same flow as browser backend from here)
```

### 4.3 Keyboard Shortcuts

Keyboard shortcuts are handled directly in `content.js` via a `keydown` listener on `document`. They do not route through the popup or background script.

```
Alt + R              Start full page read (stops any current session).
Alt + P              Play or pause toggle.
Alt + S              Stop playback and clean up highlights.
Alt + Shift + Right  Skip to next sentence.
Alt + Shift + Left   Skip to previous sentence.
Alt + Shift + Up     Increase speed by 0.1x (max 3.0x).
Alt + Shift + Down   Decrease speed by 0.1x (min 0.5x).
```

Speed changes from keyboard shortcuts are persisted to `chrome.storage.local` and broadcast to the popup so the slider stays synchronized.

## 5. Storage

All settings are stored in `chrome.storage.local`. No sync storage or external persistence is used. The following keys are stored:

```
voiceURI          String or null. The selected browser voice identifier.
rate              Float, 0.5 to 3.0. Playback speed multiplier.
pitch             Float, 0.5 to 2.0. Voice pitch (browser backend only).
volume            Float, 0.0 to 1.0. Playback volume.
highlightBg       String. CSS hex color for word highlight background.
highlightFg       String. CSS hex color for word highlight text.
mode              String. One of: fullpage, readfromhere, element, selection.
skipCodeBlocks    Boolean. Whether to skip <pre> and <code> elements.
skipAltText       Boolean. Whether to skip image alt text.
skipLinks         Boolean. Whether to skip link text.
neonHighlight     Boolean. Whether to apply a glow effect to the active word.
punctuationPauses Boolean. Whether punctuation forces a sentence break.
focusMode         String. One of: off, sentence, line.
autoScroll        Boolean. Whether to scroll the active word into view.
ttsBackend        String. One of: browser, kokoro. Default: browser.
kokoroEndpoint    String. Kokoro API base URL. Default: http://localhost:8880.
kokoroVoice       String. Kokoro voice identifier. Default: af_alloy.
```

Settings defaults are defined once in `lib/config.js` as `SETTINGS_DEFAULTS` and shared across content scripts, popup, and options page.

## 6. Reading Modes

### 6.1 Full Page

The default mode. TextExtractor identifies the main content area and the Highlighter wraps all words within it. Navigation, sidebars, footers, ads, and other non-content elements are excluded via skip selectors.

### 6.2 Selected Text

Reads only the user's current text selection. The content script obtains the selection `Range` and finds the nearest content container via `findContainerFor()`. The Highlighter collects text nodes intersecting the range before wrapping, tags spans derived from those nodes during wrapping, and filters to only tagged spans afterward. This approach survives the DOM mutation that wrapping causes (replacing text nodes with spans invalidates the original range).

### 6.3 Pick Section (Element Mode)

Activates a click picker. The page cursor changes to crosshair and the next click selects a target element. A `Range` is created around the clicked element and playback begins from that element only.

### 6.4 Read From Here

Similar to element mode but reads from the clicked element to the end of the content container. Can also be triggered via the right-click context menu, which uses `caretPositionFromPoint` / `caretRangeAtPoint` to resolve the right-click coordinates to the nearest text node, then finds a content container via `findContainerFor()` with containment validation.

## 7. Content Script Injection

Content scripts are declared statically in `manifest.json` with `"matches": ["<all_urls>"]`. This means the four library files and CSS are injected into every page on load.

The content script uses a global initialization guard (`window.__listenCarefullyInitialized`) to prevent duplicate initialization if the script is injected more than once.

On page unload, the `beforeunload` handler stops the TTS engine and calls `Highlighter.cleanup()` to restore the original DOM.

## 8. Theme Detection

The extension icon adapts to the user's system theme. On startup, the background service worker probes the active tab's `prefers-color-scheme` media query via `chrome.scripting.executeScript`. Content scripts also send a `themeDetected` message whenever the media query changes. The service worker switches between light and dark icon sets accordingly.

The popup and options page apply a `dark` class to the body element based on the same media query, enabling CSS-based dark mode without JavaScript style manipulation.

## 9. File Structure

```
listen-carefully/
    manifest.json              Extension manifest (Manifest V3). Includes optional_host_permissions
                               for localhost, requested only when Kokoro is enabled.
    background.js              Service worker. Icon theming and context menu.
    content.js                 Content script orchestrator. Playback lifecycle and messaging.
    content.css                Injected styles for word highlights and focus mode.
    lib/
        config.js              Shared constants: settings defaults, skip selectors, Kokoro voice formatting.
        tts-engine.js          Dual-backend TTS engine (Web Speech API + Kokoro).
        highlighter.js         DOM word wrapping, index-based highlighting, focus mode.
        text-extractor.js      Content detection: findMainContent, findContainerFor.
    popup/
        popup.html             Popup markup.
        popup.js               Popup logic. Playback controls and settings.
        popup.css              Popup styles.
    options/
        options.html           Options page markup.
        options.js             Options page logic. Full settings and voice preview.
        options.css            Options page styles.
    icons/
        icon-16-dark.png       Toolbar icon variants for light and dark themes
        icon-16-light.png      at 16px, 48px, and 128px sizes.
        icon-48-dark.png
        icon-48-light.png
        icon-128-dark.png
        icon-128-light.png
        icon-16.png            Default icon set (dark variant).
        icon-48.png
        icon-128.png
```

## 10. Development Notes

### 10.1 Voice Loading

`speechSynthesis.getVoices()` may return an empty array on the first call. The TTS engine listens for the `voiceschanged` event and reloads the voice list when it fires. The `getVoices` message handler in `content.js` includes a 300ms retry for cases where the popup requests voices before the browser has populated them.

### 10.2 Chromium Utterance Limit

Chromium silently terminates utterances after approximately 15 seconds of continuous speech. The sentence-level queue in TTSEngine is the primary mitigation. Sentences should remain short enough to stay under this limit at 1.0x speed.

Chromium also silently kills paused utterances after approximately 15 seconds, causing `speechSynthesis.resume()` to do nothing. The `resume()` method tracks pause duration via `_pausedAt` and re-speaks the current sentence from the start if more than 14 seconds have elapsed.

### 10.3 Extension Context Invalidation

When the extension is reloaded during development, content scripts on already-open pages lose their connection to the extension runtime. The `safeCall` wrapper in `content.js` and the `.catch(() => {})` on all `sendMessage` calls prevent errors from surfacing in these situations. The TTS engine (which lives in the page's `speechSynthesis` context) may continue firing events after invalidation, so all engine callbacks are wrapped.

### 10.4 Settings Synchronization

Settings defaults are defined once in `lib/config.js` as the `SETTINGS_DEFAULTS` object. This file is loaded by content scripts (via `manifest.json`), the popup (via `<script>` tag in `popup.html`), and the options page (via `<script>` tag in `options.html`). When adding a new setting, update `SETTINGS_DEFAULTS` in `config.js` and it is available everywhere.

### 10.5 Browser Compatibility

The extension targets Chromium browsers (Chrome, Brave, Edge). Brave may block content script injection on certain pages when Shields are enabled. The `speechSynthesis` API availability should be verified in the content script context, as some internal browser pages (`chrome://`, `brave://`) do not support it.
