# Technical Documentation: Listen Carefully

## 1. Overview

Listen Carefully is a Chromium-based browser extension that converts webpage text to speech using the Web Speech API. It highlights the currently spoken word in real time on the page, supports multiple reading modes, and operates entirely within the browser with no external network dependencies.

The extension is built on Manifest V3 and targets Chrome and Brave on Windows 11, where Microsoft neural voices provide high quality speech synthesis through the operating system.

## 2. Architecture

The extension consists of four layers that communicate through Chrome's messaging API.

### 2.1 Background Service Worker

File: `background.js`

The service worker is the only component that persists across tab changes. It has two responsibilities: switching the toolbar icon between light and dark variants based on the active page's color scheme, and managing the right-click context menu entry ("Read from here"). It does not handle any TTS logic.

The service worker receives theme detection messages from content scripts and forwards context menu click events to the appropriate tab's content script.

### 2.2 Content Script Layer

Files: `content.js`, `lib/tts-engine.js`, `lib/highlighter.js`, `lib/text-extractor.js`

These four files are injected into every page via the `content_scripts` manifest entry. They run in an isolated world, meaning they share the page's DOM but not its JavaScript scope. The `speechSynthesis` API is only available in this context, not in the service worker.

`content.js` is the orchestrator. It instantiates the three library classes, wires up callbacks between them, handles all incoming messages from the popup and background script, registers keyboard shortcuts, and manages the reading lifecycle.

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

This class wraps the Web Speech Synthesis API and manages a sentence-level playback queue. The queue design exists to work around a known Chromium limitation where utterances longer than approximately 15 seconds are silently terminated by the browser.

Each sentence is spoken as an individual `SpeechSynthesisUtterance`. When an utterance finishes, the engine automatically advances to the next sentence in the queue. The engine exposes four callbacks that the orchestrator connects to:

```
onBoundary(charIndex, charLength, sentenceIndex)    Called on each word boundary during speech.
onSentenceStart(sentenceIndex)                       Called when a new sentence begins.
onStateChange(state)                                 Called when playback state changes (playing, paused, stopped).
onEnd()                                              Called when the entire queue has been spoken.
```

The `_skipping` flag is a guard that prevents `speechSynthesis.cancel()` from triggering the `onend` handler during skip and stop operations. Without this guard, cancelling the current utterance would cause the engine to advance to the next sentence instead of stopping.

Settings changes (voice, rate, pitch, volume) take effect immediately during playback by cancelling and restarting the current sentence with the new parameters. If settings are changed while paused, a `_settingsChangedWhilePaused` flag causes the next `resume()` call to re-speak the current sentence with the updated parameters instead of resuming the stale utterance.

### 3.2 Highlighter (`lib/highlighter.js`)

The Highlighter is the single source of truth for the word list. It performs three operations in sequence:

1. **Prepare.** Walks the container's DOM using a `TreeWalker`, visits every text node, and wraps each word in a `<span class="tts-word">` element. Text nodes inside elements matching the skip selectors (navigation, ads, code blocks, screen-reader-only text, `aria-hidden` elements, etc.) are excluded. Text inside elements that are not visible (`display: none`, `visibility: hidden`) is also excluded via `Element.checkVisibility()`. If a selection `Range` is provided, only spans whose source text node intersects the range are retained.

2. **Build sentences.** The `getSentences()` method constructs sentence strings directly from the wrapped spans. A new sentence boundary is created when a block-level element boundary is detected (e.g., between two `<p>` tags) or when a word ends with sentence-ending punctuation. Because sentences are derived from the actual spans, the word count per sentence is always identical to the span count it covers.

3. **Highlight.** During playback, `highlightWord()` receives the character index and sentence index from the TTS engine's boundary event, maps them to a global word span index, and applies inline styles to the active span. The mapping is always index-based, never text-based, which prevents highlighting drift caused by punctuation or whitespace differences.

The Highlighter also implements focus mode, which dims all words except the active sentence or visual line using CSS opacity. Visual line detection works by comparing `getBoundingClientRect().top` values of adjacent spans.

On cleanup, all injected spans are replaced with their original text nodes and `Node.normalize()` merges adjacent text nodes back together. This ensures no residual DOM modifications remain after the extension stops.

### 3.3 TextExtractor (`lib/text-extractor.js`)

The TextExtractor identifies the main content area of a page using a heuristic approach. It first checks for semantic elements (`<article>`, `<main>`, `[role="main"]`) and common content class names. If none are found, it falls back to scoring `<div>` and `<section>` elements by text density, penalizing elements with a high ratio of link text. Scoring uses `innerText` rather than `textContent` so that hidden content (collapsed accordions, inactive tabs, etc.) does not inflate element scores.

The TextExtractor is used primarily for its `findMainContent()` method, which returns a DOM element. The actual word wrapping and text extraction for TTS is handled by the Highlighter, which operates on the container element that `findMainContent()` returns.

## 4. Message Flow

All inter-component communication uses `chrome.runtime.sendMessage` and `chrome.tabs.sendMessage`. Every message listener validates the sender with `sender.id === chrome.runtime.id` to reject messages from other extensions or web pages.

### 4.1 Playback Initiation

```
User clicks Play in popup
    popup.js sends {type: 'play', mode: 'fullpage'} to content script
    content.js calls startReading()
    TextExtractor.findMainContent() identifies the container
    Highlighter.prepare() wraps words in spans
    Highlighter.getSentences() builds the sentence list
    TTSEngine.play(sentences) begins speaking
    TTSEngine fires onStateChange('playing')
    content.js sends {type: 'stateChanged', state: 'playing'} to popup
    popup.js updates button visibility
```

### 4.2 Word Highlighting During Playback

```
Browser fires SpeechSynthesisUtterance boundary event
    TTSEngine calls onBoundary(charIndex, charLength, sentenceIndex)
    content.js forwards to Highlighter.highlightWord()
    Highlighter maps charIndex to global word span index
    Highlighter applies inline styles to the active span
    Highlighter scrolls the span into view if auto-scroll is enabled
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
voiceURI          String or null. The selected voice identifier.
rate              Float, 0.5 to 3.0. Playback speed multiplier.
pitch             Float, 0.5 to 2.0. Voice pitch.
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
```

Settings defaults are defined in three locations: `content.js` (loadSettings), `popup/popup.js` (loadSettings), and `options/options.js` (DEFAULTS constant). All three must be kept in sync when adding or modifying settings.

## 6. Reading Modes

### 6.1 Full Page

The default mode. TextExtractor identifies the main content area and the Highlighter wraps all words within it. Navigation, sidebars, footers, ads, and other non-content elements are excluded via skip selectors.

### 6.2 Selected Text

Reads only the user's current text selection. The content script obtains the selection `Range`, finds the nearest content container, and passes the range to the Highlighter. The Highlighter wraps all words in the container but filters out spans that do not intersect the selection range.

### 6.3 Pick Section (Element Mode)

Activates a click picker. The page cursor changes to crosshair and the next click selects a target element. A `Range` is created around the clicked element and playback begins from that element only.

### 6.4 Read From Here

Similar to element mode but reads from the clicked element to the end of the content container. Can also be triggered via the right-click context menu, which uses the last right-clicked element stored in `content.js`.

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
    manifest.json              Extension manifest (Manifest V3).
    background.js              Service worker. Icon theming and context menu.
    content.js                 Content script orchestrator. Playback lifecycle and messaging.
    content.css                Injected styles for word highlights and focus mode.
    lib/
        tts-engine.js          SpeechSynthesis wrapper with sentence queue management.
        highlighter.js         DOM word wrapping, index-based highlighting, focus mode.
        text-extractor.js      Main content detection and text preprocessing.
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

Settings defaults are duplicated across `content.js`, `popup/popup.js`, and `options/options.js`. When adding a new setting, all three locations must be updated. A future improvement would be to extract defaults into a shared module.

### 10.5 Browser Compatibility

The extension targets Chromium browsers (Chrome, Brave, Edge). Brave may block content script injection on certain pages when Shields are enabled. The `speechSynthesis` API availability should be verified in the content script context, as some internal browser pages (`chrome://`, `brave://`) do not support it.
