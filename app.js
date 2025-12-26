// LUBA / LIVE SPEECH MODE v0.2 (под твой index.html)

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

const ui = {
  status: document.getElementById("status"),
  btnMic: document.getElementById("btnMic"),
  btnClear: document.getElementById("btnClear"),
  outText: document.getElementById("outText"),
  outQuestions: document.getElementById("outQuestions"),
  outLog: document.getElementById("outLog"),

  btnStart: document.getElementById("btnStart"),
  btnStop: document.getElementById("btnStop"),
  liveText: document.getElementById("liveText"),
  badge: document.getElementById("badge"),
};

function setStatus(t) { if (ui.status) ui.status.textContent = t; }
function setBadge(t)  { if (ui.badge) ui.badge.textContent = t; }
function setLive(t)   { if (ui.liveText) ui.liveText.textContent = t; }
function logLine(t) {
  if (!ui.outLog) return;
  const ts = new Date().toLocaleTimeString();
  ui.outLog.value = `[${ts}] ${t}\n` + ui.outLog.value;
}

function ensureSupportOrFail() {
  if (!SpeechRecognition) {
    setStatus("❌ SpeechRecognition не поддерживается. Открой в Safari на iPhone.");
    logLine("SpeechRecognition NOT SUPPORTED");
    return false;
  }
  return true;
}

async function requestMicPermission() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach(tr => tr.stop());
    return true;
  } catch (e) {
    setStatus("❌ Нет доступа к микрофону. Разреши микрофон в Safari для сайта.");
    logLine("getUserMedia ERROR: " + (e?.name || e));
    return false;
  }
}

// --- Детектор вопроса ---
function isQuestion(text) {
  const t = (text || "").trim().toLowerCase();
  if (!t) return false;

  if (t.includes("?") || t.includes("¿")) return true;

  const starters = [
    // RU
    "почему", "зачем", "как", "когда", "куда", "кто", "что", "сколько",
    "можно", "нужно ли", "правильно ли", "неправильно ли",
    "что делать", "на основании чего",
    // UA
    "чому", "навіщо", "як", "коли", "куди", "хто", "що", "скільки",
    "можна", "чи можна", "чи потрібно", "чи правильно",
    "що робити", "на підставі чого",
  ];

  for (const s of starters) {
    if (t.startsWith(s + " ") || t === s) return true;
  }

  if (t.includes(" ли ") || t.endsWith(" ли")) return true;
  if (t.includes(" чи ") || t.endsWith(" чи")) return true;

  return false;
}

function splitQuestions(fullText) {
  const parts = (fullText || "").split("?");
  const qs = [];
  for (let i = 0; i < parts.length - 1; i++) {
    const q = (parts[i] || "").trim();
    if (q) qs.push(q + "?");
  }
  return qs;
}

// --- Речь ---
let rec = null;
let listening = false;

let finalText = "";
let interimText = "";

function render() {
  const merged = [finalText.trim(), interimText.trim()].filter(Boolean).join(" ");
  setLive(merged || "…");

  const q = isQuestion(merged);
  setBadge(q ? "❓ QUESTION DETECTED" : "—");

  if (ui.outText) ui.outText.value = merged;

  if (ui.outQuestions) {
    const qs = splitQuestions(merged);
    ui.outQuestions.value = qs.join("\n");
  }
}

function startRec() {
  if (!ensureSupportOrFail()) return;

  rec = new SpeechRecognition();
  rec.lang = "uk-UA";
  rec.interimResults = true;
  rec.continuous = true;

  rec.onstart = () => {
    listening = true;
    setStatus("🎙️ Слушаю… говори");
    logLine("REC START");
  };

  rec.onerror = (e) => {
    setStatus("⚠️ Ошибка: " + (e?.error || "unknown"));
    logLine("REC ERROR: " + (e?.error || e));
  };

  rec.onend = () => {
    listening = false;
    setStatus("⏹️ Остановлено");
    logLine("REC END");
  };

  rec.onresult = (event) => {
    interimText = "";

    for (let i = event.resultIndex; i < event.results.length; i++) {
      const res = event.results[i];
      const txt = (res[0]?.transcript || "").trim();

      if (res.isFinal) {
        finalText = (finalText + " " + txt).trim();
      } else {
        interimText = txt;
      }
    }

    render();
  };

  try {
    rec.start();
  } catch (e) {
    setStatus("⚠️ Не удалось стартовать: " + (e?.name || e));
    logLine("REC START FAIL: " + (e?.name || e));
  }
}

function stopRec() {
  try { rec && rec.stop(); } catch {}
  listening = false;
  setStatus("⏹️ Остановлено");
}

async function onStart() {
  setStatus("…");
  const ok = await requestMicPermission();
  if (!ok) return;

  finalText = "";
  interimText = "";
  render();

  startRec();
}

function onStop() {
  stopRec();
}

function onClear() {
  finalText = "";
  interimText = "";
  if (ui.outText) ui.outText.value = "";
  if (ui.outQuestions) ui.outQuestions.value = "";
  if (ui.outLog) ui.outLog.value = "";
  setLive("…");
  setBadge("—");
  setStatus("Очищено. Нажми START и говори.");
  logLine("CLEARED");
}

// Привязки
if (ui.btnStart) ui.btnStart.addEventListener("click", onStart);
if (ui.btnStop) ui.btnStop.addEventListener("click", onStop);
if (ui.btnMic) ui.btnMic.addEventListener("click", onStart);
if (ui.btnClear) ui.btnClear.addEventListener("click", onClear);

// стартовое состояние
setStatus("Готово. Нажми START (или «Разрешить микрофон») и говори.");
setLive("…");
setBadge("—");
logLine("APP READY");
