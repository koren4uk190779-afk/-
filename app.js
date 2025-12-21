/* =========================================================
   EXPERIMENT: Question Catcher (GitHub Pages friendly)
   Fixes:
   - On click: force mic permission via getUserMedia()
   - Clear visual reaction immediately (status + logs)
   - Show live draft text so user sees it is listening
   - Still commits phrases on pause and adds . or ?
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

const PAUSE_END_MS = 800;
const STABLE_MS = 700;
const QUESTION_THRESHOLD = 2; // ловим больше вопросов на старте

pauseMsEl.textContent = String(PAUSE_END_MS);
stableMsEl.textContent = String(STABLE_MS);
thrEl.textContent = String(QUESTION_THRESHOLD);

function setStatus(s) { elStatus.textContent = s; }
function log(line) {
  const ts = new Date().toLocaleTimeString();
  outLog.value = `[${ts}] ${line}\n` + outLog.value;
}

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

/* ===== Question detection (RU/UA) ===== */
const Q_WORDS_RU = ["что","как","когда","где","куда","зачем","почему","сколько","кто","какой","какая","какие","каково"];
const Q_WORDS_UA_BASE = ["що","як","коли","де","куди","навіщо","чому","скільки","хто","який","яка","які"];
const Q_WORDS_UA_CASES = [
  "якою","якій","яким","якої","яких",
  "котрою","котрій","котрим","котрої","котрих",
  "яким чином","у який спосіб","з якої причини"
];
const Q_PHRASES = [
  "подскажи","скажите","скажи","можете","можно","нужно ли","правильно ли","неправильно ли",
  "как правильно","что значит","как понять","какое решение","что делать","на основании чего",
  "какой статьей","каким пунктом","каким законом",
  "підкажи","підкажіть","скажіть","можна","чи можна","чи потрібно","на підставі чого",
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
  if (raw.includes("?")) { score += 3; reasons.push("has ?"); }

  let ru = 0;
  for (const w of Q_WORDS_RU) if (hitWord(t, w)) ru++;
  if (ru) { score += Math.min(6, ru * 2); reasons.push(`ru_qwords:${ru}`); }

  let ua = 0;
  for (const w of Q_WORDS_UA_BASE) if (hitWord(t, w)) ua++;
  if (ua) { score += Math.min(6, ua * 2); reasons.push(`ua_qwords:${ua}`); }

  let uac = 0;
  for (const w of Q_WORDS_UA_CASES) if (t.includes(w)) uac++;
  if (uac) { score += Math.min(5, uac * 2); reasons.push(`ua_cases:${uac}`); }

  if (t.includes(" ли ")) { score += 2; reasons.push("has 'ли'"); }
  if (t.startsWith("чи ") || t.includes(" чи ")) { score += 2; reasons.push("has 'чи'"); }

  let ph = 0;
  for (const p of Q_PHRASES) if (t.includes(p)) ph++;
  if (ph) { score += Math.min(6, ph * 2); reasons.push(`q_phrases:${ph}`); }

  if (isFillerOnly(t)) { score = 0; reasons.push("filler_only"); }
  if (t.length < 6) { score = Math.max(0, score - 2); reasons.push("too_short"); }

  return { score, reasons };
}

/* ===== Phrase commit logic ===== */
let sr = null;
let running = false;

let lastInterim = "";
let lastInterimChangeAt = 0;
let lastUpdateAt = 0;

let commitTimer = null;

let fullPunctText = "";
let qCount = 0;

function renderDraft() {
  // show punctuated text + live draft so user sees it listens
  const draft = lastInterim ? `\n\n[черновик] ${lastInterim}` : "";
  outText.value = fullPunctText + draft;
}

function appendPunctSentence(sentence, isQuestion) {
  const s = capFirst(sentence.trim());
  if (!s) return;

  const end = isQuestion ? "?" : ".";
  fullPunctText += (fullPunctText ? " " : "") + s + end;
  renderDraft();
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

function scheduleCommitCheck() {
  if (commitTimer) clearTimeout(commitTimer);

  commitTimer = setTimeout(() => {
    const now = Date.now();
    const stableFor = now - lastInterimChangeAt;
    const pausedFor = now - lastUpdateAt;

    // keep re-checking until stable+pause reached
    if (stableFor < STABLE_MS || pausedFor < PAUSE_END_MS) {
      scheduleCommitCheck();
      return;
    }

    const phrase = lastInterim.trim();
    if (!phrase || isFillerOnly(phrase)) {
      log(`COMMIT skipped (empty/filler). stableFor=${stableFor} pausedFor=${pausedFor}`);
      lastInterim = "";
      renderDraft();
      return;
    }

    const { score, reasons } = questionScore(phrase);
    const isQuestion = score >= QUESTION_THRESHOLD;

    log(`COMMIT: "${phrase}"`);
    log(`CLASSIFY: ${isQuestion ? "QUESTION" : "NOT"} score=${score} reasons=[${reasons.join(", ")}]`);

    appendPunctSentence(phrase, isQuestion);
    if (isQuestion) appendQuestion(phrase);

    lastInterim = "";
    renderDraft();
  }, 120);
}

/* ===== Mic permission forcing ===== */
async function forceMicPermission() {
  if (!navigator.mediaDevices?.getUserMedia) {
    log("getUserMedia not available in this browser.");
    return;
  }
  try {
    setStatus("Запрашиваю доступ к микрофону…");
    log("Requesting mic permission via getUserMedia...");
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    // Immediately stop tracks — we only wanted the permission prompt
    stream.getTracks().forEach(t => t.stop());
    log("Mic permission granted (tracks stopped).");
  } catch (e) {
    log("Mic permission denied or failed: " + (e?.message || e));
    setStatus("Доступ к микрофону не получен. Проверь разрешение в браузере (значок 🔒 слева от адреса).");
    throw e;
  }
}

/* ===== SpeechRecognition ===== */
function ensureSpeechRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    setStatus("SpeechRecognition не поддерживается. Открой сайт в Chrome/Edge на ПК.");
    log("No SpeechRecognition support.");
    return null;
  }

  const rec = new SR();
  rec.lang = "uk-UA";
  rec.interimResults = true;
  rec.continuous = true;

  rec.onresult = (event) => {
    lastUpdateAt = Date.now();

    // Build interim from current results batch
    let interim = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      interim += event.results[i][0].transcript + " ";
    }
    interim = interim.trim();

    if (interim && interim !== lastInterim) {
      lastInterim = interim;
      lastInterimChangeAt = Date.now();
      log(`UPDATE interim="${interim}"`);
      renderDraft();
    }

    setStatus("Слушаю… диктуй тестовый текст.");
    scheduleCommitCheck();
  };

  rec.onerror = (e) => {
    const err = e?.error || String(e);
    log(`SR ERROR: ${err}`);
    setStatus(`Ошибка распознавания: ${err}. Попробую продолжить…`);
  };

  rec.onend = () => {
    if (running) {
      log("SR ended -> restart");
      try { rec.start(); } catch (_) {}
    } else {
      log("SR ended (stopped)");
    }
  };

  return rec;
}

async function start() {
  if (running) return;

  // immediate reaction
  btnMic.textContent = "Запускаю…";
  log("Button clicked. Starting…");

  // Force mic permission prompt
  try {
    await forceMicPermission();
  } catch {
    // permission failed; do not continue
    btnMic.textContent = "Разрешить микрофон";
    return;
  }

  sr = sr || ensureSpeechRecognition();
  if (!sr) {
    btnMic.textContent = "Разрешить микрофон";
    return;
  }

  running = true;

  try {
    sr.start();
    setStatus("Микрофон включён. Диктуй текст.");
    log("SR started.");
    btnMic.textContent = "Микрофон: включён";
    btnMic.disabled = true; // эксперимент: всегда слушаем после запуска
  } catch (e) {
    log("SR start failed: " + (e?.message || e));
    setStatus("Не удалось запустить распознавание. Открой Console (F12) и пришли ошибку.");
    btnMic.textContent = "Разрешить микрофон";
    running = false;
  }
}

btnMic.addEventListener("click", start);

setStatus("Нажми «Разрешить микрофон» и диктуй тестовый текст.");
log("Ready. Tip: works only on HTTPS (GitHub Pages) and in Chrome/Edge.");
