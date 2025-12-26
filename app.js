// LUBA v0.40 — iOS SAFE MODE: запись сегментов + стабильная сегментация (anti-cut)
// ✅ getUserMedia + AudioContext + MediaRecorder
// ❌ без SpeechRecognition (на iOS Safari часто service-not-allowed)

const CFG = {
  // пороги (гистерезис)
  START_TH: 18,   // вход в речь
  STOP_TH:  12,   // удержание речи (ниже, чтобы не рвало)

  // паузы
  SILENCE_CONFIRM_MS: 350, // тишина должна продлиться хотя бы столько, чтобы считаться "реальной"
  PAUSE_MS: 1600,          // конец фразы только после такой тишины
  MIN_SEGMENT_MS: 2500,    // короткие сегменты не режем (вдох/пауза внутри)

  // эвристика "вопроса" (временно, пока нет текста)
  QUESTION_MIN_MS: 2000
};

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

if (ui.pauseMsLabel) ui.pauseMsLabel.textContent = String(CFG.PAUSE_MS);
if (ui.thrLabel) ui.thrLabel.textContent = String(CFG.START_TH);

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

const segments = []; // {idx, durMs, blobSize, blob, isQuestion}

function startSegmentRecording() {
  if (!stream) return;
  if (!window.MediaRecorder) {
    logLine("MediaRecorder NOT SUPPORTED");
    return;
  }
  try {
    recChunks = [];
    recorder = new MediaRecorder(stream, { mimeType: "audio/mp4" });
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) recChunks.push(e.data); };
    recorder.onstart = () => logLine("RECORDER STARTED");
    recorder.start();
    setStatus("🎙️ REC: запись сегмента…");
  } catch (e) {
    logLine("MediaRecorder ERROR: " + (e?.name || e));
  }
}

function stopSegmentRecordingAndStore() {
  return new Promise((resolve) => {
    if (!recorder) return resolve(null);

    try {
      recorder.onstop = () => {
        const chunks = recChunks;
        const mime = recorder?.mimeType || "audio/mp4";
        recorder = null;
        recChunks = [];
        const blob = new Blob(chunks, { type: mime });
        resolve({ blob, size: blob.size });
      };
      recorder.stop();
    } catch {
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

  setLive(`${speaking ? "🗣️ речь" : "🤫 тишина"} | lvl:${lvl} | start:${CFG.START_TH} stop:${CFG.STOP_TH} | pause:${CFG.PAUSE_MS}`);

  // Гистерезис
  const isSpeechNow = !speaking ? (e >= CFG.START_TH) : (e >= CFG.STOP_TH);

  if (isSpeechNow) {
    if (!speaking) {
      speaking = true;
      speechStartMs = t;
      lastSpeechMs = t;
      setStatus("🎙️ Слушаю…");
      setBadge("—");
      logLine("SPEECH START");
      startSegmentRecording();
    } else {
      lastSpeechMs = t;
    }
  } else {
    if (speaking) {
      const silenceFor = t - lastSpeechMs;
      const dur = t - speechStartMs;

      // 1) микро-провалы уровня игнорируем
      if (silenceFor < CFG.SILENCE_CONFIRM_MS) {
        // ничего
      }
      // 2) пауза подтверждена, но ещё не конец фразы
      else if (silenceFor < CFG.PAUSE_MS) {
        setStatus("… пауза внутри фразы");
      }
      // 3) конец фразы (пауза длинная)
      else {
        // анти-рваньё: короткие куски не закрываем
        if (dur < CFG.MIN_SEGMENT_MS) {
          logLine(`SKIP CUT short dur=${dur}ms`);
          // "поддержим" lastSpeechMs, чтобы не закрывало снова мгновенно
          lastSpeechMs = t - (CFG.PAUSE_MS - 200);
          setStatus("… продолжаем (коротко)");
        } else {
          speaking = false;
          setStatus("⏸️ Конец фразы");
          logLine(`SPEECH END dur=${dur}ms silence=${silenceFor}ms`);

          const isQ = dur >= CFG.QUESTION_MIN_MS;

          stopSegmentRecordingAndStore().then((res) => {
            currentSegmentIndex += 1;

            segments.unshift({
              idx: currentSegmentIndex,
              durMs: dur,
              isQuestion: isQ,
              blobSize: res?.size || 0,
              blob: res?.blob || null,
            });

            setStatus(`✅ Сегмент #${currentSegmentIndex} сохранён (${Math.round((res?.size || 0) / 1024)}KB)`);
            if (isQ) setBadge("❓ POSSIBLE QUESTION");
            logLine(isQ ? `SEGMENT #${currentSegmentIndex} saved as QUESTION` : `SEGMENT #${currentSegmentIndex} saved`);
            redrawTextAreas();
          });
        }
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

function downloadLast() {
  logLine("DOWNLOAD CLICK");

  const s = segments[0];
  if (!s) {
    setStatus("⚠️ Нет сегментов");
    logLine("DOWNLOAD: no segments");
    return;
  }
  if (!s.blob) {
    setStatus("⚠️ У сегмента нет blob");
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

async function onStart() {
  if (running) return;
  setStatus("…");
  await startMic();
}
function onStop() { stopMic(); }

if (ui.btnStart) ui.btnStart.addEventListener("click", onStart);
if (ui.btnStop) ui.btnStop.addEventListener("click", onStop);
if (ui.btnMic) ui.btnMic.addEventListener("click", onStart);
if (ui.btnClear) ui.btnClear.addEventListener("click", clearAll);
if (ui.btnDownload) ui.btnDownload.addEventListener("click", downloadLast);

setStatus("Готово. Нажми START (или «Разрешить микрофон»).");
setLive("…");
setBadge("—");
logLine("APP READY v0.40");
