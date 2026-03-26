# Listen Carefully

A browser extension that reads web pages aloud with real-time word-level highlighting. Built on the Web Speech API, it runs entirely within the browser with no external services, network requests, or data collection.

> **Listen Carefully is a personal hackathon project motivated by the challenge of studying from high-density educational sources. The goal was to build a focused and refined way to listen through dense material rather than read it, and this is exactly that. The project is in its early phase, so bug reports and pull requests are welcome through GitHub.**

## Features

1. **Word-level highlighting.** The currently spoken word is highlighted directly on the page with configurable colors and an optional neon glow effect.
2. **Multiple reading modes.** Full page, selected text, pick a section, or read from a specific point on the page.
3. **Focus mode.** Dims the surrounding text to show only the active sentence or line, designed for users who benefit from reduced visual noise.
4. **Keyboard shortcuts.** Play, pause, stop, skip, and adjust speed without touching the mouse.
5. **Voice selection.** Access all voices installed on your system, including Windows 11 and macOS neural voices, grouped by language.
6. **Fully offline.** No API keys, no accounts, no telemetry. All processing happens locally in your browser. Whether speech synthesis itself stays offline depends on the voice selected in your operating system or browser, not on this extension.

## Installation

### From source

1. Clone this repository.
2. Open your browser and navigate to `chrome://extensions` (or `brave://extensions`).
3. Enable "Developer mode" in the top right corner.
4. Click "Load unpacked" and select the `listen-carefully` directory.

### Voice setup

The extension uses the voices provided by your operating system. For the best speech quality, install additional voices through your OS settings.

**Windows 11:**

1. Open **Settings** and navigate to **Time & Language** then **Language & Region**.
2. Select your language and open **Language options**.
3. Under **Speech**, download the available voice packs.

The "Online (Natural)" voices (such as Microsoft Ava, Andrew, and Jenny) provide significantly higher quality than the legacy voices.

**Note:** voices labeled "Online" may connect to Microsoft's cloud services for speech synthesis. This is handled by the operating system, not by this extension. See the privacy policy for details.

**macOS:**

1. Open **System Settings** and navigate to **Accessibility** then **Spoken Content**.
2. Click **Manage Voices** to download additional voices.

The "Siri" and "Enhanced" voices provide higher quality than the default system voices.

**Note:** some macOS voices may connect to Apple's cloud services for speech synthesis. This is handled by the operating system, not by this extension. See the privacy policy for details.

## Usage

Click the extension icon in the toolbar to open the control panel. Select a reading mode, choose a voice, and press **Read** to begin. The extension will highlight each word as it is spoken and scroll the page to follow along.

### Keyboard shortcuts

| Action              | Shortcut             |
|---------------------|----------------------|
| Full page read      | Alt + R              |
| Play or pause       | Alt + P              |
| Stop                | Alt + S              |
| Next sentence       | Alt + Shift + Right  |
| Previous sentence   | Alt + Shift + Left   |
| Increase speed      | Alt + Shift + Up     |
| Decrease speed      | Alt + Shift + Down   |

### Reading modes

| Mode           | Description                                                    |
|----------------|----------------------------------------------------------------|
| Full Page      | Reads the main content of the page, skipping navigation and ads. |
| Selected Text  | Reads only the text you have selected on the page.             |
| Pick Section   | Click any element on the page to read that section.            |
| Read From Here | Click a starting point and read to the end of the content.     |

### Context menu

Right-click anywhere on a page and select **Read from here** to begin reading from that point.

## Settings

Open the full settings panel by clicking **Settings** at the bottom of the popup, or by right-clicking the extension icon and selecting **Options**.

Available settings include voice selection with preview, speed, volume, pitch, highlight colors with presets, neon glow toggle, content filtering (skip code blocks, alt text, links), punctuation-based sentence splitting, and focus mode (active sentence or active line).

## Technical documentation

See [TECHNICAL.md](TECHNICAL.md) for a detailed explanation of the architecture, module responsibilities, message flow, and development notes.

## Contributing

Contributions and suggestions are welcome. To contribute:

1. Fork the repository and create a feature branch.
2. Make your changes and verify that the extension loads and functions correctly.
3. Submit a pull request with a clear description of the change and its purpose.

There is no automated test suite at this time. Please test your changes manually across a variety of pages, including long-form articles, pages with code blocks, and pages with complex layouts.

By submitting a contribution, you agree that your changes are provided under the same license terms as this project.

## Privacy

Listen Carefully does not collect, store, or transmit any user data. All settings are stored locally on your device. No telemetry or analytics are included.

The full privacy policy is available at [listen.powertologic.com](https://listen.powertologic.com) and on the Chrome Web Store listing.

## License

Copyright (c) 2026 Power to Logic. All rights reserved.

This software is free to use for personal, educational, and internal business purposes. Redistribution in any form requires prior written consent and appropriate attribution. See [LICENSE](LICENSE) for the full terms.
