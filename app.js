// LUBA / LIVE SPEECH MODE v0.1
// iPhone Safari: распознавание запускается ТОЛЬКО по клику

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

const ui = {
  start: document.getElementById("btnStart"),
  stop: document.getElementById("btnStop"),
  live: document.getElementById("liveText"),
  status: document.getElementById("status"),
  badge: document.getElementById("badge"),
};

function setStatus(t) { if (ui.status) ui.status.textContent = t; }
function setBadge(t)  { if (ui.badge)  ui.badge.textContent  = t; }
function setLive(t)   { if (ui.live)   ui.live.textContent   = t; }

function isQuestion(text) {
  const t = (text || "").trim().toLowerCase();
  if (!t) return false;

  // 1) Явные знаки вопроса
  if (t.includes("?") || t.includes("¿")) return true;

  // 2) Триггер-слова (RU/UA) — можно расширять
  const starters = [
    "почему", "зачем", "как", "когда", "куда", "кто", "что", "сколько",
    "можно", "нужно ли", "правильно ли", "что делать", "на основании чего",

    "чому", "навіщо", "як", "коли", "куди", "хто", "що", "скільки",
    "можна", "чи можна", "чи потрібно", "чи потрібно", "що робити", "на підставі чого"
  ];

  // вопрос чаще начинается с них, но не всегда — поэтому проверяем "в начале"
  for (const s of starters) {
    if (t.startsWith(s + " ") || t === s) return true;
  }

  // 3) "ли / чи" как индикатор
  if (t.includes(" ли ") || t.endsWith(" ли") || t.includes(" чи ") || t.endsWith(" чи")) return true;

  return false;
}

let rec = null;
let listening = false;
let finalText = "";       // накопление финальных фраз
let interimText = "";     // текущая "живая" фраза

function ensureSupportOrFail() {
  if (!SpeechRecognition) {
    setStatus("❌ SpeechRecognition не поддерживается. Открой в Safari на iPhone.");
    return false;
  }
  return true;
}

async function requestMicPermission() {
  // На iOS иногда помогает явно запросить mic до SpeechRecognition
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    // сразу освобождаем
    stream.getTracks().forEach(tr => tr.stop());
    return true;
  } catch (e) {
    setStatus("❌ Нет доступа к микрофону. Разреши микрофон в Safari для сайта.");
    return false;
  }
}

function render() {
  const merged = [finalText.trim(), interimText.trim()].filter(Boolean).join(" ");
  setLive(merged || "…");
  setBadge(isQuestion(merged) ? "❓ QUESTION DETECTED" : "—");
}

function startRec() {
  if (!ensureSupportOrFail()) return;

  rec = new SpeechRecognition();
  rec.lang = "uk-UA";           // основной язык украинский (можешь менять на ru-RU при необходимости)
  rec.interimResults = true;
  rec.continuous = true;

  rec.onstart = () => {
    listening = true;
    setStatus("🎙️ Слушаю… говори");
    setBadge("—");
  };

  rec.onerror = (e) => {
    setStatus("⚠️ Ошибка: " + (e?.error || "unknown"));
  };

  rec.onend = () => {
    listening = false;
    setStatus("⏹️ Остановлено");
  };

  rec.onresult = (event) => {
    interimText = "";

    for (let i = event.resultIndex; i < event.results.length; i++) {
      const res = event.results[i];
      const txt = (res[0]?.transcript || "").trim();

      if (res.isFinal) {
        // финальная фраза
        finalText = (finalText + " " + txt).trim();
      } else {
        // живая фраза
        interimText = txt;
      }
    }

    render();
  };

  // старт
  try {
    rec.start();
  } catch (e) {
    setStatus("⚠️ Не удалось стартовать: " + (e?.name || e));
  }
}

function stopRec() {
  try { rec && rec.stop(); } catch {}
  listening = false;
  setStatus("⏹️ Остановлено");
}

async function onStartClick() {
  setStatus("…");
  const ok = await requestMicPermission();
  if (!ok) return;

  // очистка на новый запуск (можешь убрать, если нужно сохранять)
  finalText = "";
  interimText = "";
  render();

  startRec();
}

function onStopClick() {
  stopRec();
}

if (ui.start) ui.start.addEventListener("click", onStartClick);
if (ui.stop) ui.stop.addEventListener("click", onStopClick);

// первичное состояние
setStatus("Готово. Нажми START и говори.");
setLive("…");
setBadge("—");
