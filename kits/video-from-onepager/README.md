# Kit: one-pager to promo video

Turns a client one-pager into a ~50-60 s 1080p MP4 with voiceover and music. Local only, no ffmpeg, no Homebrew,
no uploads. Built Nov 2026 for the Positive Tribes one-pager. Sets: Chrome + Swift (AVFoundation) + pinned `puppeteer-core`.

## Make a new one
1. Copy this folder. Edit `scene.html`: palette tokens at the top, one `<section class="scene">` per scene, element timings in
   `data-s` / `data-e` (seconds). Scene windows live in `DEFAULT_WARP` and `DESIGN` in `prep_vo.py`; keep them in sync.
2. `npm ci --ignore-scripts` (puppeteer-core 24.15.0, uses installed Google Chrome).
3. Write the voiceover lines (7 in the original; change `VO`/`DESIGN` if the scene count changes). Record one take with 2 s of
   silence between lines, put it in `vo/mine/all.m4a`. (No recording yet: say lines with `say -v "Zoe (Premium)"` into `vo/l1.wav`...)
4. `python3 -I prep_vo.py`  -> splits lines, writes `timings.json` (scenes stretch to fit each line).
5. `python3 -I mix.py`      -> `mix.wav` (synth music ducked under voice, no licensing issues).
6. `node render.mjs scene.html frames 30`, then `swiftc -O encode.swift -o encode && ./encode frames 30 out.mp4 mix.wav`.

## Gotchas
- `puppeteer-core` pulls a vulnerable FTP parser (basic-ftp DoS), unused here (proxy PAC only). Always `--ignore-scripts`.
- afconvert writes WAVE_FORMAT_EXTENSIBLE; `prep_vo.py` parses RIFF chunks itself for that reason.
- Apple's built-in voices may limit commercial use; use a human voice for paid ads.
- Don't commit recordings or rendered frames (see .gitignore).
- `encode.swift` writes the MP4 with the `moov` box at the end (no fast start). LinkedIn's uploader failed on it once (Nov 2026,
  cause not confirmed). Before uploading, re-export a copy with `avconvert --preset Preset1920x1080 --source out.mp4 --output out-web.mp4`,
  which puts `moov` first.
- The LinkedIn "We encountered a problem sharing your post" error in Nov 2026 was caused by the custom thumbnail upload, not the video.
  Post without a thumbnail (pick a frame after posting). Text-only posts worked throughout, so bisect: text only, then video without thumbnail.
- `encode.swift` now asks for 12 Mbps plus `AVVideoQualityKey` 0.95 (8 Mbps alone undershot to about 1.2 Mbps on flat frames and looked gritty)
  and tags the video BT.709 (untagged color showed as warnings in `avmediainfo`). Check a render with `avmediainfo out.mp4`.
