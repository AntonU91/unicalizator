# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev       # Start dev server (localhost:5173)
npm run build     # Production build
npm run preview   # Preview production build
npm run lint      # ESLint check
```

No test suite is configured.

## Architecture

This is a single-page React app (Vite + React 19, JS/JSX). The entire application logic lives in `src/App.jsx` — there are no sub-components, routing, or state management libraries.

### Core purpose

Client-side "uniqualization" of ad creatives (images and videos) for arbitrage use. Files are processed entirely in the browser — nothing is uploaded anywhere.

### Key design decisions

**External libraries loaded dynamically at runtime** (not bundled):
- `ffmpeg.wasm` (`@ffmpeg/ffmpeg@0.12.6` + `@ffmpeg/core@0.12.6`) — loaded via `<script>` injection from unpkg when the user adds a video file. Requires ~22 MB download on first use.
- `JSZip` — loaded on demand when processing begins.

**COOP/COEP headers are required** for `SharedArrayBuffer`, which ffmpeg.wasm depends on. These are set in `vite.config.js` and must be replicated in any production deployment:
```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

**ffmpeg singleton pattern**: A single ffmpeg instance is reused across calls (`ffmpegInstance`/`ffmpegLoaded` module-level vars). Progress callbacks are tracked separately via `currentProgressCb` so the singleton can still report progress per-operation without re-initialization.

**File naming**: Uses a module-level counter (`fileCounter`) for ffmpeg virtual FS filenames to avoid collisions across multiple sequential encodes.

### Uniqualization techniques

- **Images** (`uniqualizeImage`): Canvas API — micro-rotation (±1.5°), brightness/contrast/saturation tweak (±0.5%), per-pixel noise (±4), EXIF stripped via canvas re-encode.
- **Videos** (`uniqualizeVideo`): ffmpeg.wasm — `eq` filter for color, `setpts` for speed (±1%), `asetrate`+`atempo` for audio pitch/speed, metadata stripped with `-map_metadata -1`. Output is always MP4/H.264+AAC regardless of input format.

### Output

Each input file gets its own ZIP archive (`<basename>_uniqualized.zip`) containing N uniqualized copies named `<basename>_uq1`, `_uq2`, etc. ZIPs are triggered as browser downloads sequentially with a 400 ms delay between them.
