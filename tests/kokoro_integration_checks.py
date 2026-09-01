#!/usr/bin/env python3
"""Assert that a Kokoro-FastAPI server still satisfies everything the extension needs.

Run against any base URL. The shell wrapper (kokoro-integration-test.sh) points this
at a throwaway container, but it works against a server you already have running:

    python3 tests/kokoro_integration_checks.py http://localhost:8880

Stdlib only, so there is nothing to install. Exit code 0 means the extension's
contract holds; 1 means at least one check failed.
"""

import json
import sys
import urllib.error
import urllib.request

TIMEOUT = 180  # first synthesis on a cold CPU container is slow

# Mirrors lib/config.js. The options page groups the dropdown by these prefixes.
KOKORO_LANGS = set("abefhijpz")
KOKORO_GENDERS = set("fm")

results = []


def check(name):
    """Register a check. The wrapped function returns a detail string or raises."""

    def wrap(fn):
        try:
            detail = fn()
            results.append((True, name, detail or ""))
        except Exception as exc:  # noqa: BLE001 - any failure is a failed check
            results.append((False, name, f"{type(exc).__name__}: {exc}"))
        return fn

    return wrap


def get(url):
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return r.status, r.headers.get("Content-Type", ""), r.read()


def post(url, payload):
    body = json.dumps(payload).encode()
    req = urllib.request.Request(
        url, data=body, headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return r.status, r.headers.get("Content-Type", ""), r.read()


def parse_voices_like_the_extension(data):
    """Byte-for-byte behaviour of the parser in options/options.js.

    Keep these two in sync. If this stops yielding IDs, the voice dropdown is
    empty for real users.
    """
    voices = data.get("voices")
    if not isinstance(voices, list):
        return []
    out = []
    for v in voices:
        vid = v if isinstance(v, str) else (v.get("id") if isinstance(v, dict) else None)
        if isinstance(vid, str) and vid:
            out.append(vid)
    return out


def main(base):
    base = base.rstrip("/")

    @check("GET /health responds")
    def _():
        status, _, _body = get(f"{base}/health")
        assert status == 200, f"expected 200, got {status}"
        return "200"

    @check("GET /v1/models responds (README verification step)")
    def _():
        status, _, _body = get(f"{base}/v1/models")
        assert status == 200, f"expected 200, got {status}"
        return "200"

    voice_ids = []

    @check("GET /v1/audio/voices parses with the extension's parser")
    def _():
        status, _, body = get(f"{base}/v1/audio/voices")
        assert status == 200, f"expected 200, got {status}"
        data = json.loads(body)
        ids = parse_voices_like_the_extension(data)
        assert ids, (
            "parser yielded 0 voices. The response shape changed again. Raw first "
            f"entry: {json.dumps((data.get('voices') or [None])[0])[:200]}"
        )
        voice_ids.extend(ids)
        first = (data.get("voices") or [None])[0]
        shape = "objects" if isinstance(first, dict) else "strings"
        return f"{len(ids)} voices, shape={shape}"

    @check("GET /v1/audio/voices?legacy=true still returns plain strings")
    def _():
        status, _, body = get(f"{base}/v1/audio/voices?legacy=true")
        assert status == 200, f"expected 200, got {status}"
        data = json.loads(body)
        vs = data.get("voices")
        assert isinstance(vs, list) and vs, "no voices in legacy response"
        assert all(isinstance(v, str) for v in vs), "legacy shape is no longer strings"
        return f"{len(vs)} voices"

    @check("Voice IDs still match the {lang}{gender}_{name} grouping pattern")
    def _():
        assert voice_ids, "skipped: no voices parsed"
        known = [
            v
            for v in voice_ids
            if len(v) >= 4
            and v[2] == "_"
            and v[0] in KOKORO_LANGS
            and v[1] in KOKORO_GENDERS
        ]
        ungrouped = [v for v in voice_ids if v not in known]
        # Ungrouped voices still render, just without a language optgroup, so this
        # is a warning-level fact rather than a hard failure.
        assert known, f"no voice matched the pattern; all {len(voice_ids)} ungrouped"
        return f"{len(known)} grouped, {len(ungrouped)} ungrouped" + (
            f" ({', '.join(ungrouped[:5])})" if ungrouped else ""
        )

    probe_voice = "am_adam"

    @check("POST /v1/audio/speech returns audio (Test Connection + voice preview)")
    def _():
        voice = probe_voice if probe_voice in voice_ids else (voice_ids or ["am_adam"])[0]
        status, ctype, body = post(
            f"{base}/v1/audio/speech",
            {
                "model": "kokoro",
                "voice": voice,
                "input": "Kokoro TTS connection test successful.",
                "speed": 1.0,
            },
        )
        assert status == 200, f"expected 200, got {status}"
        assert ctype.startswith("audio/"), f"expected audio/*, got {ctype!r}"
        assert len(body) > 1000, f"suspiciously small payload: {len(body)} bytes"
        return f"{ctype}, {len(body)} bytes"

    @check("POST /dev/captioned_speech returns base64 audio plus word timestamps")
    def _():
        voice = probe_voice if probe_voice in voice_ids else (voice_ids or ["am_adam"])[0]
        status, _, body = post(
            f"{base}/dev/captioned_speech",
            {
                "model": "kokoro",
                "voice": voice,
                "input": "Hello world, this is a timestamp test.",
                "speed": 1.0,
                "response_format": "mp3",
                "stream": False,
                "return_timestamps": True,
            },
        )
        assert status == 200, f"expected 200, got {status}"
        data = json.loads(body)

        for key in ("audio", "audio_format", "timestamps"):
            assert key in data, f"missing key {key!r}; got {sorted(data)}"

        assert isinstance(data["audio"], str) and data["audio"], "audio is not a string"
        assert data["audio_format"].startswith("audio/"), (
            f"unexpected audio_format {data['audio_format']!r}"
        )

        ts = data["timestamps"]
        assert isinstance(ts, list) and ts, "timestamps empty; word highlighting breaks"
        for entry in ts[:5]:
            assert isinstance(entry, dict), f"timestamp entry is {type(entry).__name__}"
            assert "word" in entry, f"timestamp missing 'word': {entry}"
            assert "start_time" in entry, f"timestamp missing 'start_time': {entry}"
            assert isinstance(entry["start_time"], (int, float)), (
                f"start_time is {type(entry['start_time']).__name__}, not a number"
            )

        words = [e["word"] for e in ts]
        assert "Hello" in words, f"expected 'Hello' in timestamps, got {words[:8]}"
        return f"{len(ts)} timestamps, first={words[0]!r}"

    width = max(len(n) for _, n, _ in results)
    print()
    for ok, name, detail in results:
        mark = "PASS" if ok else "FAIL"
        print(f"  [{mark}] {name.ljust(width)}  {detail}")

    failed = [r for r in results if not r[0]]
    print()
    if failed:
        print(f"{len(failed)} of {len(results)} checks FAILED against {base}")
        return 1
    print(f"All {len(results)} checks passed against {base}")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(2)
    sys.exit(main(sys.argv[1]))
