/* =========================================================
   EXPERIMENT: Question Catcher
   Goal:
   - Dictate a mixed text
   - App builds punctuated text using pause detection ('.' or '?')
   - App also extracts questions into separate list
   - App logs WHY each phrase became question/not question

   IMPORTANT:
   - Browser security usually requires a user click to start mic.
========================================================= */

const elStatus = document.getElementById("status");
const outText = document.getElementById("outText");
const outQuestions = document.getElementById("outQuestions");
const outLog = document.getElementById("outLog");
const btnMic = document.getElementById("btnMic");
const btnClear = document.getElementById("btnClear");

const pauseMsEl = document.getElementById("pauseMs");
const stableMsEl = document.getElementById("stableMs");
const thrEl = document.getElementById("thr");

// === Tunables (as you asked: pause ~ 0.6–0.9 sec, we start with 800ms)
const PAUSE_END_MS = 800;   // end-of-phrase by inactivity
const STABLE_MS = 700;      // text must be stable (no changes) before commit
const QUESTION_THRESHOLD = 2; // start "catch more questions"

pauseMsEl.textContent = String(PAUSE_END_MS);
stableMsEl.textContent = String(STABLE_MS);
thrEl.textContent = String(QUESTION_THRESHOLD);

// ===== Logging
function log(line) {
  const ts = new Date().toLocaleTimeString();
  outLog.value = `[${ts}] ${line}\n` + outLog.value;
}
function setStatus(s) {
  elStatus.textContent = s;
}

// ===== Helpers
function norm(s) {
  return (s || "")
    .toLowerCase()
    .replace(/[“”«»"]/g, "")
    .replace(/[.,!;:]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function capFirst(s) {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}
function isFillerOnly(t) {
  const x = norm(t);
  if (!x) return true;
  const fillers = [
    "ага","угу","да","так","ну","добре","алло","ок",
    "зрозуміло","понял","поняла","чекаємо","на зв'язку",
    "нормально","понятно","спасибо","дякую"
  ];
  if (fillers.includes(x)) return true;
  if (x.length <= 2) return true;
  return false;
}

// ===== Question detection (RU/UA) — “ловим больше”
const Q_WORDS_RU = ["что","как","когда","где","куда","зачем","почему","сколько","кто","какой","какая","какие","каково"];
const Q_WORDS_UA_BASE = ["що","як","коли","де","куди","навіщо","чому","скільки","хто","який","яка","які"];
// Important: UA cases that часто встречаются в вопросах:
const Q_WORDS_UA_CASES = [
  "якою","якій","яким","якої","яких",
  "котрою","котрій","котрим","котрої","котрих",
  "яким чином","у який спосіб","з якої причини"
];

const Q_PHRASES = [
  // RU
  "подскажи","скажите","скажи","можете","можно","нужно ли","правильно ли","неправильно ли",
  "как правильно","что значит","как понять","какое решение","что делать","на основании чего",
  "какой статьей","каким пунктом","каким законом",
  // UA
  "підкажи","підкажіть","скажіть","скажи","можна","чи можна","чи потрібно","на підставі чого",
  "якою статтею","яким пунктом","яким законом","передбачено","регулюється"
];

function hitWord(text, w) {
  const t = ` ${text} `;
  return t.includes(` ${w} `);
}

function questionScore(phrase) {
  const raw = phrase || "";
  const t = norm(raw);

  let score = 0;
  const reasons = [];

  if (!t) return { score: 0, reasons: ["empty"] };

  // punctuation (if recognition ever gives it)
  if (raw.includes("?")) { score += 3; reasons.push("has ?"); }

  // RU question words
  let ru = 0;
  for (const w of Q_WORDS_RU) if (hitWord(t, w)) ru++;
  if (ru) { score += Math.min(6, ru * 2); reasons.push(`ru_qwords:${ru}`); }

  // UA question words base
  let ua = 0;
  for (const w of Q_WORDS_UA_BASE) if (hitWord(t, w)) ua++;
  if (ua) { score += Math.min(6, ua * 2); reasons.push(`ua_qwords:${ua}`); }

  // UA cases / patterns
  let uac = 0;
  for (const w of Q_WORDS_UA_CASES) if (t.includes(w)) uac++;
  if (uac) { score += Math.min(5, uac * 2); reasons.push(`ua_cases:${uac}`); }

  // particles
  if (t.includes(" ли ")) { score += 2; reasons.push("has 'ли'"); }
  if (t.startsWith("чи ") || t.includes(" чи ")) { score += 2; reasons.push("has 'чи'"); }

  // phrases
  let ph = 0;
  for (const p of Q_PHRASES) if (t.includes(p)) ph++;
  if (ph) { score += Math.min(6, ph * 2); reasons.push(`q_phrases:${ph}`); }

  // penalize fillers
  if (isFillerOnly(t)) { score = 0; reasons.push("filler_only"); }

  // too short often noise
  if (t.length < 6) { score = Math.max(0, score - 2); reasons.push("too_short"); }

  return { score, reasons };
}

// ===== State: we build phrases on pause/stable
let sr = null;
let running = false;

let lastInterim = "";
let lastInterimChangeAt = 0;
let lastUpdateAt = 0;

let commitTimer = null;

let fullPunctText = "";
let qCount = 0;

function appendPunctSentence(sentence, isQuestion) {
  const s = capFirst(sentence.trim());
  if (!s) return;

  const end = isQuestion ? "?" : ".";
  fullPunctText += (fullPunctText ? " " : "") + s + end;

  outText.value = fullPunctText;
}

function appendQuestion(q) {
  qCount += 1;
  outQuestions.value += `${qCount}) ${capFirst(q.trim())}?\n`;
}

function clearAll() {
  fullPunctText = "";
  qCount = 0;
  outText.value = "";
  outQuestions.value = "";
  outLog.value = "";
  lastInterim = "";
  lastInterimChangeAt = 0;
  lastUpdateAt = 0;
  if (commitTimer) { clearTimeout(commitTimer); commitTimer = null; }
  log("Cleared.");
}

btnClear.addEventListener("click", clearAll);

// Commit current interim as a phrase if stable & paused
function scheduleCommitCheck() {
  if (commitTimer) clearTimeout(commitTimer);

  commitTimer = setTimeout(() => {
    const now = Date.now();
    const stableFor = now - lastInterimChangeAt;
    const pausedFor = now - lastUpdateAt;

    // Need both: stable + pause
    if (stableFor < STABLE_MS || pausedFor < PAUSE_END_MS) {
      // reschedule until conditions met
      scheduleCommitCheck();
      return;
    }

    const phrase = lastInterim.trim();
    if (!phrase || isFillerOnly(phrase)) {
      log(`COMMIT skipped (empty/filler). stableFor=${stableFor} pausedFor=${pausedFor}`);
      lastInterim = "";
      return;
    }

    // classify
    const { score, reasons } = questionScore(phrase);
    const isQuestion = score >= QUESTION_THRESHOLD;

    log(`COMMIT: "${phrase}"`);
    log(`CLASSIFY: ${isQuestion ? "QUESTION" : "NOT"} score=${score} reasons=[${reasons.join(", ")}]`);

    // punctuation + outputs
    appendPunctSentence(phrase, isQuestion);
    if (isQuestion) appendQuestion(phrase);

    // reset interim buffer
    lastInterim = "";
  }, 120); // short periodic check
}

function ensureSpeechRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    setStatus("SpeechRecognition не поддерживается в этом браузере. Открой в Chrome/Edge.");
    log("No SpeechRecognition support.");
    return null;
  }

  const rec = new SR();
  rec.lang = "uk-UA";         // будет ловить UA, RU часто тоже распознаётся
  rec.interimResults = true;
  rec.continuous = true;

  rec.onresult = (event) => {
    lastUpdateAt = Date.now();

    // We rebuild interim as concatenation of current results.
    // SR often gives rolling results; this is OK for our pause+stable commit.
    let interim = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      interim += event.results[i][0].transcript + " ";
    }
    interim = interim.trim();

    if (interim && interim !== lastInterim) {
      lastInterim = interim;
      lastInterimChangeAt = Date.now();
      log(`UPDATE interim="${interim}"`);
    }

    setStatus("Слушаю… диктуй тестовый текст.");
    scheduleCommitCheck();
  };

  rec.onerror = (e) => {
    const err = e?.error || String(e);
    log(`SR ERROR: ${err}`);
    setStatus(`Ошибка распознавания: ${err}. Я попробую продолжить.`);
  };

  rec.onend = () => {
    // Auto-restart while running
    if (running) {
      log("SR ended -> restart");
      try { rec.start(); } catch (_) {}
    } else {
      log("SR ended (stopped)");
    }
  };

  return rec;
}

function start() {
  if (running) return;

  sr = sr || ensureSpeechRecognition();
  if (!sr) return;

  running = true;

  try {
    sr.start();
    setStatus("Микрофон включён. Диктуй текст.");
    log("SR started.");
    btnMic.textContent = "Микрофон: включён";
    btnMic.disabled = true; // дальше автослушание
  } catch (e) {
    log("SR start failed (maybe already started).");
  }
}

btnMic.addEventListener("click", start);

// On load
setStatus("Нажми «Разрешить микрофон» и диктуй тестовый текст (вопросы будут вынесены отдельно).");
log("Ready. Click mic button to start.");
