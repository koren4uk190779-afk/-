// LUBA v0.3 — iOS SAFE MODE
// ✅ работает на iPhone Safari: getUserMedia + AudioContext
// ❌ без SpeechRecognition (потому что iOS часто даёт service-not-allowed)

const ui = {
  status: document.getElementById("status"),
  btnMic: document.getElementById("btnMic"),
  btnClear: document.getElementById("btnClear"),
  btnStart: document.getElementById("btnStart"),
  btnStop: document.getElementById("btnStop"),
  liveText: document.getElementById("liveText"),
  badge: document.getElementById("badge"),
  outText: document.getElementById("outText"),
  outQuestions: document.getElementById("outQuestions"),
  outLog: document.getElementById("outLog"),
};

function setStatus(t) { ui.status && (ui.status.textContent = t); }
function setBadge(t)  { ui.badge && (ui.badge.textContent = t); }
function setLive(t)   { ui.liveText && (ui.liveText.textContent = t); }
function logLine(t) {
  if (!ui.outLog) return;
  const ts = new Date().toLocaleTimeString();
  ui.outLog.value = `[${ts}] ${t}\n` + ui.outLog.value;
}

// --------- Audio engine ----------
let stream = null;
let audioCtx = null;
let sourceNode = null;
let analyser = null;
let data = null;
let rafId = null;

let running = false;

// VAD (очень простой)
let speaking = false;
let lastSpeechMs = 0;
let speechStartMs = 0;

// "вопрос" — простая эвристика по окончанию фразы:
// если была речь и потом пауза >= PAUSE_MS, считаем "возможный вопрос"
// позже заменим на STT/интонацию/словари
const PAUSE_MS = 900;     // пауза после речи
const THRESH_ENERGY = 18; // порог энергии (0..~60). Если тихо — увеличь/уменьши

function nowMs() { return Date.now(); }

function energyFromAnalyser() {
  // берём временной сигнал и считаем среднюю "амплитуду"
  analyser.getByteTimeDomainData(data);
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    const v = data[i] - 128;      // центр 0
    sum += Math.abs(v);
  }
  return sum / data.length; // средняя амплитуда
}

function renderMeters(energy) {
  // Показываем "уровень" и состояние
  const lvl = Math.round(energy);
  const state = speaking ? "🗣️ речь" : "🤫 тишина";
  setLive(`${state} | уровень: ${lvl} | порог: ${THRESH_ENERGY}`);
  if (ui.outText) ui.outText.value = `Energy=${lvl} | Speaking=${speaking}`;
}

function pushQuestionMarker(reason) {
  setBadge("❓ POSSIBLE QUESTION");
  const line = `❓ Возможный вопрос (конец фразы) — ${reason}`;
  if (ui.outQuestions) {
    ui.outQuestions.value = (line + "\n") + (ui.outQuestions.value || "");
  }
  logLine(line);
  // сброс бейджа через пару секунд
  setTimeout(() => {
    if (!speaking) setBadge("—");
  }, 2500);
}

function loop() {
  if (!running) return;

  const e = energyFromAnalyser();
  const t = nowMs();
  renderMeters(e);

  const isSpeechNow = e >= THRESH_ENERGY;

  if (isSpeechNow) {
    if (!speaking) {
      speaking = true;
      speechStartMs = t;
      logLine("SPEECH START");
      setStatus("🎙️ Слушаю… говори");
      setBadge("—");
    }
    lastSpeechMs = t;
  } else {
    if (speaking) {
      // уже была речь, теперь тишина
      const since = t - lastSpeechMs;
      if (since >= PAUSE_MS) {
        // конец фразы
        const dur = t - speechStartMs;
        speaking = false;
        logLine(`SPEECH END (dur=${dur}ms, pause=${since}ms)`);
        setStatus("⏸️ Пауза…");
        // эвристика: если фраза длилась > 600мс — считаем, что это "сказал что-то"
        if (dur > 600) {
          pushQuestionMarker(`пауза ${since}ms после речи`);
        }
      }
    }
  }

  rafId = requestAnimationFrame(loop);
}

async function startMic() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
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
  try { analyser && analyser.disconnect && analyser.disconnect(); } catch {}

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
  if (ui.outText) ui.outText.value = "";
  if (ui.outQuestions) ui.outQuestions.value = "";
  if (ui.outLog) ui.outLog.value = "";
  setLive("…");
  setBadge("—");
  setStatus("Очищено. Нажми START/«Разрешить микрофон».");
  logLine("CLEARED");
}

// Кнопки
async function onStart() {
  if (running) return;
  setStatus("…");
  await startMic();
}

function onStop() {
  stopMic();
}

if (ui.btnStart) ui.btnStart.addEventListener("click", onStart);
if (ui.btnStop) ui.btnStop.addEventListener("click", onStop);
if (ui.btnMic) ui.btnMic.addEventListener("click", onStart);
if (ui.btnClear) ui.btnClear.addEventListener("click", clearAll);

// init
setStatus("Готово. Нажми START (или «Разрешить микрофон»).");
setLive("…");
setBadge("—");
logLine("APP READY v0.3");
