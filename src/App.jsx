import { useState, useRef, useCallback, useEffect } from "react";
import JSZip from "jszip";

// ─── Helpers ─────────────────────────────────────────────────────────────────
let fileCounter = 0;
function uniqueName(prefix, extension) {
  return `${prefix}_${++fileCounter}${extension}`;
}

// Loads a script tag once; resolves immediately if already loaded
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing?.dataset.loaded) { resolve(); return; }
    existing?.remove();
    const s = document.createElement("script");
    s.src = src;
    s.onload = () => { s.dataset.loaded = "1"; resolve(); };
    s.onerror = () => { s.remove(); reject(new Error(`Failed to load: ${src}`)); };
    document.head.appendChild(s);
  });
}

async function fetchFile(file) {
  return new Uint8Array(await file.arrayBuffer());
}

let ffmpegInstance = null;
let ffmpegLoaded = false;
let currentProgressCb = null;

async function getFFmpeg(onProgress) {
  if (onProgress) currentProgressCb = onProgress;
  if (ffmpegLoaded && ffmpegInstance) return ffmpegInstance;

  // Use UMD build (classic Worker) — ESM build uses module Worker which
  // breaks importScripts() and prevents loading the UMD ffmpeg-core.
  const base = window.location.origin;
  await loadScript(`${base}/ffmpeg.js`);

  const { FFmpeg } = window.FFmpegWASM;
  const ff = new FFmpeg();
  ff.on("progress", (p) => { if (currentProgressCb) currentProgressCb(p); });

  await ff.load({
    coreURL: `${base}/ffmpeg-core.js`,
    wasmURL: `${base}/ffmpeg-core.wasm`,
  });

  ffmpegInstance = ff;
  ffmpegLoaded = true;
  return ff;
}

function randomBetween(min, max) { return Math.random() * (max - min) + min; }
function isImage(f) { return f.type.startsWith("image/"); }
function isVideo(f) { return f.type.startsWith("video/"); }
function ext(f) { const p = f.name.split("."); return p.length > 1 ? "." + p[p.length - 1] : ""; }
function baseName(f) { const p = f.name.split("."); return p.length > 1 ? p.slice(0, -1).join(".") : f.name; }

// Reads all media files from a FileSystemDirectoryEntry (drag-drop API)
async function readDirEntry(dirEntry) {
  const files = [];
  const reader = dirEntry.createReader();
  let batch;
  do {
    batch = await new Promise((res, rej) => reader.readEntries(res, rej));
    for (const entry of batch) {
      if (!entry.isFile) continue;
      const file = await new Promise((res, rej) => entry.file(res, rej));
      if (!file.type.startsWith("image/") && !file.type.startsWith("video/")) continue;
      files.push({ name: entry.name, handle: { getFile: () => Promise.resolve(file) } });
    }
  } while (batch.length > 0);
  files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
  return files;
}

// ─── Compression helpers ──────────────────────────────────────────────────────
const MIN_VIDEO_BITRATE_KBPS = 100;
const AUDIO_BITRATE_KBPS     = 128;

function getVideoDuration(file) {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    video.preload = "metadata";
    const url = URL.createObjectURL(file);
    video.onloadedmetadata = () => { URL.revokeObjectURL(url); resolve(video.duration); };
    video.onerror = () => { URL.revokeObjectURL(url); reject(new Error(`Не удалось прочитать длительность: ${file.name}`)); };
    video.src = url;
  });
}

async function compressVideo(file, targetBytes, onProgress) {
  const duration = await getVideoDuration(file);
  if (!isFinite(duration) || duration <= 0)
    throw new Error(`Не удалось определить длительность: ${file.name}`);

  const totalBps = (targetBytes * 8) / duration;
  let vbr        = Math.floor(totalBps / 1000) - AUDIO_BITRATE_KBPS;
  let warning    = "";

  if (vbr < MIN_VIDEO_BITRATE_KBPS) {
    warning = `${file.name}: целевой размер слишком мал, применён минимальный битрейт ${MIN_VIDEO_BITRATE_KBPS}k`;
    vbr = MIN_VIDEO_BITRATE_KBPS;
  }

  const ff  = await getFFmpeg(onProgress);
  const inp = uniqueName("cin",  ext(file));
  const out = uniqueName("cout", ".mp4");

  await ff.writeFile(inp, await fetchFile(file));

  const code = await ff.exec([
    "-i", inp,
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-b:v", `${vbr}k`,
    "-maxrate", `${Math.floor(vbr * 1.5)}k`,
    "-bufsize", `${Math.floor(vbr * 2)}k`,
    "-c:a", "aac",
    "-b:a", `${AUDIO_BITRATE_KBPS}k`,
    "-map_metadata", "-1",
    "-y", out,
  ]);

  if (code !== 0) throw new Error(`ffmpeg вышел с кодом ${code} (${file.name})`);

  const data = await ff.readFile(out);
  const blob = new Blob([new Uint8Array(data)], { type: "video/mp4" });

  try { await ff.deleteFile(inp); } catch (_) {}
  try { await ff.deleteFile(out); } catch (_) {}

  return { blob, warning };
}

// ─── Image uniqualization ─────────────────────────────────────────────────────
async function uniqualizeImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);

    // FIX 3: обработка ошибки загрузки изображения
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(`Не удалось загрузить изображение: ${file.name}`));
    };

    img.onload = () => {
      const canvas = document.createElement("canvas");
      const w = img.width, h = img.height;
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext("2d");

      // Micro-rotation ±1.5°
      const angle = randomBetween(-1.5, 1.5) * (Math.PI / 180);
      ctx.save();
      ctx.translate(w / 2, h / 2);
      ctx.rotate(angle);
      ctx.drawImage(img, -w / 2, -h / 2, w, h);
      ctx.restore();

      // Imperceptible colour correction
      const imageData = ctx.getImageData(0, 0, w, h);
      const data = imageData.data;
      const bf = randomBetween(0.995, 1.005);
      const cf = randomBetween(0.995, 1.005);
      const sf = randomBetween(0.99, 1.01);
      const noiseAmp = 4;

      for (let i = 0; i < data.length; i += 4) {
        let r = data[i], g = data[i + 1], b = data[i + 2];
        r *= bf; g *= bf; b *= bf;
        r = (r - 128) * cf + 128;
        g = (g - 128) * cf + 128;
        b = (b - 128) * cf + 128;
        const grey = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        r = grey + (r - grey) * sf;
        g = grey + (g - grey) * sf;
        b = grey + (b - grey) * sf;
        data[i]     = Math.min(255, Math.max(0, r + randomBetween(-noiseAmp, noiseAmp)));
        data[i + 1] = Math.min(255, Math.max(0, g + randomBetween(-noiseAmp, noiseAmp)));
        data[i + 2] = Math.min(255, Math.max(0, b + randomBetween(-noiseAmp, noiseAmp)));
      }
      ctx.putImageData(imageData, 0, 0);
      canvas.toBlob((blob) => {
        URL.revokeObjectURL(url);
        if (blob) resolve(blob);
        else reject(new Error("Canvas toBlob вернул null"));
      }, file.type || "image/jpeg", 0.92);
    };
    img.src = url;
  });
}

// ─── Video uniqualization via ffmpeg.wasm ────────────────────────────────────
async function uniqualizeVideo(file, copyIndex, onFFmpegProgress) {
  const ff = await getFFmpeg(onFFmpegProgress);

  // FIX 1: уникальные имена через счётчик
  const inputName  = uniqueName("in", ext(file));
  const outputName = uniqueName("out", ".mp4");

  await ff.writeFile(inputName, await fetchFile(file));

  const brightness = randomBetween(-0.01, 0.01).toFixed(4);
  const contrast   = randomBetween(0.99, 1.01).toFixed(4);
  const saturation = randomBetween(0.98, 1.02).toFixed(4);
  const speed      = randomBetween(0.99, 1.01).toFixed(4);
  const pitch      = randomBetween(0.995, 1.005).toFixed(4);

  // FIX 5: -map 0:a? делает аудио опциональным (не падает если нет звука)
  const exitCode = await ff.exec([
    "-i", inputName,
    "-vf", `eq=brightness=${brightness}:contrast=${contrast}:saturation=${saturation},setpts=${(1 / speed).toFixed(4)}*PTS`,
    "-map", "0:v:0",
    "-map", "0:a?",
    "-af", `asetrate=44100*${pitch},aresample=44100,atempo=${speed}`,
    "-map_metadata", "-1",
    "-metadata", `comment=uq${copyIndex}_${Math.random().toString(36).slice(2)}`,
    "-c:v", "libx264",
    "-crf", "23",
    "-preset", "veryfast",
    "-c:a", "aac",
    "-b:a", "128k",
    "-y",
    outputName
  ]);
  if (exitCode !== 0) throw new Error(`ffmpeg завершился с кодом ${exitCode}`);

  const data = await ff.readFile(outputName);
  // new Uint8Array(data) copies into a plain ArrayBuffer (safe even if data.buffer is SharedArrayBuffer)
  const blob = new Blob([new Uint8Array(data)], { type: "video/mp4" });

  // Чистим виртуальную FS
  try { await ff.deleteFile(inputName); } catch (_) {}
  try { await ff.deleteFile(outputName); } catch (_) {}

  return blob;
}

// ─── UI ──────────────────────────────────────────────────────────────────────
export default function App() {
  const [creatives, setCreatives]         = useState([]);
  const [processing, setProcessing]       = useState(false);
  const [ffmpegReady, setFfmpegReady]     = useState(false);
  const [ffmpegLoading, setFfmpegLoading] = useState(false);
  const [progress, setProgress]           = useState({ current: 0, total: 0, label: "", videoPct: 0 });
  const [done, setDone]                   = useState(false);
  const [error, setError]                 = useState("");
  const [ffmpegError, setFfmpegError]     = useState(false);
  const dropRef         = useRef(null);
  const inputRef        = useRef(null);
  const ffmpegLoadedRef = useRef(false);

  // ── Compression tab state ──
  const [activeTab, setActiveTab]             = useState("uniqualize");
  const [compFiles, setCompFiles]             = useState([]);
  const [compMode, setCompMode]               = useState("optimal");
  const [compCustomMB, setCompCustomMB]       = useState("");
  const [compProcessing, setCompProcessing]   = useState(false);
  const [compProgress, setCompProgress]       = useState({ current: 0, total: 0, label: "", videoPct: 0 });
  const [compDone, setCompDone]               = useState(false);
  const [compError, setCompError]             = useState("");
  const [compWarning, setCompWarning]         = useState("");
  const compDropRef  = useRef(null);
  const compInputRef = useRef(null);
  const cancelRef    = useRef(false);
  const batchDropRef = useRef(null);

  // ── Batch tab state ──
  const [batchDirs, setBatchDirs]             = useState([]);
  const [batchIters, setBatchIters]           = useState(1);
  const [batchProcessing, setBatchProcessing] = useState(false);
  const [batchProgress, setBatchProgress]     = useState({ current: 0, total: 0 });
  const [batchDone, setBatchDone]             = useState(false);
  const [batchError, setBatchError]           = useState("");

  const hasVideos = creatives.some(c => isVideo(c.file));

  const loadFfmpeg = useCallback(() => {
    if (ffmpegLoadedRef.current) return;
    ffmpegLoadedRef.current = true;
    setFfmpegLoading(true);
    setFfmpegError(false);
    setError("");
    getFFmpeg(() => {})
      .then(() => { setFfmpegReady(true); setFfmpegLoading(false); })
      .catch((err) => {
        console.error("ffmpeg load failed:", err);
        setFfmpegError(true);
        setFfmpegLoading(false);
        ffmpegLoadedRef.current = false;
      });
  }, []);

  useEffect(() => {
    if (!hasVideos || ffmpegLoadedRef.current) return;
    loadFfmpeg();
  }, [hasVideos, loadFfmpeg]);

  useEffect(() => {
    if (!compFiles.length || ffmpegLoadedRef.current) return;
    loadFfmpeg();
  }, [compFiles.length, loadFfmpeg]);

  const addFiles = useCallback((files) => {
    const arr = Array.from(files).filter(f => isImage(f) || isVideo(f));
    setCreatives(prev => [...prev, ...arr.map(f => ({
      file: f, copies: 3, id: Math.random().toString(36).slice(2)
    }))]);
    setDone(false);
    setError("");
  }, []);

  const onDrop = (e) => {
    e.preventDefault();
    dropRef.current?.classList.remove("drag-over");
    addFiles(e.dataTransfer.files);
  };

  const removeCreative = (id) => setCreatives(prev => prev.filter(c => c.id !== id));
  const setCopies = (id, val) => {
    const n = Math.max(1, Math.min(20, parseInt(val) || 1));
    setCreatives(prev => prev.map(c => c.id === id ? { ...c, copies: n } : c));
  };

  const totalCopies = creatives.reduce((s, c) => s + c.copies, 0);

  const handleProcess = async () => {
    if (!creatives.length) return;
    if (compProcessing) {
      setError("Дождись окончания сжатия на вкладке «Сжатие».");
      return;
    }
    if (hasVideos && !ffmpegReady) {
      setError(ffmpegError
        ? "ffmpeg.wasm не загружен — нажми «Повторить» выше."
        : "ffmpeg.wasm ещё загружается, подожди немного...");
      return;
    }
    cancelRef.current = false;
    setProcessing(true);
    setDone(false);
    setError("");

    try {
      let current = 0;

      for (const creative of creatives) {
        if (cancelRef.current) break;
        const zip = new JSZip();
        const name = baseName(creative.file);
        const extension = ext(creative.file);

        for (let i = 1; i <= creative.copies; i++) {
          if (cancelRef.current) break;
          current++;
          setProgress({
            current,
            total: totalCopies,
            label: `${creative.file.name} — копия ${i}/${creative.copies}`,
            videoPct: 0,
          });

          let blob;
          if (isImage(creative.file)) {
            blob = await uniqualizeImage(creative.file);
          } else {
            blob = await uniqualizeVideo(creative.file, i, (p) => {
              setProgress(prev => ({ ...prev, videoPct: Math.round((p.progress || 0) * 100) }));
            });
          }

          const outExt = isVideo(creative.file) ? ".mp4" : extension;
          zip.file(`${name}_uq${i}${outExt}`, blob);
        }

        if (!cancelRef.current) {
          const zipBlob = await zip.generateAsync({ type: "blob" });
          const a = document.createElement("a");
          a.href = URL.createObjectURL(zipBlob);
          a.download = `${name}_uniqualized.zip`;
          a.click();
          await new Promise(r => setTimeout(r, 400));
          URL.revokeObjectURL(a.href);
        }
      }

      if (!cancelRef.current) setDone(true);
    } catch (e) {
      if (!cancelRef.current) setError("Ошибка обработки: " + e.message);
    }

    setProcessing(false);
    setProgress({ current: 0, total: 0, label: "", videoPct: 0 });
  };

  // ── Compression tab handlers ──
  const addCompFiles = useCallback((files) => {
    const arr = Array.from(files).filter(f => isVideo(f));
    setCompFiles(prev => [...prev, ...arr.map(f => ({
      file: f, id: Math.random().toString(36).slice(2)
    }))]);
    setCompDone(false);
    setCompError("");
    setCompWarning("");
  }, []);

  const onCompDrop = (e) => {
    e.preventDefault();
    compDropRef.current?.classList.remove("drag-over");
    addCompFiles(e.dataTransfer.files);
  };

  const removeCompFile = (id) => setCompFiles(prev => prev.filter(c => c.id !== id));

  const resolveTargetBytes = (file) => {
    if (compMode === "optimal") return file.size * 0.60;
    if (compMode === "heavy")   return file.size * 0.20;
    const mb = parseFloat(compCustomMB);
    if (!isNaN(mb) && mb > 0) return mb * 1024 * 1024;
    return null;
  };

  const handleCompressStart = async () => {
    if (!compFiles.length) return;
    if (processing) {
      setCompError("Дождись окончания уникализации на вкладке «Уникализация».");
      return;
    }
    if (!ffmpegReady) {
      setCompError(ffmpegError
        ? "ffmpeg.wasm не загружен — нажми «Повторить» выше."
        : "ffmpeg.wasm ещё загружается, подожди...");
      return;
    }
    if (compMode === "custom") {
      const mb = parseFloat(compCustomMB);
      if (isNaN(mb) || mb <= 0) {
        setCompError("Введи корректный размер в МБ");
        return;
      }
    }

    cancelRef.current = false;
    setCompProcessing(true);
    setCompDone(false);
    setCompError("");
    setCompWarning("");

    const warnings = [];

    try {
      for (let i = 0; i < compFiles.length; i++) {
        if (cancelRef.current) break;
        const { file } = compFiles[i];
        setCompProgress({ current: i + 1, total: compFiles.length, label: `Сжимаю: ${file.name}`, videoPct: 0 });

        const targetBytes = resolveTargetBytes(file);
        if (targetBytes === null) {
          setCompError("Введи корректный размер в МБ");
          setCompProcessing(false);
          return;
        }

        const { blob, warning } = await compressVideo(
          file,
          targetBytes,
          (p) => setCompProgress(prev => ({ ...prev, videoPct: Math.round((p.progress || 0) * 100) }))
        );

        if (warning) warnings.push(warning);

        const outName = `${baseName(file)}_compressed.mp4`;
        const url = URL.createObjectURL(blob);
        const a   = document.createElement("a");
        a.href = url; a.download = outName; a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);

        if (i < compFiles.length - 1) await new Promise(r => setTimeout(r, 400));
      }

      if (!cancelRef.current) {
        setCompDone(true);
        if (warnings.length) setCompWarning(warnings.join("\n"));
      }
    } catch (e) {
      if (!cancelRef.current) setCompError("Ошибка: " + e.message);
    }

    setCompProcessing(false);
    setCompProgress({ current: 0, total: 0, label: "", videoPct: 0 });
  };

  const handleCancel = () => {
    cancelRef.current = true;
    if (ffmpegInstance) {
      try { ffmpegInstance.terminate(); } catch (_) {}
      ffmpegInstance = null;
      ffmpegLoaded = false;
      ffmpegLoadedRef.current = false;
      setFfmpegReady(false);
      loadFfmpeg();
    }
  };

  // ── Batch tab handlers ──
  const handleAddDir = async () => {
    if (!window.showDirectoryPicker) {
      setBatchError("Браузер не поддерживает выбор папок. Используй Chrome или Edge.");
      return;
    }
    try {
      const handle = await window.showDirectoryPicker({ mode: "read" });
      const files = [];
      for await (const [name, fh] of handle.entries()) {
        if (fh.kind !== "file") continue;
        const f = await fh.getFile();
        if (!f.type.startsWith("image/") && !f.type.startsWith("video/")) continue;
        files.push({ name, handle: fh });
      }
      files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
      setBatchDirs(prev => [...prev, { id: Math.random().toString(36).slice(2), name: handle.name, files }]);
      setBatchDone(false);
      setBatchError("");
    } catch (e) {
      if (e.name !== "AbortError") setBatchError("Ошибка при выборе папки: " + e.message);
    }
  };

  const handleDirDrop = async (e) => {
    e.preventDefault();
    batchDropRef.current?.classList.remove("drag-over");
    const entries = Array.from(e.dataTransfer.items)
      .map(item => item.webkitGetAsEntry?.())
      .filter(entry => entry?.isDirectory);
    if (!entries.length) { setBatchError("Перетащи папки, а не файлы."); return; }
    setBatchError("");
    try {
      const newDirs = [];
      for (const dirEntry of entries) {
        const files = await readDirEntry(dirEntry);
        newDirs.push({ id: Math.random().toString(36).slice(2), name: dirEntry.name, files });
      }
      setBatchDirs(prev => [...prev, ...newDirs]);
      setBatchDone(false);
    } catch (err) {
      setBatchError("Ошибка чтения папки: " + err.message);
    }
  };

  const handleBatchProcess = async () => {
    const validDirs = batchDirs.filter(d => d.files.length > 0);
    if (!validDirs.length) { setBatchError("Нет папок с медиафайлами."); return; }
    if (processing || compProcessing) {
      setBatchError("Дождись окончания обработки на другой вкладке.");
      return;
    }
    cancelRef.current = false;
    setBatchProcessing(true);
    setBatchDone(false);
    setBatchError("");
    setBatchProgress({ current: 0, total: batchIters });
    try {
      for (let i = 0; i < batchIters; i++) {
        if (cancelRef.current) break;
        setBatchProgress({ current: i + 1, total: batchIters });
        const zip = new JSZip();
        for (let di = 0; di < validDirs.length; di++) {
          const dir = validDirs[di];
          const idx = i % dir.files.length;
          const fileEntry = dir.files[idx];
          const file = await fileEntry.handle.getFile();
          // di+1 гарантирует уникальность даже если две папки одноимённые
          zip.file(`dir${di + 1}_${dir.name}_${fileEntry.name}`, file);
        }
        const blob = await zip.generateAsync({ type: "blob" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `batch_iter${i + 1}.zip`;
        a.click();
        if (i < batchIters - 1) await new Promise(r => setTimeout(r, 400));
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
      if (!cancelRef.current) setBatchDone(true);
    } catch (e) {
      if (!cancelRef.current) setBatchError("Ошибка: " + e.message);
    }
    setBatchProcessing(false);
    setBatchProgress({ current: 0, total: 0 });
  };

  return (
    <div style={S.root}>
      <div style={S.header}>
        <span style={S.logo}>⬡</span>
        <h1 style={S.title}>CREATIVE UNIQ</h1>
        <p style={S.sub}>Уникализация изображений и видео для арбитража</p>
      </div>

      <div style={S.tabBar}>
        <button
          style={{ ...S.tabBtn, ...(activeTab === "uniqualize" ? S.tabBtnActive : {}) }}
          onClick={() => setActiveTab("uniqualize")}
        >
          ✦ Уникализация
        </button>
        <button
          style={{ ...S.tabBtn, ...(activeTab === "compress" ? S.tabBtnActive : {}) }}
          onClick={() => setActiveTab("compress")}
        >
          ⚡ Сжатие
        </button>
        <button
          style={{ ...S.tabBtn, ...(activeTab === "batch" ? S.tabBtnActive : {}) }}
          onClick={() => setActiveTab("batch")}
        >
          ◈ Пакет
        </button>
      </div>

      {activeTab === "uniqualize" && (
        <>
          <div ref={dropRef} style={S.dropZone}
            onClick={() => inputRef.current?.click()}
            onDragOver={(e) => { e.preventDefault(); dropRef.current?.classList.add("drag-over"); }}
            onDragLeave={() => dropRef.current?.classList.remove("drag-over")}
            onDrop={onDrop}
          >
            <input ref={inputRef} type="file" multiple accept="image/*,video/*"
              style={{ display: "none" }} onChange={e => addFiles(e.target.files)} />
            <div style={S.dropIcon}>📂</div>
            <p style={S.dropText}>Перетащи креативы или <span style={S.link}>выбери файлы</span></p>
            <p style={S.dropHint}>PNG, JPG, WEBP · MP4, MOV, AVI, MKV и другие</p>
          </div>

          {ffmpegLoading && (
            <div style={S.banner}>⏳ Загружаю ffmpeg.wasm (~22 МБ) для обработки видео...</div>
          )}
          {ffmpegError && !ffmpegLoading && (
            <div style={S.bannerError}>
              ⚠️ Не удалось загрузить ffmpeg.wasm.
              <button style={S.retryBtn} onClick={loadFfmpeg}>↺ Повторить</button>
            </div>
          )}
          {ffmpegReady && hasVideos && (
            <div style={S.bannerGreen}>✅ ffmpeg.wasm готов — видео будет обработано полноценно</div>
          )}

          {creatives.length > 0 && (
            <div style={S.list}>
              <div style={S.listHeader}>
                <span>Загружено: {creatives.length} файлов · {totalCopies} копий всего</span>
                <button style={S.clearBtn} onClick={() => setCreatives([])}>Очистить</button>
              </div>
              {creatives.map(c => (
                <div key={c.id} style={S.item}>
                  <div style={S.itemIcon}>{isImage(c.file) ? "🖼" : "🎬"}</div>
                  <div style={S.itemName}>{c.file.name}</div>
                  <div style={S.itemSize}>{(c.file.size / 1024 / 1024).toFixed(1)} МБ</div>
                  <div style={S.copiesWrap}>
                    <button style={S.stepBtn} onClick={() => setCopies(c.id, c.copies - 1)}>−</button>
                    <input type="number" min={1} max={20} value={c.copies}
                      onChange={e => setCopies(c.id, e.target.value)} style={S.copiesInput} />
                    <button style={S.stepBtn} onClick={() => setCopies(c.id, c.copies + 1)}>+</button>
                    <span style={S.copiesLabel}>копий</span>
                  </div>
                  <button style={S.removeBtn} onClick={() => removeCreative(c.id)}>✕</button>
                </div>
              ))}
            </div>
          )}

          {creatives.length > 0 && !processing && (
            <button
              style={{ ...S.processBtn, opacity: (hasVideos && !ffmpegReady) || compProcessing ? 0.5 : 1, cursor: (hasVideos && !ffmpegReady) || compProcessing ? "not-allowed" : "pointer" }}
              onClick={handleProcess}
            >
              ⚡ Уникализировать и скачать ZIP
            </button>
          )}

          {processing && (
            <div style={S.progressWrap}>
              <div style={S.progressLabel}>{progress.label}</div>
              <div style={S.progressBar}>
                <div style={{ ...S.progressFill, width: `${progress.total ? (progress.current / progress.total) * 100 : 0}%` }} />
              </div>
              <div style={S.progressCount}>{progress.current} / {progress.total}</div>
              {progress.videoPct > 0 && progress.videoPct < 100 && (
                <div style={{ marginTop: 10 }}>
                  <div style={S.progressLabel}>ffmpeg кодирует: {progress.videoPct}%</div>
                  <div style={S.progressBar}>
                    <div style={{ ...S.progressFillGreen, width: `${progress.videoPct}%` }} />
                  </div>
                </div>
              )}
              <button style={S.cancelBtn} onClick={handleCancel}>✕ Отменить</button>
            </div>
          )}

          {done && <div style={S.done}>✅ Готово! ZIP-архивы скачаны. По одному архиву на каждый креатив.</div>}
          {error && <div style={S.errorBox}>⚠️ {error}</div>}

          <div style={S.infoGrid}>
            {[
              { icon: "🖼", title: "Изображения", desc: "Canvas API — поворот, цвет, шум, очистка EXIF" },
              { icon: "🎬", title: "Видео", desc: "ffmpeg.wasm — полная обработка прямо в браузере" },
              { icon: "🧹", title: "Метаданные", desc: "Полная очистка через -map_metadata -1" },
              { icon: "🎨", title: "Цветокоррекция", desc: "Яркость, контраст, насыщенность ±1%" },
              { icon: "⚡", title: "Скорость видео", desc: "Микросдвиг ±1% — незаметно на глаз" },
              { icon: "🔒", title: "Приватность", desc: "Всё локально, файлы никуда не уходят" },
            ].map(({ icon, title, desc }) => (
              <div key={title} style={S.infoCard}>
                <span style={S.infoIcon}>{icon}</span>
                <strong style={S.infoTitle}>{title}</strong>
                <span style={S.infoDesc}>{desc}</span>
              </div>
            ))}
          </div>
        </>
      )}

      {activeTab === "compress" && (
        <>
          {ffmpegLoading && (
            <div style={S.banner}>⏳ Загружаю ffmpeg.wasm (~22 МБ)...</div>
          )}
          {ffmpegError && !ffmpegLoading && (
            <div style={S.bannerError}>
              ⚠️ Не удалось загрузить ffmpeg.wasm.
              <button style={S.retryBtn} onClick={loadFfmpeg}>↺ Повторить</button>
            </div>
          )}
          {ffmpegReady && compFiles.length > 0 && (
            <div style={S.bannerGreen}>✅ ffmpeg.wasm готов</div>
          )}

          <div ref={compDropRef} style={S.dropZone}
            onClick={() => compInputRef.current?.click()}
            onDragOver={(e) => { e.preventDefault(); compDropRef.current?.classList.add("drag-over"); }}
            onDragLeave={() => compDropRef.current?.classList.remove("drag-over")}
            onDrop={onCompDrop}
          >
            <input ref={compInputRef} type="file" multiple accept="video/*"
              style={{ display: "none" }} onChange={e => addCompFiles(e.target.files)} />
            <div style={S.dropIcon}>🎬</div>
            <p style={S.dropText}>Перетащи видео или <span style={S.link}>выбери файлы</span></p>
            <p style={S.dropHint}>MP4, MOV, AVI, MKV — только видео</p>
          </div>

          {compFiles.length > 0 && !compProcessing && (
            <div style={S.modeWrap}>
              <p style={S.modeLabel}>ЦЕЛЕВОЙ РАЗМЕР</p>
              <div style={S.modeBtns}>
                <button
                  style={{ ...S.modeBtn, ...(compMode === "optimal" ? S.modeBtnActive : {}) }}
                  onClick={() => setCompMode("optimal")}
                >
                  Оптимально <span style={S.modeBtnHint}>−40%</span>
                </button>
                <button
                  style={{ ...S.modeBtn, ...(compMode === "heavy" ? S.modeBtnActive : {}) }}
                  onClick={() => setCompMode("heavy")}
                >
                  Сильно <span style={S.modeBtnHint}>−80%</span>
                </button>
                <button
                  style={{ ...S.modeBtn, ...(compMode === "custom" ? S.modeBtnActive : {}) }}
                  onClick={() => setCompMode("custom")}
                >
                  Своё
                </button>
              </div>
              {compMode === "custom" && (
                <div style={S.customWrap}>
                  <input
                    type="number" min="0.1" step="0.1"
                    placeholder="Размер в МБ"
                    value={compCustomMB}
                    onChange={e => setCompCustomMB(e.target.value)}
                    style={S.customInput}
                  />
                  <span style={S.customUnit}>МБ</span>
                </div>
              )}
            </div>
          )}

          {compFiles.length > 0 && (
            <div style={S.list}>
              <div style={S.listHeader}>
                <span>Видео: {compFiles.length} файлов</span>
                <button style={S.clearBtn} onClick={() => setCompFiles([])}>Очистить</button>
              </div>
              {compFiles.map(c => (
                <div key={c.id} style={S.item}>
                  <div style={S.itemIcon}>🎬</div>
                  <div style={S.itemName}>{c.file.name}</div>
                  <div style={S.itemSize}>{(c.file.size / 1024 / 1024).toFixed(1)} МБ</div>
                  {compMode !== "custom" && (
                    <div style={S.itemTarget}>
                      → {((c.file.size / 1024 / 1024) * (compMode === "optimal" ? 0.6 : 0.2)).toFixed(1)} МБ
                    </div>
                  )}
                  <button style={S.removeBtn} onClick={() => removeCompFile(c.id)}>✕</button>
                </div>
              ))}
            </div>
          )}

          {compFiles.length > 0 && !compProcessing && (
            <button
              style={{ ...S.processBtn, opacity: (!ffmpegReady || processing) ? 0.5 : 1, cursor: (!ffmpegReady || processing) ? "not-allowed" : "pointer" }}
              onClick={handleCompressStart}
            >
              ⚡ Сжать и скачать
            </button>
          )}

          {compProcessing && (
            <div style={S.progressWrap}>
              <div style={S.progressLabel}>{compProgress.label}</div>
              <div style={S.progressBar}>
                <div style={{ ...S.progressFill, width: `${compProgress.total ? (compProgress.current / compProgress.total) * 100 : 0}%` }} />
              </div>
              <div style={S.progressCount}>{compProgress.current} / {compProgress.total}</div>
              {compProgress.videoPct > 0 && compProgress.videoPct < 100 && (
                <div style={{ marginTop: 10 }}>
                  <div style={S.progressLabel}>ffmpeg кодирует: {compProgress.videoPct}%</div>
                  <div style={S.progressBar}>
                    <div style={{ ...S.progressFillGreen, width: `${compProgress.videoPct}%` }} />
                  </div>
                </div>
              )}
              <button style={S.cancelBtn} onClick={handleCancel}>✕ Отменить</button>
            </div>
          )}

          {compDone    && <div style={S.done}>✅ Готово! Файлы скачаны.</div>}
          {compError   && <div style={S.errorBox}>⚠️ {compError}</div>}
          {compWarning && <div style={S.warnBox}>⚠️ {compWarning}</div>}
        </>
      )}

      {activeTab === "batch" && (
        <>
          <div
            ref={batchDropRef}
            style={{ ...S.dropZone, ...(batchProcessing ? { opacity: 0.4, pointerEvents: "none" } : {}) }}
            onClick={handleAddDir}
            onDragOver={(e) => { e.preventDefault(); batchDropRef.current?.classList.add("drag-over"); }}
            onDragLeave={() => batchDropRef.current?.classList.remove("drag-over")}
            onDrop={handleDirDrop}
          >
            <div style={S.dropIcon}>📁</div>
            <p style={S.dropText}>Перетащи папки или <span style={S.link}>выбери папку</span></p>
            <p style={S.dropHint}>Можно перетащить сразу несколько папок · Chrome / Edge</p>
          </div>

          {batchDirs.length > 0 && (
            <div style={S.list}>
              <div style={S.listHeader}>
                <span>Папок: {batchDirs.length}</span>
                {!batchProcessing && (
                  <button style={S.clearBtn} onClick={() => { setBatchDirs([]); setBatchDone(false); setBatchError(""); }}>Очистить</button>
                )}
              </div>
              {batchDirs.map((d) => (
                <div key={d.id} style={S.item}>
                  <div style={S.itemIcon}>📁</div>
                  <div style={S.itemName}>{d.name}</div>
                  <div style={S.itemSize}>{d.files.length} файлов</div>
                  {!batchProcessing && (
                    <button style={S.removeBtn} onClick={() => setBatchDirs(prev => prev.filter(x => x.id !== d.id))}>✕</button>
                  )}
                </div>
              ))}
            </div>
          )}

          {batchDirs.length > 0 && (
            <div style={S.itersWrap}>
              <span style={S.itersLabel}>Итераций</span>
              <button style={S.stepBtn} onClick={() => setBatchIters(n => Math.max(1, n - 1))}>−</button>
              <input
                type="number" min={1} max={999} value={batchIters}
                onChange={e => setBatchIters(Math.max(1, parseInt(e.target.value) || 1))}
                style={S.itersInput}
              />
              <button style={S.stepBtn} onClick={() => setBatchIters(n => n + 1)}>+</button>
              <span style={S.itersHint}>
                → {batchIters * batchDirs.filter(d => d.files.length > 0).length} файлов в архиве
              </span>
            </div>
          )}

          {batchDirs.length > 0 && !batchProcessing && (
            <button style={S.processBtn} onClick={handleBatchProcess}>
              ⬇ Собрать ZIP
            </button>
          )}

          {batchProcessing && (
            <div style={S.progressWrap}>
              <div style={S.progressLabel}>Итерация {batchProgress.current} / {batchProgress.total}</div>
              <div style={S.progressBar}>
                <div style={{ ...S.progressFill, width: `${batchProgress.total ? (batchProgress.current / batchProgress.total) * 100 : 0}%` }} />
              </div>
              <div style={S.progressCount}>{batchProgress.current} / {batchProgress.total}</div>
              <button style={S.cancelBtn} onClick={() => { cancelRef.current = true; }}>✕ Отменить</button>
            </div>
          )}

          {batchDone  && <div style={S.done}>✅ Готово! {batchIters} ZIP-архив{batchIters === 1 ? "" : batchIters < 5 ? "а" : "ов"} скачано.</div>}
          {batchError && <div style={S.errorBox}>⚠️ {batchError}</div>}

          {!batchDirs.length && (
            <div style={S.batchHint}>
              <p>Выбери одну или несколько папок с изображениями или видео.</p>
              <p>Каждая итерация берёт следующий файл по порядку из каждой папки.<br />
              Если файлов меньше чем итераций — список начинается сначала.</p>
              <p style={{ color: "#4a4a6a", fontSize: 11 }}>Требуется Chrome или Edge</p>
            </div>
          )}
        </>
      )}
    </div>
  );
}

const S = {
  root: { minHeight: "100vh", background: "#0a0a0f", color: "#e8e8f0", fontFamily: "'Courier New', monospace", padding: "24px 16px 48px", maxWidth: 760, margin: "0 auto" },
  header: { textAlign: "center", marginBottom: 24 },
  logo: { fontSize: 40, display: "block", marginBottom: 8, filter: "hue-rotate(200deg)" },
  title: { fontSize: 32, fontWeight: 900, letterSpacing: 8, margin: 0, background: "linear-gradient(90deg, #00e5ff, #7c4dff)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" },
  sub: { color: "#6b6b8a", fontSize: 13, marginTop: 8, letterSpacing: 1 },
  tabBar: { display: "flex", gap: 0, marginBottom: 28, borderBottom: "1px solid #1e1e3a" },
  tabBtn: { background: "none", border: "none", borderBottom: "2px solid transparent", color: "#4a4a6a", padding: "8px 20px", cursor: "pointer", fontSize: 13, fontFamily: "'Courier New', monospace", letterSpacing: 1, marginBottom: -1, transition: "color 0.2s, border-color 0.2s" },
  tabBtnActive: { color: "#00e5ff", borderBottomColor: "#00e5ff" },
  dropZone: { border: "2px dashed #2a2a4a", borderRadius: 12, padding: "40px 24px", textAlign: "center", cursor: "pointer", background: "#0f0f1a", marginBottom: 16 },
  dropIcon: { fontSize: 36, marginBottom: 8 },
  dropText: { margin: "0 0 6px", fontSize: 15 },
  link: { color: "#00e5ff", textDecoration: "underline" },
  dropHint: { color: "#4a4a6a", fontSize: 12, margin: 0 },
  banner: { background: "#0f0f1a", border: "1px solid #2a2a4a", borderRadius: 8, padding: "10px 16px", fontSize: 12, color: "#6b6b8a", marginBottom: 12 },
  bannerGreen: { background: "#0a1f0a", border: "1px solid #1a4a1a", borderRadius: 8, padding: "8px 16px", fontSize: 12, color: "#4caf50", marginBottom: 12, textAlign: "center" },
  list: { background: "#0f0f1a", borderRadius: 12, border: "1px solid #1e1e3a", marginBottom: 20, overflow: "hidden" },
  listHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 16px", borderBottom: "1px solid #1e1e3a", fontSize: 12, color: "#6b6b8a" },
  clearBtn: { background: "none", border: "1px solid #2a2a4a", color: "#6b6b8a", borderRadius: 6, padding: "3px 10px", cursor: "pointer", fontSize: 11 },
  item: { display: "flex", alignItems: "center", gap: 10, padding: "10px 16px", borderBottom: "1px solid #1a1a2e", flexWrap: "wrap" },
  itemIcon: { fontSize: 20 },
  itemName: { flex: 1, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 80 },
  itemSize: { fontSize: 11, color: "#4a4a6a", whiteSpace: "nowrap" },
  itemTarget: { fontSize: 11, color: "#7c4dff", whiteSpace: "nowrap" },
  copiesWrap: { display: "flex", alignItems: "center", gap: 4 },
  stepBtn: { width: 26, height: 26, background: "#1a1a2e", border: "1px solid #2a2a4a", color: "#e8e8f0", borderRadius: 6, cursor: "pointer", fontSize: 16, lineHeight: 1 },
  copiesInput: { width: 44, textAlign: "center", background: "#0a0a14", border: "1px solid #2a2a4a", color: "#e8e8f0", borderRadius: 6, padding: "3px 4px", fontSize: 13, fontFamily: "'Courier New', monospace" },
  copiesLabel: { fontSize: 11, color: "#4a4a6a", marginLeft: 2 },
  removeBtn: { background: "none", border: "none", color: "#3a3a5a", cursor: "pointer", fontSize: 14, padding: 4 },
  processBtn: { width: "100%", padding: "14px 0", background: "linear-gradient(90deg, #00e5ff22, #7c4dff22)", border: "1px solid #7c4dff", color: "#e8e8f0", borderRadius: 10, fontSize: 15, letterSpacing: 2, fontFamily: "'Courier New', monospace", fontWeight: 700, marginBottom: 24 },
  progressWrap: { marginBottom: 24, padding: 16, background: "#0f0f1a", borderRadius: 10, border: "1px solid #1e1e3a" },
  progressLabel: { fontSize: 12, color: "#6b6b8a", marginBottom: 8 },
  progressBar: { height: 6, background: "#1a1a2e", borderRadius: 3, overflow: "hidden", marginBottom: 6 },
  progressFill: { height: "100%", background: "linear-gradient(90deg, #00e5ff, #7c4dff)", borderRadius: 3, transition: "width 0.3s" },
  progressFillGreen: { height: "100%", background: "linear-gradient(90deg, #00c853, #69f0ae)", borderRadius: 3, transition: "width 0.3s" },
  progressCount: { fontSize: 11, color: "#4a4a6a", textAlign: "right" },
  done: { padding: 14, background: "#0a1f0a", border: "1px solid #1a4a1a", borderRadius: 10, fontSize: 13, color: "#4caf50", marginBottom: 24, textAlign: "center" },
  errorBox: { padding: 14, background: "#1f0a0a", border: "1px solid #4a1a1a", borderRadius: 10, fontSize: 13, color: "#ef5350", marginBottom: 24, textAlign: "center" },
  infoGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 12, marginTop: 8 },
  infoCard: { background: "#0f0f1a", border: "1px solid #1e1e3a", borderRadius: 10, padding: "12px 14px", display: "flex", flexDirection: "column", gap: 4 },
  infoIcon: { fontSize: 20 },
  infoTitle: { fontSize: 13, color: "#00e5ff", letterSpacing: 1 },
  infoDesc: { fontSize: 11, color: "#4a4a6a" },
  bannerError: { background: "#1f0a0a", border: "1px solid #4a1a1a", borderRadius: 8, padding: "8px 16px", fontSize: 12, color: "#ef5350", marginBottom: 12, display: "flex", alignItems: "center", gap: 12 },
  retryBtn: { background: "#2a0a0a", border: "1px solid #ef5350", color: "#ef5350", borderRadius: 6, padding: "4px 12px", cursor: "pointer", fontSize: 12, fontFamily: "'Courier New', monospace" },
  modeWrap: { marginBottom: 16, padding: "12px 16px", background: "#0f0f1a", borderRadius: 10, border: "1px solid #1e1e3a" },
  modeLabel: { margin: "0 0 10px", fontSize: 11, color: "#6b6b8a", letterSpacing: 1 },
  modeBtns: { display: "flex", gap: 8, flexWrap: "wrap" },
  modeBtn: { flex: 1, padding: "10px 0", background: "#1a1a2e", border: "1px solid #2a2a4a", color: "#6b6b8a", borderRadius: 8, cursor: "pointer", fontSize: 13, fontFamily: "'Courier New', monospace", letterSpacing: 1 },
  modeBtnActive: { border: "1px solid #7c4dff", color: "#e8e8f0", background: "#1e1a2e" },
  modeBtnHint: { fontSize: 10, color: "#4a4a6a", marginLeft: 4 },
  customWrap: { display: "flex", alignItems: "center", gap: 8, marginTop: 10 },
  customInput: { width: 100, background: "#0a0a14", border: "1px solid #2a2a4a", color: "#e8e8f0", borderRadius: 6, padding: "6px 8px", fontSize: 13, fontFamily: "'Courier New', monospace" },
  customUnit: { fontSize: 12, color: "#4a4a6a" },
  warnBox: { padding: 14, background: "#1f1a0a", border: "1px solid #4a3a1a", borderRadius: 10, fontSize: 12, color: "#ffb300", marginBottom: 24, textAlign: "center", whiteSpace: "pre-line" },
  cancelBtn: { marginTop: 14, width: "100%", padding: "8px 0", background: "none", border: "1px solid #3a3a5a", color: "#6b6b8a", borderRadius: 8, cursor: "pointer", fontSize: 12, fontFamily: "'Courier New', monospace", letterSpacing: 1 },
  itersWrap: { display: "flex", alignItems: "center", gap: 8, marginBottom: 20, padding: "12px 16px", background: "#0f0f1a", borderRadius: 10, border: "1px solid #1e1e3a" },
  itersLabel: { fontSize: 12, color: "#6b6b8a", letterSpacing: 1, marginRight: 4 },
  itersInput: { width: 56, textAlign: "center", background: "#0a0a14", border: "1px solid #2a2a4a", color: "#e8e8f0", borderRadius: 6, padding: "3px 4px", fontSize: 13, fontFamily: "'Courier New', monospace" },
  itersHint: { fontSize: 12, color: "#7c4dff", marginLeft: 8 },
  batchHint: { textAlign: "center", color: "#4a4a6a", fontSize: 13, lineHeight: 1.8, marginTop: 32 },
};
