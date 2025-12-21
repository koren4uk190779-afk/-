// =====================
// Luba — app.js (целиком)
// =====================

// --- DOM ---
const btn =
  document.getElementById("startBtn") ||
  document.getElementById("btnMic") ||
  document.querySelector("button");

const statusEl = document.getElementById("status");
const heardEl = document.getElementById("heard");
const answerEl = document.getElementById("answer");
const transcriptEl = document.getElementById("transcript"); // поле для общей транскрипции (если есть)
const outQuestions = document.getElementById("outQuestions"); // textarea/поле для вопросов (если есть)
const outText = document.getElementById("outText"); // текст
const logEl = document.getElementById("outLog");    // лог

let qCount = 0;
const seenQuestions = new Set();

// --- helpers ---
function log(s) {
  const msg = String(s ?? "");
  console.log(msg);
  if (logEl && "value" in logEl) {
    logEl.value += msg + "\n";
    logEl.scrollTop = logEl.scrollHeight;
  }
}

function setStatus(s) {
  if (statusEl) statusEl.textContent = s;
  log("STATUS: " + s);
}

function norm(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[’'`]/g, "ʼ")
    .replace(/[^\p{L}\p{N}\s\?\-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function capFirst(s) {
  const t = String(s ?? "").trim();
  if (!t) return t;
  return t[0].toUpperCase() + t.slice(1);
}

function hitWord(t, w) {
  // отдельное слово
  const re = new RegExp(`(^|\\s)${w}(\\s|$)`, "i");
  return re.test(t);
}

function isFillerOnly(t) {
  const fillers = [
    "ну", "типу", "короче", "значить", "як би", "якби", "вобщем", "вообще",
    "ээ", "ем", "мм", "ага", "угу", "так", "да", "ні", "не", "ок", "окей"
  ];
  const words = norm(t).split(" ").filter(Boolean);
  if (!words.length) return true;
  return words.every((w) => fillers.includes(w));
}

// =====================
// Контрольные фразы и якоря (твои)
// =====================

// === Контрольные фразы и маркеры для вопросов ===
const Q_PHRASES = [
  // русские фразы
  "подскажи", "скажи", "скажите", "можно", "нужно ли", "правильно ли", "неправильно ли",
  "как правильно", "что значит", "как понять", "какое решение", "что делать", "на основании чего",
  "какой статьей", "каким пунктом", "каким законом", "что если", "почему", "сколько",
  "куда", "когда", "кто", "чем", "который",

  // украинские фразы
  "підкажи", "підкажіть", "скажіть", "можна", "чи можна", "чи потрібно", "на підставі чого",
  "якою статтею", "яким пунктом", "яким законом", "чому", "скільки", "куди", "коли", "хто", "чим",
  "якою", "яка", "які", "яким чином", "яким способом"
];

// Маркеры для распознавания вопросов
const Q_WORDS_RU = ["что", "как", "когда", "где", "куда", "почему", "сколько", "кто", "какой", "который"];
const Q_WORDS_UA = ["що", "як", "коли", "де", "куди", "чому", "скільки", "хто", "який", "якою", "які"];

// Якоря для вырезания хвоста вопроса
const QUESTION_ANCHORS = [
  "почему", "зачем", "как", "что", "когда", "где", "куда", "сколько", "кто",
  "который", "которая", "которое", "которые", "подскажи", "скажите", "скажи", "можно", "можете", "нужно ли", "правильно ли", "как понять",
  "какой статьей", "каким пунктом", "каким законом", "на основании чего",
  "чому", "навіщо", "як", "що", "коли", "де", "куди", "скільки", "хто", "якою", "якій", "яким", "якої", "яких",
  "підкажи", "підкажіть", "скажіть", "чи", "чи можна", "чи потрібно", "якою статтею", "яким пунктом", "яким законом", "на підставі чого"
];

// Функция для извлечения только вопроса из фразы
function extractQuestionTail(phrase) {
  const raw = (phrase || "").trim();
  const t = norm(raw);
  if (!t) return raw;

  let best = -1;
  for (const a of QUESTION_ANCHORS) {
    const p = t.lastIndexOf(a);
    if (p > best) best = p;
  }
  if (best <= 0) return raw;

  const anchorWord = t.slice(best).split(" ")[0];
  const rawLower = raw.toLowerCase();
  const pos = rawLower.lastIndexOf(anchorWord);
  if (pos <= 0) return raw;

  return raw.slice(pos).trim();
}

// === Дополнительные улучшения для более точного распознавания ===
const QUESTION_THRESHOLD = 1; // агрессивнее

// === Функция для проверки "похоже ли на вопрос" ===
function questionScore(phrase) {
  const raw = phrase || "";
  const t = norm(raw);

  let score = 0;
  const reasons = [];

  if (!t) return { score: 0, reasons: ["empty"] };
  if (raw.includes("?")) { score += 3; reasons.push("has ?"); }

  let ru = 0;
  for (const w of Q_WORDS_RU) if (hitWord(t, w)) ru++;
  if (ru) { score += Math.min(6, ru * 2); reasons.push(`ru_qwords:${ru}`); }

  let ua = 0;
  for (const w of Q_WORDS_UA) if (hitWord(t, w)) ua++;
  if (ua) { score += Math.min(6, ua * 2); reasons.push(`ua_qwords:${ua}`); }

  let ph = 0;
  for (const p of Q_PHRASES) if (t.includes(p)) ph++;
  if (ph) { score += Math.min(6, ph * 2); reasons.push(`q_phrases:${ph}`); }

  if (isFillerOnly(t)) { score = 0; reasons.push("filler_only"); }
  if (t.length < 6) { score = Math.max(0, score - 2); reasons.push("too_short"); }

  return { score, reasons };
}

// Функция добавления вопроса в поле вывода
function appendQuestion(q) {
  const clean = extractQuestionTail(q);
  const key = norm(clean);

  if (!key || seenQuestions.has(key)) {
    log(`QUESTION skipped (duplicate/empty): "${clean}"`);
    return;
  }
  seenQuestions.add(key);

  qCount += 1;

  // Обновляем поле вывода вопросов
  if (outQuestions && "value" in outQuestions) {
    outQuestions.value += `${qCount}) ${capFirst(clean)}?\n`;
    outQuestions.scrollTop = outQuestions.scrollHeight;
  } else {
    log(`QUESTION: ${qCount}) ${capFirst(clean)}?`);
  }
}

// =====================
// Микрофон + распознавание (фикс кнопки iPhone/Safari)
// =====================

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null;
let listening = false;
let micStream = null;
let audioCtx = null;

async function ensureMicPermission() {
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    log("Микрофон подключен.");
    return true;
  } catch (e) {
    log("Ошибка при подключении к микрофону: " + (e?.name || e));
    alert("Ошибка подключения к микрофону. Пожалуйста, проверьте разрешения в браузере.");
    return false;
  }
}

async function ensureAudioContext() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state !== "running") await audioCtx.resume();
    log("Аудио контекст активирован.");
    return true;
  } catch (e) {
    log("Ошибка активации аудио контекста: " + (e?.name || e));
    return false;
  }
}

function stopTracks() {
  try {
    if (micStream) {
      micStream.getTracks().forEach((t) => t.stop());
      micStream = null;
    }
  } catch (_) {}
}

function buildRecognition() {
  if (!SpeechRecognition) return null;

  const r = new SpeechRecognition();
  r.lang = "uk-UA";
  r.continuous = true;
  r.interimResults = false;
  r.maxAlternatives = 1;

  r.onstart = () => {
    listening = true;
    if (btn) btn.textContent = "⏹ Зупинити мікрофон";
    setStatus("🎧 Слухаю…");
  };

  r.onend = () => {
    listening = false;
    if (btn) btn.textContent = "🎙 Увімкнути мікрофон";
    setStatus("⏸ Зупинено");
  };

  // === Обработчик ошибок (твой, но привязан к реальному rec) ===
  r.onerror = (e) => {
    const err = e?.error || String(e);

    if (err === "no-speech") {
      setStatus("Тишина… жду речь.");
      return;
    }

    log(`SR ERROR: ${err}`);
    setStatus(`Ошибка распознавания: ${err}. Попробую продолжить…`);
  };

r.onresult = (event) => {
  const idx = event.results.length - 1;
  const raw = event.results[idx][0].transcript || "";
  const t = norm(raw);
  
 if (outText && "value" in outText) {
  outText.value += (outText.value ? " " : "") + raw;
  outText.scrollTop = outText.scrollHeight;
}

  // Логирование текста, чтобы увидеть, что происходит
  log(`HEARD: ${raw}`);

  // Обновляем элемент для отображения распознанного текста
  if (heardEl) heardEl.textContent = raw;

  const { score, reasons } = questionScore(raw);
  log(`SCORE: ${score} (${reasons.join(",")})`);

  // Если это вопрос, добавляем его в список
  if (score >= QUESTION_THRESHOLD) {
    appendQuestion(raw);
    if (answerEl) answerEl.textContent = "Питання зафіксовано ✅";
    return;
  }

  if (answerEl) answerEl.textContent = "Не схоже на питання (ігнорую).";
};

  return r;
}

function canWork() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setStatus("🚫 Немає доступу до мікрофона (getUserMedia недоступний).");
    return false;
  }
  if (!SpeechRecognition) {
    setStatus("🚫 Розпізнавання мови не підтримується в цьому браузері.");
    return false;
  }
  return true;
}

async function startListening() {
  if (!canWork()) return;

  setStatus("⏳ Перевіряю мікрофон…");

  const okMic = await ensureMicPermission();
  if (!okMic) {
    setStatus("🚫 Дозвіл на мікрофон не надано. Натисни Allow/Дозволити.");
    log("Микрофон не был разрешён.");
    return;
  }

  const okCtx = await ensureAudioContext();
  if (!okCtx) {
    setStatus("🚫 Не можу активувати аудіо-контекст.");
    log("Не удаётся активировать аудиоконтекст.");
    return;
  }

  rec = rec || buildRecognition();
  if (!rec) {
    setStatus("🚫 Не створився SpeechRecognition.");
    log("Не создан SpeechRecognition.");
    return;
  }

  try {
    rec.start();
    setStatus("🎧 Мікрофон працює, чекаю на розпізнавання...");
    log("Распознавание начато.");
  } catch (e) {
    log("Ошибка при запуске распознавания речи: " + e);
    setStatus("🚫 Не стартує розпізнавання.");
  }
}

function stopListening() {
  try { if (rec) rec.stop(); } catch (_) {}
  stopTracks();
  setStatus("⏸ Зупинено");
}

function init() {
  rec = buildRecognition();

  if (btn) {
    btn.disabled = false;
    btn.addEventListener("click", async () => {
      if (!listening) await startListening();
      else stopListening();
    });
    btn.textContent = "🎙 Увімкнути мікрофон";
    setStatus("Готово. Натисни кнопку, щоб увімкнути мікрофон.");
  } else {
    setStatus("⚠️ Не знайдена кнопка на сторінці (startBtn/btnMic).");
  }
}

init();
