// LUBA v0.41 — iOS SAFE MODE: запись сегментов + стабильная сегментация (anti-cut + iOS fixes)
// ✅ getUserMedia + AudioContext + MediaRecorder
// ❌ без SpeechRecognition (на iOS Safari часто service-not-allowed)

// ===================== CONFIG =====================
const CFG = {
  // пороги (гистерезис)
  START_TH: 18,   // вход в речь
  STOP_TH:  12,   // удержание речи (ниже, чтобы не рвало)

  // паузы
  SILENCE_CONFIRM_MS: 350, // тишина должна продлиться хотя бы столько, чтобы считаться "реальной"
  PAUSE_MS: 1600,          // конец фразы только после такой тишины
  MIN_SEGMENT_MS: 2500,    // короткие сегменты не режем (вдох/пауза внутри)

  // эвристика "вопроса" (временно, пока нет текста)
  QUESTION_MIN_MS: 2000,

  // анти-залипание: сколько раз можно "удержать" короткий сегмент
  SHORT_HOLD_MAX: 2
};

// ===================== UI =====================
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

// ===================== AUDIO STATE =====================
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

// анти-залипание
let shortHoldCount = 0;

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

// ===================== RECORDER STATE =====================
let recorder = null;
let recChunks = [];
let currentSegmentIndex = 0;

const segments = []; // {idx, durMs, blobSize, blob, isQuestion}

// iOS-safe mime picker
function pickMime() {
  // Порядок важен: сначала то, что чаще работает на iOS
  const candidates = [
    "audio/mp4",
    "audio/aac",
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus"
  ];
  if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return "";
  for (const m of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(m)) return m;
    } catch {}
  }
  return "";
}

function startSegmentRecording() {
  if (!stream) return;
  if (!window.MediaRecorder) {
    logLine("MediaRecorder NOT SUPPORTED");
    return;
  }
  // не стартуем второй раз, если уже пишем
  if (recorder && recorder.state !== "inactive") return;

  try {
    recChunks = [];
    const mt = pickMime();
    recorder = mt ? new MediaRecorder(stream, { mimeType: mt }) : new MediaRecorder(stream);

    logLine("MediaRecorder mime=" + (mt || recorder.mimeType || "default"));

    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size) recChunks.push(e.data);
    };
    recorder.onstart = () => logLine("RECORDER STARTED");
    recorder.onerror = (e) => logLine("RECORDER ERROR: " + (e?.name || e));
    recorder.start(); // без timeslice = один blob на stop
    setStatus("🎙️ REC: запись сегмента…");
  } catch (e) {
    logLine("MediaRecorder CREATE ERROR: " + (e?.name || e));
    recorder = null;
    recChunks = [];
  }
}

function stopSegmentRecordingAndStore() {
  return new Promise((resolve) => {
    if (!recorder) return resolve(null);

    // если уже inactive — просто собираем то что есть
    if (recorder.state === "inactive") {
      const blob = new Blob(recChunks, { type: (recorder.mimeType || "audio/mp4") });
      const res = { blob, size: blob.size };
      recorder = null;
      recChunks = [];
      return resolve(res);
    }

    try {
      const localRecorder = recorder;

      localRecorder.onstop = () => {
        const chunks = recChunks;
        const mime = localRecorder?.mimeType || "audio/mp4";
        recorder = null;
        recChunks = [];

        const blob = new Blob(chunks, { type: mime });
        resolve({ blob, size: blob.size });
      };

      localRecorder.stop();
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
      .map(s => `#${s.idx} | dur=${Math.round(s.durMs)}ms | audio=${Math.round(s.blobSize/1024)}KB | ${s.isQuestion ? "❓(heur)" : "—"}`)
      .join("\n");
  }
  if (ui.outQuestions) {
    ui.outQuestions.value = segments
      .filter(s => s.isQuestion)
      .map(s => `❓ Сегмент #${s.idx} (dur=${Math.round(s.durMs)}ms) — возможный вопрос (heur)`)
      .join("\n");
  }
}

// ===================== CORE LOOP =====================
function loop() {
  if (!running) return;

  const e = energyFromAnalyser();
  const t = nowMs();
  const lvl = Math.round(e);

  setLive(`${speaking ? "🗣️ речь" : "🤫 тишина"} | lvl:${lvl} | start:${CFG.START_TH} stop:${CFG.STOP_TH} | pause:${CFG.PAUSE_MS}`);

  // Гистерезис: вход по START_TH, удержание по STOP_TH
  const isSpeechNow = !speaking ? (e >= CFG.START_TH) : (e >= CFG.STOP_TH);

  if (isSpeechNow) {
    if (!speaking) {
      speaking = true;
      shortHoldCount = 0;
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
        // анти-рваньё: короткие куски не закрываем, но и не даём залипнуть бесконечно
        if (dur < CFG.MIN_SEGMENT_MS) {
          shortHoldCount++;
          logLine(`SKIP CUT short dur=${dur}ms hold=${shortHoldCount}/${CFG.SHORT_HOLD_MAX}`);
          setStatus("… продолжаем (коротко)");

          if (shortHoldCount <= CFG.SHORT_HOLD_MAX) {
            // мягко "поддержим" lastSpeechMs
            lastSpeechMs = t - (CFG.PAUSE_MS - 200);
          } else {
            // форсируем закрытие, иначе recorder будет писать тишину
            speaking = false;
            shortHoldCount = 0;
            setStatus("⏸️ Конец (форс) короткого сегмента");
            logLine(`FORCE END short segment dur=${dur}ms silence=${silenceFor}ms`);

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
              if (isQ) setBadge("❓ POSSIBLE QUESTION (heur)");
              logLine(isQ ? `SEGMENT #${currentSegmentIndex} saved as QUESTION (heur)` : `SEGMENT #${currentSegmentIndex} saved`);
              redrawTextAreas();
            });
          }
        } else {
          // нормальное закрытие
          speaking = false;
          shortHoldCount = 0;
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
            if (isQ) setBadge("❓ POSSIBLE QUESTION (heur)");
            logLine(isQ ? `SEGMENT #${currentSegmentIndex} saved as QUESTION (heur)` : `SEGMENT #${currentSegmentIndex} saved`);
            redrawTextAreas();
          });
        }
      }
    }
  }

  rafId = requestAnimationFrame(loop);
}

// ===================== MIC CONTROL =====================
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
    shortHoldCount = 0;
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

// ВАЖНО: stopMic async — чтобы корректно закрыть активную запись
async function stopMic() {
  running = false;

  // Если прямо сейчас был активный сегмент — закрываем его корректно
  if (recorder) {
    const dur = speaking ? (nowMs() - speechStartMs) : 0;
    const isQ = dur >= CFG.QUESTION_MIN_MS;

    const res = await stopSegmentRecordingAndStore();

    // Если речь шла — сохраняем как последний сегмент (даже если нажали STOP внезапно)
    if (speaking) {
      speaking = false;
      shortHoldCount = 0;

      // сохраняем только если blob не пустой
      if (res?.blob && res.size > 0) {
        currentSegmentIndex += 1;
        segments.unshift({
          idx: currentSegmentIndex,
          durMs: dur,
          isQuestion: isQ,
          blobSize: res.size,
          blob: res.blob,
        });
        logLine(`FINAL SEGMENT #${currentSegmentIndex} saved on STOP dur=${dur}ms`);
        redrawTextAreas();
      } else {
        logLine("FINAL SEGMENT on STOP: empty blob");
      }
    }
  }

  speaking = false;
  shortHoldCount = 0;
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
    try { await audioCtx.close(); } catch {}
    audioCtx = null;
  }
  sourceNode = null;
  analyser = null;
  data = null;
}

// ===================== UI ACTIONS =====================
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

  // расширение под mime (если смогли определить)
  const ext = (s.blob.type || "").includes("webm") ? "webm" : "m4a";
  a.download = `luba_segment_${s.idx}.${ext}`;

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

async function onStop() {
  await stopMic();
}

// ===================== EVENTS =====================
if (ui.btnStart) ui.btnStart.addEventListener("click", onStart);
if (ui.btnStop) ui.btnStop.addEventListener("click", onStop);
if (ui.btnMic) ui.btnMic.addEventListener("click", onStart);
if (ui.btnClear) ui.btnClear.addEventListener("click", clearAll);
if (ui.btnDownload) ui.btnDownload.addEventListener("click", downloadLast);

// ===================== INIT =====================
setStatus("Готово. Нажми START (или «Разрешить микрофон»).");
setLive("…");
setBadge("—");
logLine("APP READY v0.41");
