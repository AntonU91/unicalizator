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

Single-page React app (Vite + React 19, JS/JSX). All application logic lives in `src/App.jsx` — no sub-components, routing, or state management libraries. All styles are inline via a single `S` object at the bottom of the file.

### Core purpose

Client-side "uniqualization" of ad creatives (images and videos) for traffic arbitrage. Everything runs in the browser; no files leave the user's machine.

### Three-tab structure

**Tab 1 — Уникализация** (`activeTab === "uniqualize"`):
- *File mode*: drag individual files, set N copies per file → one ZIP per file with N uniqualized copies, downloaded immediately as each ZIP completes.
- *Folder mode* (separate section within the same tab): select a flat folder, set N duplicates → N ZIPs, each containing all folder files uniqualized independently. Downloaded immediately as each ZIP completes. ZIP named `{folder_name}_dup{N}.zip`; files inside named `{basename}_uq.ext`.

**Tab 2 — Сжатие** (`activeTab === "compress"`): video-only compression to a target size (optimal −40%, heavy −80%, or custom MB) using ffmpeg two-pass bitrate targeting. Output: `{basename}_compressed.mp4`, downloaded immediately per file.

**Tab 3 — Пакет** (`activeTab === "batch"`): selects multiple flat directories, runs N iterations — each iteration picks one file per directory (sorted order, modulo wrap-around) and downloads a ZIP named `batch_iter{N}.zip`. Files inside named `b{iter}_{filename}`. No uniqualization — files are packed as-is.

### Shared state and concurrency

- `cancelRef` (a `useRef`) is shared across all three tabs. All processing loops check `cancelRef.current` to stop. Cancel also calls `handleCancel()` which terminates and reinitializes the ffmpeg instance.
- Each tab has its own `processing` flag (`processing`, `compProcessing`, `batchProcessing`, `folderProcessing`). All four start-processing handlers guard against the other three being active to prevent concurrent ffmpeg use.
- `ffmpegInstance`/`ffmpegLoaded` are module-level singletons. `currentProgressCb` is also module-level so the singleton can report per-operation progress without re-init.
- `fileCounter` (module-level) generates unique filenames for ffmpeg's virtual FS to avoid collisions across sequential encodes.

### Directory reading — two APIs, unified interface

Two code paths both produce `{ name, handle: { getFile() → Promise<File> }, type: string }` entries:

1. **`window.showDirectoryPicker()`** (File System Access API, Chrome/Edge 86+): used for single-folder selection. Returns `FileSystemFileHandle` — stored directly as `handle`.
2. **`webkitGetAsEntry()` + `readDirEntry()`** (drag-drop API, broader support): used for drag-and-drop of one or more folders. `readDirEntry` wraps the `File` object as `{ getFile: () => Promise.resolve(file) }` to match the same interface. Must loop `reader.readEntries()` until it returns an empty array (browser limit: 100 entries per call).

Both paths filter to `image/*` and `video/*` only, sort by name (numeric-aware), and store `type` for pre-flight ffmpeg-load detection.

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

### Uniqualization techniques

- **Images** (`uniqualizeImage`): Canvas API — micro-rotation (±1.5°), brightness factor (±0.5%), contrast factor around 1.0 (±0.5%), saturation (±1%), per-pixel noise (±4 per channel), EXIF stripped via canvas re-encode at quality 0.92.
- **Videos** (`uniqualizeVideo`): ffmpeg `eq` filter (brightness ±0.01, contrast centered at **1.0** ±0.01, saturation ±0.02), `setpts` for speed (±1%), `asetrate`+`atempo` for audio pitch/speed, `-map_metadata -1` strips all metadata. Output is always MP4/H.264+AAC (`-crf 23 -preset veryfast -b:a 128k`). Exit code from `ff.exec()` is checked before reading output file.

### Download pattern

All tabs use the same pattern: `URL.createObjectURL` → `<a>.click()` → `setTimeout(revokeObjectURL, 1000)`. A 400 ms delay separates consecutive downloads to avoid browser blocking. ZIPs are generated and downloaded immediately as they complete — no batching at the end.
