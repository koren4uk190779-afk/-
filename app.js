/* =========================================================
   Exam / Meeting Assistant — full rewrite (single file)
   KEY:
   - No "Внимание, вопрос" marker required
   - Detect questions from plain transcript using scoring (RU/UA)
   - Stabilization buffer to avoid "words disappear / rewrite"
   - Auto listening (no start/stop), auto-restart on silence

   Works with your existing index.html / style.css from previous full package.
========================================================= */

const ui = {
  statusLine: document.getElementById("statusLine"),
  stableText: document.getElementById("stableText"),
  detectedQuestion: document.getElementById("detectedQuestion"),
  finalAnswer: document.getElementById("finalAnswer"),
  logBox: document.getElementById("logBox"),
  listenState: document.getElementById("listenState"),
  modeState: document.getElementById("modeState"),
  btnExam: document.getElementById("btnExam"),
  btnMeeting: document.getElementById("btnMeeting"),
  btnChat: document.getElementById("btnChat"),
};

function setText(el, text) {
  el.textContent = (text === undefined || text === null || text === "") ? "—" : String(text);
}
function log(msg, level = "info") {
  const ts = new Date().toLocaleTimeString();
  const line = `[${ts}] ${level.toUpperCase()}: ${msg}\n`;
  ui.logBox.textContent = line + ui.logBox.textContent;
}
function setActiveButton(mode) {
  ui.btnExam.classList.toggle("active", mode === MODE.EXAM);
  ui.btnMeeting.classList.toggle("active", mode === MODE.MEETING);
  ui.btnChat.classList.toggle("active", mode === MODE.CHAT);
}

/* =========================
   MODES
========================= */
const MODE = { EXAM: "exam", MEETING: "meeting", CHAT: "chat" };
let currentMode = MODE.EXAM;

function setMode(mode) {
  currentMode = mode;
  setActiveButton(mode);
  setText(ui.modeState, mode);
  setText(ui.detectedQuestion, "—");
  setText(ui.finalAnswer, "—");

  ui.statusLine.textContent =
    mode === MODE.EXAM
      ? "Режим Екзамен: ловимо питання з потоку → відповідаємо з бази."
      : mode === MODE.MEETING
        ? "Режим Совещание: фіксуємо факти + підказки (далі розширимо)."
        : "Режим Чат: відображаємо останній змістовний фрагмент.";

  ensureListening();
  log(`Switched mode to: ${mode}`);
}

/* =========================
   SETTINGS: stabilization & silence
========================= */
const STABLE_MS = 900;          // text must not change for this time
const SILENCE_COMMIT_MS = 1200; // after stable, wait pause to analyze
const LONG_IDLE_MS = 60_000;

/* =========================
   LOCAL DB (EXAM) - demo
========================= */
const questionsDB = [
  {
    id: "customs_value_field",
    keywords: ["митна", "вартість", "граф", "декларац", "митн"],
    answer:
      "Митна вартість заявляється декларантом у відповідній графі митної декларації відповідно до Митного кодексу України.",
  },
  {
    id: "declarant_def",
    keywords: ["декларант", "хто", "особа", "пода", "декларац"],
    answer:
      "Декларант — особа, яка подає митну декларацію (самостійно або через представника) та відповідає за достовірність відомостей.",
  },
];

/* =========================
   NORMALIZATION + FILLERS
========================= */
const STOP_WORDS = new Set([
  "ага","угу","да","так","ну","добре","алло","ок",
  "зрозуміло","понял","поняла","чекаємо","на зв'язку",
  "слухай","слышь","тест","тести","перевіряю","проверял","связь",
  "нормально","понятно","добре добре","так так"
]);

function normalizeText(s) {
  return (s || "")
    .toLowerCase()
    .replace(/[“”«»"]/g, "")
    .replace(/[.,!;:]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function normalizeLine(s) {
  return (s || "").replace(/\s+/g, " ").trim();
}
function isMostlyFiller(line) {
  const t = normalizeText(line);
  if (!t) return true;
  if (t.length <= 2) return true;
  if (STOP_WORDS.has(t)) return true;

  const parts = t.split(" ").filter(Boolean);
  if (parts.length <= 3 && parts.every(w => STOP_WORDS.has(w))) return true;

  return false;
}

/* =========================
   SEGMENTATION (meaning chunks)
========================= */
function segmentTranscript(rawText) {
  const lines = (rawText || "")
    .split(/\n+/)
    .map(normalizeLine)
    .filter(l => !isMostlyFiller(l));

  const chunks = [];
  let buffer = "";

  const pushBuffer = () => {
    const b = normalizeLine(buffer);
    if (b && b.length >= 6) chunks.push(b);
    buffer = "";
  };

  for (const line of lines) {
    const l = line.trim();
    const lower = l.toLowerCase();

    const looksLikeNewTurn =
      lower.startsWith("так дивіться") ||
      lower.startsWith("дивіться") ||
      lower.startsWith("смотри") ||
      lower.startsWith("значить") ||
      lower.startsWith("коротше") ||
      lower.startsWith("ну все") ||
      lower.startsWith("добре давайте") ||
      lower.startsWith("алло");

    if (buffer && looksLikeNewTurn) pushBuffer();

    buffer = buffer ? (buffer + " " + l) : l;

    // hard cut if too long
    if (buffer.length > 170) pushBuffer();
  }

  pushBuffer();
  return chunks;
}

/* =========================
   QUESTION DETECTION (SCORING)
   We compute "question-likeness" score from plain text
========================= */
const Q_WORDS_RU = ["что","как","когда","где","куда","зачем","почему","сколько","кто","какой","какая","какие","каково"];
const Q_WORDS_UA = ["що","як","коли","де","куди","навіщо","чому","скільки","хто","який","яка","які"];
const Q_PHRASES = [
  // RU
  "подскажите", "скажите", "можете", "можно", "нужно ли", "правильно ли", "неправильно ли",
  "как правильно", "что значит", "как понять", "какое решение", "что делать",
  // UA
  "підкажіть", "скажіть", "можна", "чи можна", "чи потрібно", "правильно чи", "як правильно",
  "що означає", "як зрозуміти", "яке рішення", "що робити"
];

function countHits(text, arr) {
  let hits = 0;
  for (const a of arr) {
    if (text.includes(a)) hits++;
  }
  return hits;
}

function questionScore(rawChunk) {
  const raw = rawChunk || "";
  const t = normalizeText(raw);

  const reasons = [];
  let score = 0;

  if (!t) return { score: 0, reasons: ["empty"] };

  // direct question mark helps, but transcript often has none
  if (raw.includes("?")) { score += 4; reasons.push("has ?"); }

  // question words
  const ruQ = countHits(` ${t} `, Q_WORDS_RU.map(w => ` ${w} `));
  const uaQ = countHits(` ${t} `, Q_WORDS_UA.map(w => ` ${w} `));
  if (ruQ) { score += Math.min(6, ruQ * 2); reasons.push(`ru_qwords:${ruQ}`); }
  if (uaQ) { score += Math.min(6, uaQ * 2); reasons.push(`ua_qwords:${uaQ}`); }

  // particles “ли/чи”
  if (t.includes(" ли ")) { score += 2; reasons.push("has 'ли'"); }
  if (t.startsWith("чи ") || t.includes(" чи ")) { score += 2; reasons.push("has 'чи'"); }

  // phrases that indicate request / clarification
  const phraseHits = countHits(t, Q_PHRASES);
  if (phraseHits) { score += Math.min(6, phraseHits * 2); reasons.push(`q_phrases:${phraseHits}`); }

  // common "question objects" (helps for everyday questions like queue)
  const OBJ_HINTS = ["очеред", "черг", "скільки", "сколько", "час", "година", "годин", "коли", "когда", "де", "где"];
  const objHits = countHits(t, OBJ_HINTS);
  if (objHits) { score += Math.min(3, objHits); reasons.push(`obj_hints:${objHits}`); }

  // penalize fillers & pure confirmations
  const penal = ["все добре", "добре", "понял", "зрозуміло", "ок", "дякую", "спасибо"];
  if (countHits(t, penal)) { score -= 3; reasons.push("penal:filler"); }

  // length heuristics: too short is often not a real question
  const len = t.length;
  if (len < 8) { score -= 2; reasons.push("too_short"); }
  if (len > 220) { score -= 2; reasons.push("too_long"); }

  return { score: Math.max(0, score), reasons };
}

/* =========================
   PICK BEST QUESTION from recent chunks
   - choose highest score among last N chunks
========================= */
function detectBestQuestion(rawText) {
  const chunks = segmentTranscript(rawText);

  // Consider only last 10 chunks (recent context)
  const tail = chunks.slice(-10);

  let best = null;
  for (let i = 0; i < tail.length; i++) {
    const c = tail[i];
    const q = questionScore(c);

    if (!best || q.score > best.score) {
      best = { chunk: c, score: q.score, reasons: q.reasons };
    }
  }

  // Threshold: if best score too low => "no question"
  // You can tune this number. For your case we start with 4.
  if (!best || best.score < 4) return { chunks, best: null };

  return { chunks, best };
}

/* =========================
   EXAM: answer by DB
========================= */
function scoreKeywords(text, keywords) {
  const t = normalizeText(text);
  let score = 0;
  for (const kw of keywords) {
    const k = normalizeText(kw);
    if (!k) continue;
    if (t.includes(k)) score += 1;
  }
  return score;
}

function findAnswerByDB(questionText) {
  let best = null;
  for (const item of questionsDB) {
    const s = scoreKeywords(questionText, item.keywords);
    if (!best || s > best.score) best = { score: s, item };
  }
  if (!best || best.score < 2) return null;
  return best.item.answer;
}

function pipelineExam(rawText) {
  const { chunks, best } = detectBestQuestion(rawText);
  const lastChunk = chunks.length ? chunks[chunks.length - 1] : "";

  setText(ui.stableText, lastChunk || "—");

  if (!best) {
    setText(ui.detectedQuestion, "—");
    // show debug: top candidates
    const tail = chunks.slice(-5);
    const scored = tail.map(c => ({ c, ...questionScore(c) }))
      .sort((a,b) => b.score - a.score)
      .slice(0, 3);

    log(
      "No question detected. Top candidates: " +
      scored.map(s => `{${s.score}} "${s.c}" [${s.reasons.join(",")}]`).join(" | "),
      "warn"
    );

    return {
      ok: false,
      type: "no_question",
      answer: "Я не бачу чіткого питання в тексті. Скажи питання одним реченням (без «да-да/алло»), і зроби паузу 1 секунду.",
    };
  }

  setText(ui.detectedQuestion, best.chunk);
  log(`Question detected (score=${best.score}): "${best.chunk}" reasons=[${best.reasons.join(", ")}]`);

  const ans = findAnswerByDB(best.chunk);
  if (!ans) {
    return {
      ok: false,
      type: "not_found",
      question: best.chunk,
      answer: "Питання розпізнано, але відповіді в базі поки немає.",
    };
  }

  return { ok: true, type: "answer", question: best.chunk, answer: ans };
}

/* =========================
   MEETING / CHAT (simple for now)
========================= */
function pipelineMeeting(rawText) {
  const chunks = segmentTranscript(rawText);
  const lastChunk = chunks.length ? chunks[chunks.length - 1] : "";
  setText(ui.stableText, lastChunk || "—");
  setText(ui.detectedQuestion, "—");
  return { ok: true, type: "meeting", answer: "Совещание: базовый режим. Дальше добавим подсказки/манипуляции по твоему чек-листу." };
}

function pipelineChat(rawText) {
  const chunks = segmentTranscript(rawText);
  const lastChunk = chunks.length ? chunks[chunks.length - 1] : "";
  setText(ui.stableText, lastChunk || "—");
  setText(ui.detectedQuestion, "—");
  return { ok: true, type: "chat", answer: lastChunk ? `Почув: ${lastChunk}` : "Слухаю." };
}

function processTranscript(mode, rawText) {
  if (mode === MODE.EXAM) return pipelineExam(rawText);
  if (mode === MODE.MEETING) return pipelineMeeting(rawText);
  return pipelineChat(rawText);
}

/* =========================
   STABILIZER (fix “rewriting transcript”)
========================= */
let lastRaw = "";
let stableTimer = null;
let silenceTimer = null;
let lastActivityAt = Date.now();

function onTranscriptUpdate(newRawText) {
  lastActivityAt = Date.now();

  if (newRawText !== lastRaw) {
    lastRaw = newRawText;

    if (stableTimer) clearTimeout(stableTimer);
    stableTimer = setTimeout(() => {
      if (silenceTimer) clearTimeout(silenceTimer);
      silenceTimer = setTimeout(() => {
        const result = processTranscript(currentMode, lastRaw);
        setText(ui.finalAnswer, result?.answer || "—");
        ui.statusLine.textContent = "Слухаю… (аналіз виконано)";
        log(`Analyzed (${currentMode}). Result: ${result?.type || "?"}`);
      }, SILENCE_COMMIT_MS);
    }, STABLE_MS);
  }
}

// long idle: do not stop
setInterval(() => {
  const idle = Date.now() - lastActivityAt;
  if (idle > LONG_IDLE_MS) {
    ui.statusLine.textContent = "Пауза (тиша). Я все ще слухаю.";
    lastActivityAt = Date.now();
  }
}, 2500);

/* =========================
   SPEECH RECOGNITION (auto-start/restart)
========================= */
let recognition = null;
let listeningWanted = true;

function ensureListening() {
  ui.listenState.textContent = "ON";

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    ui.listenState.textContent = "NO (browser)";
    ui.statusLine.textContent = "SpeechRecognition не підтримується. Потрібен Chrome/Edge.";
    log("SpeechRecognition not supported.", "warn");
    return;
  }

  if (!recognition) {
    recognition = new SR();
    // You speak RU/UA; uk-UA is ok, transcript still contains RU words often.
    recognition.lang = "uk-UA";
    recognition.interimResults = true;
    recognition.continuous = true;

    recognition.onresult = (event) => {
      let full = "";
      for (let i = 0; i < event.results.length; i++) {
        full += event.results[i][0].transcript + "\n";
      }
      onTranscriptUpdate(full);
      ui.statusLine.textContent = "Слухаю… (йде транскрипція)";
    };

    recognition.onerror = (e) => {
      const err = e?.error || String(e);
      ui.statusLine.textContent = `SR помилка: ${err} (перезапуск…)`;
      log(`SR error: ${err}`, "warn");
    };

    recognition.onend = () => {
      if (listeningWanted) {
        ui.statusLine.textContent = "Перезапуск слухання…";
        try { recognition.start(); } catch (_) {}
      }
    };
  }

  try {
    recognition.start();
    ui.statusLine.textContent = "Слухання активне.";
    log("Listening ensured.");
  } catch (_) {
    // start can throw if called twice quickly
  }
}

/* =========================
   WIRE UI + BOOT
========================= */
ui.btnExam.addEventListener("click", () => setMode(MODE.EXAM));
ui.btnMeeting.addEventListener("click", () => setMode(MODE.MEETING));
ui.btnChat.addEventListener("click", () => setMode(MODE.CHAT));

setActiveButton(currentMode);
setText(ui.modeState, currentMode);
setText(ui.listenState, "—");
setText(ui.stableText, "—");
setText(ui.detectedQuestion, "—");
setText(ui.finalAnswer, "—");
ui.statusLine.textContent = "Запуск… дозволь мікрофон у браузері (якщо попросить).";

ensureListening();
log("App booted.");
