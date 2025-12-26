// LUBA v0.31 — iOS SAFE MODE + запись сегментов (без распознавания текста)
// ✅ iPhone Safari: getUserMedia + AudioContext + MediaRecorder
// ❌ без SpeechRecognition

const ui = {
  status: document.getElementById("status"),
  btnMic: document.getElementById("btnMic"),
  btnClear: document.getElementById("btnClear"),
  btnStart: document.getElementById("btnStart"),
  btnStop: document.getElementById("btnStop"),
  btnDownload: document.getElementById("btnDownload"),
  liveText: document.getElementById("liveText"),
  badge: document.getElementById("badge"),
  outText: document.getElementById("outText"),
  outQuestions: document.getElementById("outQuestions"),
  outLog: document.getElementById("outLog"),
  pauseMsLabel: document.getElementById("pauseMs"),
  thrLabel: document.getElementById("thr"),
};

function setStatus(t) { ui.status && (ui.status.textContent = t); }
function setBadge(t)  { ui.badge && (ui.badge.textContent = t); }
function setLive(t)   { ui.liveText && (ui.liveText.textContent = t); }
function logLine(t) {
  if (!ui.outLog) return;
  const ts = new Date().toLocaleTimeString();
  ui.outLog.value = `[${ts}] ${t}\n` + ui.outLog.value;
}

let stream = null;
let audioCtx = null;
let sourceNode = null;
let analyser = null;
let data = null;
let rafId = null;

let running = false;

// VAD
let speaking = false;
let lastSpeechMs = 0;
let speechStartMs = 0;

const PAUSE_MS = 600;
const THRESH_ENERGY = 10;

if (ui.pauseMsLabel) ui.pauseMsLabel.textContent = String(PAUSE_MS);
if (ui.thrLabel) ui.thrLabel.textContent = String(THRESH_ENERGY);

function nowMs() { return Date.now(); }

function energyFromAnalyser() {
  analyser.getByteTimeDomainData(data);
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    const v = data[i] - 128;
    sum += Math.abs(v);
  }
  return sum / data.length;
}

// ---- Запись аудио сегментов ----
let recorder = null;
let recChunks = [];
let currentSegmentIndex = 0;

const segments = []; // {idx, startMs, endMs, durMs, isQuestion, blobSize}

function startSegmentRecording() {
  if (!stream) return;
  if (!window.MediaRecorder) {
    logLine("MediaRecorder NOT SUPPORTED (некоторые iOS версии)");
    return;
  }
  try {
    recChunks = [];
    recorder = new MediaRecorder(stream, { mimeType: "audio/mp4" });
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) recChunks.push(e.data); };
    recorder.onstart = () => logLine("SEGMENT REC START");
    recorder.start();
    setStatus("🎙️ REC: запись сегмента…");
    logLine("RECORDER STARTED");

  } catch (e) {
    logLine("MediaRecorder ERROR: " + (e?.name || e));
  }
}

function stopSegmentRecordingAndStore() {
  return new Promise((resolve) => {
    if (!recorder) return resolve(null);

    try {
      recorder.onstop = () => {
        const chunks = recChunks;                 // берём ДО очистки
        const mime = recorder?.mimeType || "audio/mp4";

        recorder = null;                          // чистим ПОСЛЕ
        recChunks = [];

        const blob = new Blob(chunks, { type: mime });
        resolve({ blob, size: blob.size });
      };

      recorder.stop();
    } catch (e) {
      recorder = null;
      recChunks = [];
      resolve(null);
    }
  });
}



function redrawTextAreas() {
  if (ui.outText) {
    ui.outText.value = segments
      .map(s => `#${s.idx} | dur=${Math.round(s.durMs)}ms | audio=${Math.round(s.blobSize/1024)}KB | ${s.isQuestion ? "❓" : "—"}`)
      .join("\n");
  }
  if (ui.outQuestions) {
    ui.outQuestions.value = segments
      .filter(s => s.isQuestion)
      .map(s => `❓ Сегмент #${s.idx} (dur=${Math.round(s.durMs)}ms) — возможный вопрос`)
      .join("\n");
  }
}

function loop() {
  if (!running) return;

  const e = energyFromAnalyser();
  const t = nowMs();

  const lvl = Math.round(e);
  const state = speaking ? "🗣️ речь" : "🤫 тишина";
  setLive(`${state} | уровень: ${lvl} | порог: ${THRESH_ENERGY}`);

  const isSpeechNow = e >= THRESH_ENERGY;

  if (isSpeechNow) {
    if (!speaking) {
      speaking = true;
      speechStartMs = t;
      lastSpeechMs = t;

      setStatus("🎙️ Слушаю… говори");
      logLine("SPEECH START");

      // старт записи сегмента
      startSegmentRecording();
    } else {
      lastSpeechMs = t;
    }
  } else {
    if (speaking) {
      const since = t - lastSpeechMs;
      if (since >= PAUSE_MS) {
        // конец фразы
        const dur = t - speechStartMs;
        speaking = false;

        setStatus("⏸️ Пауза…");
        logLine(`SPEECH END (dur=${dur}ms, pause=${since}ms)`);

        // пока эвристика вопроса простая: фраза > 600мс
        const isQ = dur > 600;

        stopSegmentRecordingAndStore().then((res) => {
          currentSegmentIndex += 1;
          setStatus(`✅ Сегмент #${currentSegmentIndex} сохранён (${Math.round((res?.size || 0) / 1024)}KB)`);


       segments.unshift({
  idx: currentSegmentIndex,
  startMs: speechStartMs,
  endMs: t,
  durMs: dur,
  isQuestion: isQ,
  blobSize: res?.size || 0,
  blob: res?.blob || null,   // ← ВАЖНО
});


          if (isQ) setBadge("❓ POSSIBLE QUESTION");
          logLine(isQ ? `SEGMENT #${currentSegmentIndex} saved as QUESTION` : `SEGMENT #${currentSegmentIndex} saved`);

          redrawTextAreas();

          setTimeout(() => { if (!speaking) setBadge("—"); }, 2500);
        });
      }
    }
  }

  rafId = requestAnimationFrame(loop);
}

async function startMic() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
  } catch (e) {
    setStatus("❌ Нет доступа к микрофону. Разреши микрофон в Safari для сайта.");
    logLine("getUserMedia ERROR: " + (e?.name || e));
    return false;
  }

  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state !== "running") await audioCtx.resume();

    sourceNode = audioCtx.createMediaStreamSource(stream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 2048;
    data = new Uint8Array(analyser.fftSize);

    sourceNode.connect(analyser);

    running = true;
    speaking = false;
    lastSpeechMs = 0;
    speechStartMs = 0;

    setStatus("🎙️ Микрофон активен. Говори.");
    setBadge("—");
    logLine("MIC START OK");

    loop();
    return true;
  } catch (e) {
    setStatus("⚠️ AudioContext ошибка: " + (e?.name || e));
    logLine("AudioContext ERROR: " + (e?.name || e));
    return false;
  }
}

function stopMic() {
  running = false;
  speaking = false;
  setBadge("—");
  setStatus("⏹️ Остановлено");
  logLine("MIC STOP");

  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;

  try { sourceNode && sourceNode.disconnect(); } catch {}

  if (stream) {
    stream.getTracks().forEach(tr => tr.stop());
    stream = null;
  }
  if (audioCtx) {
    try { audioCtx.close(); } catch {}
    audioCtx = null;
  }
  sourceNode = null;
  analyser = null;
  data = null;
}

function clearAll() {
  segments.length = 0;
  currentSegmentIndex = 0;

  if (ui.outText) ui.outText.value = "";
  if (ui.outQuestions) ui.outQuestions.value = "";
  if (ui.outLog) ui.outLog.value = "";

  setLive("…");
  setBadge("—");
  setStatus("Очищено. Нажми START/«Разрешить микрофон».");
  logLine("CLEARED");
}

async function onStart() {
  if (running) return;
  setStatus("…");
  await startMic();
}

function onStop() { stopMic(); }
function downloadLast() {
  logLine("DOWNLOAD CLICK");

  const s = segments[0];
  if (!s) {
    setStatus("⚠️ Нет сегментов");
    logLine("DOWNLOAD: no segments");
    return;
  }
  if (!s.blob) {
    setStatus("⚠️ У сегмента нет blob (добавь blob в segments.unshift)");
    logLine("DOWNLOAD: blob missing");
    return;
  }

  const url = URL.createObjectURL(s.blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `luba_segment_${s.idx}.m4a`;
  document.body.appendChild(a);
  a.click();
  a.remove();

  setStatus(`⬇️ Скачан сегмент #${s.idx}`);
  logLine(`DOWNLOAD OK: #${s.idx}`);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}


if (ui.btnStart) ui.btnStart.addEventListener("click", onStart);
if (ui.btnStop) ui.btnStop.addEventListener("click", onStop);
if (ui.btnMic) ui.btnMic.addEventListener("click", onStart);
if (ui.btnClear) ui.btnClear.addEventListener("click", clearAll);
if (ui.btnDownload) ui.btnDownload.addEventListener("click", downloadLast);

setStatus("Готово. Нажми START (или «Разрешить микрофон»).");
setLive("…");
setBadge("—");
logLine("APP READY v0.31");
