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

Single-page React app (Vite + React 19, JS/JSX). All application logic lives in `src/App.jsx` — no sub-components, routing, or state management libraries.

### Core purpose

Client-side "uniqualization" of ad creatives (images and videos) for traffic arbitrage. Everything runs in the browser; no files leave the user's machine.

### ffmpeg loading — critical design constraint

**The ESM build of `@ffmpeg/ffmpeg` must NOT be used.** It creates a `{type: "module"}` Worker, which disables `importScripts()`. The UMD core (`ffmpeg-core.js`) is not an ES module, so dynamic `import()` returns no exports → `ERROR_IMPORT_FAILURE` with zero network requests.

**Current approach:** the UMD build (`/ffmpeg.js`) is loaded via a `<script>` tag from `public/`. This creates a classic Worker (`{type: void 0}`) that can call `importScripts(coreURL)`, which works correctly with the UMD core.

**Files that must stay in `public/` and must be kept in sync when updating versions:**
| File | Source |
|------|--------|
| `public/ffmpeg.js` | `node_modules/@ffmpeg/ffmpeg/dist/umd/ffmpeg.js` |
| `public/814.ffmpeg.js` | `node_modules/@ffmpeg/ffmpeg/dist/umd/814.ffmpeg.js` (Worker chunk — filename may change between versions) |
| `public/ffmpeg-core.js` | `node_modules/@ffmpeg/core/dist/umd/ffmpeg-core.js` |
| `public/ffmpeg-core.wasm` | `node_modules/@ffmpeg/core/dist/umd/ffmpeg-core.wasm` |

After `npm install` the public files are NOT auto-updated — copy them manually with:
```bash
cp node_modules/@ffmpeg/ffmpeg/dist/umd/ffmpeg.js public/
cp node_modules/@ffmpeg/ffmpeg/dist/umd/814.ffmpeg.js public/   # verify chunk name
cp node_modules/@ffmpeg/core/dist/umd/ffmpeg-core.js public/
cp node_modules/@ffmpeg/core/dist/umd/ffmpeg-core.wasm public/
```

**Version pinning:** `@ffmpeg/ffmpeg` and `@ffmpeg/core` must use matching versions. Currently both at `0.12.6`.

### COOP/COEP headers — required for SharedArrayBuffer

Set in `vite.config.js` for the dev server. **Must be replicated in any production deployment**, otherwise ffmpeg.wasm will fail silently:
```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

`@ffmpeg/ffmpeg` and `@ffmpeg/util` are in `optimizeDeps.exclude` — do not remove this or Vite will break the Worker URL resolution.

### ffmpeg singleton

Module-level `ffmpegInstance`/`ffmpegLoaded` vars ensure a single FFmpeg instance is reused. Progress callbacks are tracked separately via `currentProgressCb` so the singleton reports per-operation progress without re-initialization. File counter (`fileCounter`) provides unique names for ffmpeg's virtual FS to avoid collisions across sequential encodes.

### Uniqualization techniques

- **Images** (`uniqualizeImage`): Canvas API — micro-rotation (±1.5°), brightness factor (±0.5%), contrast factor around 1.0 (±0.5%), saturation (±1%), per-pixel noise (±4 per channel), EXIF stripped via canvas re-encode at quality 0.92.
- **Videos** (`uniqualizeVideo`): ffmpeg `eq` filter (brightness ±0.01, contrast centered at **1.0** ±0.01, saturation ±0.02), `setpts` for speed (±1%), `asetrate`+`atempo` for audio pitch/speed, `-map_metadata -1` strips all metadata. Output is always MP4/H.264+AAC. Exit code from `ff.exec()` is checked before reading output file.

### Output

Each input file → its own ZIP (`<basename>_uniqualized.zip`) with N copies named `<basename>_uq1.ext` … `_uqN.ext`. ZIPs trigger as sequential browser downloads with 400 ms delay between them.
