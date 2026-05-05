import { useState, useRef, useCallback, useEffect } from "react";
import { FFmpeg } from "@ffmpeg/ffmpeg";
import { toBlobURL, fetchFile } from "@ffmpeg/util";
import JSZip from "jszip";

// ─── Helpers ─────────────────────────────────────────────────────────────────
let fileCounter = 0;
function uniqueName(prefix, extension) {
  return `${prefix}_${++fileCounter}${extension}`;
}

let ffmpegInstance = null;
let ffmpegLoaded = false;
let currentProgressCb = null;

async function getFFmpeg(onProgress) {
  if (onProgress) currentProgressCb = onProgress;
  if (ffmpegLoaded && ffmpegInstance) return ffmpegInstance;

  const ff = new FFmpeg();
  ff.on("progress", (p) => { if (currentProgressCb) currentProgressCb(p); });

  const base = window.location.origin;
  await ff.load({
    coreURL: await toBlobURL(`${base}/ffmpeg-core.js`, "text/javascript"),
    wasmURL: await toBlobURL(`${base}/ffmpeg-core.wasm`, "application/wasm"),
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
    "-crf", "18",
    "-preset", "ultrafast",
    "-c:a", "aac",
    "-b:a", "192k",
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
  const dropRef      = useRef(null);
  const inputRef     = useRef(null);
  const ffmpegLoadedRef = useRef(false);

  const hasVideos = creatives.some(c => isVideo(c.file));

  const loadFfmpeg = useCallback(() => {
    if (ffmpegLoadedRef.current) return;
    ffmpegLoadedRef.current = true;
    setFfmpegLoading(true);
    setFfmpegError(false);
    setError("");
    getFFmpeg(() => {})
      .then(() => { setFfmpegReady(true); setFfmpegLoading(false); })
      .catch(() => {
        setFfmpegError(true);
        setFfmpegLoading(false);
        ffmpegLoadedRef.current = false;
      });
  }, []);

  useEffect(() => {
    if (!hasVideos || ffmpegLoadedRef.current) return;
    loadFfmpeg();
  }, [hasVideos, loadFfmpeg]);

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
    if (hasVideos && !ffmpegReady) {
      setError(ffmpegError
        ? "ffmpeg.wasm не загружен — нажми «Повторить» выше."
        : "ffmpeg.wasm ещё загружается, подожди немного...");
      return;
    }
    setProcessing(true);
    setDone(false);
    setError("");

    try {
      let current = 0;
      const zips = [];

      for (const creative of creatives) {
        const zip = new JSZip();
        const name = baseName(creative.file);
        const extension = ext(creative.file);

        for (let i = 1; i <= creative.copies; i++) {
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

        const zipBlob = await zip.generateAsync({ type: "blob" });
        zips.push({ name: `${name}_uniqualized.zip`, blob: zipBlob });
      }

      for (const z of zips) {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(z.blob);
        a.download = z.name;
        a.click();
        await new Promise(r => setTimeout(r, 400));
        URL.revokeObjectURL(a.href);
      }

      setDone(true);
    } catch (e) {
      setError("Ошибка обработки: " + e.message);
    }

    setProcessing(false);
    setProgress({ current: 0, total: 0, label: "", videoPct: 0 });
  };

  return (
    <div style={S.root}>
      <div style={S.header}>
        <span style={S.logo}>⬡</span>
        <h1 style={S.title}>CREATIVE UNIQ</h1>
        <p style={S.sub}>Уникализация изображений и видео для арбитража</p>
      </div>

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
          style={{ ...S.processBtn, opacity: hasVideos && !ffmpegReady ? 0.5 : 1, cursor: hasVideos && !ffmpegReady ? "not-allowed" : "pointer" }}
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
    </div>
  );
}

const S = {
  root: { minHeight: "100vh", background: "#0a0a0f", color: "#e8e8f0", fontFamily: "'Courier New', monospace", padding: "24px 16px 48px", maxWidth: 760, margin: "0 auto" },
  header: { textAlign: "center", marginBottom: 32 },
  logo: { fontSize: 40, display: "block", marginBottom: 8, filter: "hue-rotate(200deg)" },
  title: { fontSize: 32, fontWeight: 900, letterSpacing: 8, margin: 0, background: "linear-gradient(90deg, #00e5ff, #7c4dff)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" },
  sub: { color: "#6b6b8a", fontSize: 13, marginTop: 8, letterSpacing: 1 },
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
};
