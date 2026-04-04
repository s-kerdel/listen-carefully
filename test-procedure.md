# Test Procedure

## Setup

1. Open `chrome://extensions`
2. Enable Developer mode
3. Click "Load unpacked" and select the `listen-carefully/` folder (or reload if already loaded)
4. Open a content-rich page (e.g. a Wikipedia article or blog post)

---

## 1. Selection Mode

**Goal:** Selected text is read, not the whole page or nothing.

1. Open a Wikipedia article
2. Select 2-3 words in the middle of a paragraph with your mouse
3. Open the extension popup, set mode to **Selected text**
4. Click **Read**

**Pass:** Only the selected words are spoken and highlighted.
**Fail:** Nothing happens, whole page is read, or "No readable text found" error.

---

## 2. Read From Here (non-semantic page)

**Goal:** Right-click starts reading from the clicked word on any site.

1. Open a page that uses plain `<div>` elements (most web apps, dashboards, or forums)
2. Find a paragraph in the middle of the page
3. Right-click on a word in that paragraph
4. Click **Read from here** in the context menu

**Pass:** Reading starts from the word you clicked and continues to the end of the content.
**Fail:** Reading starts from the top of the page, reads wrong content, or shows an error.

---

## 3. Config Loading

**Goal:** Shared config loads correctly in all extension contexts.

1. Open the extension popup (click the extension icon)
2. Right-click the extension icon and select **Options**
3. Open the browser console on both pages (F12 > Console)

**Pass:** No `ReferenceError: SETTINGS_DEFAULTS is not defined` or similar errors in the console. Popup and options page load normally.
**Fail:** Console shows reference errors for `SETTINGS_DEFAULTS`, `SKIP_SELECTORS`, `formatKokoroVoice`, or `KOKORO_LANGS`.

---

## 4. No Double Voice on Rapid Retrigger

**Goal:** Triggering "Read from here" multiple times produces only one voice.

1. Open any content page
2. Start reading (popup > Full page > Read)
3. While it's speaking, right-click a different paragraph and click **Read from here**
4. Immediately right-click yet another paragraph and click **Read from here** again

**Pass:** Only one voice is heard at all times. Each new "Read from here" cancels the previous.
**Fail:** Two or more voices speak simultaneously.

---

## 5. Progress Bar Accuracy

**Goal:** Progress bar reflects actual word progress, not sentence count.

1. Open a page with short bullet points at the top and long paragraphs below (e.g. a blog post with a summary list then detailed content)
2. Open the popup, set mode to **Full page**, click **Read**
3. Watch the progress bar and "time left" as it reads through the bullet points

**Pass:** Progress bar advances slowly through the bullets (they are few words). Time remaining stays high until the bulk of words have been read.
**Fail:** Progress bar jumps to 50%+ after reading the bullet points even though most text remains.

---

## 6. Popup Resets on Failed Playback

**Goal:** Popup does not get stuck on "Playing..." when playback fails to start.

1. Make sure no text is selected on the page
2. Open the popup, set mode to **Selected text**
3. Click **Read** (with nothing selected)

**Pass:** Error toast appears ("No text selected...") and the status resets to "Ready" within 1 second.
**Fail:** Status stays stuck on "Playing..." and only corrects after a few seconds.

---

## 7. Options Backend Switch Cancels Playback

**Goal:** Switching TTS backend stops any playing preview or test audio.

### 7a. Voice Preview

1. Open the Options page
2. Make sure TTS backend is set to **Browser**
3. Click **Preview voice** (let it speak)
4. While it's speaking, switch the TTS backend dropdown to **Kokoro**

**Pass:** Voice preview stops immediately. The Kokoro settings section appears.
**Fail:** Voice preview continues speaking after switching.

### 7b. Kokoro Test (requires Kokoro running)

1. Set TTS backend to **Kokoro**, enter a valid endpoint
2. Click **Test Connection** (let the test audio play)
3. While the test audio plays, switch backend back to **Browser**

**Pass:** Test audio stops. Test result message disappears.
**Fail:** Test audio keeps playing or test result stays visible.

---

## 8. Skip Navigation

**Goal:** Skip forward/backward works without audio glitches.

1. Start reading any page (Full page mode)
2. Wait for 2-3 sentences to be read
3. Press `Alt+Shift+Right` to skip forward
4. Press `Alt+Shift+Left` to skip backward
5. Repeat a few times rapidly

**Pass:** Each skip moves to the next/previous sentence. Highlighting stays in sync. Only one voice at all times.
**Fail:** Highlighting drifts from the spoken word, two voices overlap, or the extension stops responding.

---

## 9. Keyboard Stop and Restart

**Goal:** Keyboard shortcuts cleanly stop and restart playback.

1. Start reading any page
2. Press `Alt+S` to stop
3. Verify highlighting is removed and speech stops
4. Press `Alt+R` to start a fresh full-page read
5. Open the browser console (F12 > Console)

**Pass:** Playback stops and restarts cleanly. No errors in the console.
**Fail:** Old highlighting remains, console shows errors, or the extension gets stuck.

---

## 10. Kokoro Timeout

**Goal:** Options page fetch doesn't hang forever when Kokoro is unreachable.

1. Open the Options page
2. Set TTS backend to **Kokoro**
3. Set the endpoint to `http://localhost:9999` (a port with nothing running)
4. Click **Test Connection**
5. Wait up to 20 seconds

**Pass:** After ~15 seconds, shows "Failed: Request timed out".
**Fail:** The "Connecting..." message stays forever and never resolves.
