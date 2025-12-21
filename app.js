/* =========================================================
   Exam / Meeting Assistant — full rewrite (single file)
   - No start/stop button: listening auto-starts and auto-restarts
   - Stabilization buffer: analyze only stable text after pause
   - Modes: Exam / Meeting / Chat
   - Exam: detect questions + answer from local DB
   - Meeting: extract facts + realtime coaching (pressure/ignore/manipulation markers)
========================================================= */

/* =========================
   0) UI HELPERS
========================= */
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
   1) MODES
========================= */
const MODE = { EXAM: "exam", MEETING: "meeting", CHAT: "chat" };
let currentMode = MODE.EXAM;

function setMode(mode) {
  currentMode = mode;
  setActiveButton(mode);
  setText(ui.modeState, mode);
  setText(ui.detectedQuestion, "—");
  setText(ui.finalAnswer, "—");

  // Switch recognition language hint (UA as default)
  if (recognition) {
    // Keep uk-UA baseline; can be extended later
    recognition.lang = "uk-UA";
  }

  ui.statusLine.textContent = mode === MODE.EXAM
    ? "Режим Екзамен: ловимо питання → відповідаємо з бази."
    : mode === MODE.MEETING
      ? "Режим Совещание: фіксуємо факти + підказки реагування."
      : "Режим Чат: показуємо останній змістовний фрагмент.";

  ensureListening(); // auto-listen always
  log(`Switched mode to: ${mode}`);
}

/* =========================
   2) SETTINGS: STABILIZATION & SILENCE
========================= */
// Text must not change for STABLE_MS => considered stable
const STABLE_MS = 900;

// After stable, wait SILENCE_COMMIT_MS to "commit" chunk and analyze
const SILENCE_COMMIT_MS = 1400;

// Long idle: we don't stop, just show state
const LONG_IDLE_MS = 60_000;

/* =========================
   3) LOCAL DB (EXAM)
   - Add your real questions here later
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
   4) TEXT NORMALIZATION + FILLERS + QUESTION DETECTION
========================= */
const STOP_WORDS = new Set([
  "ага","угу","да","так","ну","добре","алло","ок",
  "зрозуміло","понял","поняла","чекаємо","на зв'язку",
  "слухай","слышь","тест","тести","перевіряю","проверял","связь",
  "нормально","понятно","добре добре","так так"
]);

const QUESTION_STARTERS = [
  "що","як","коли","де","скільки","чому","навіщо","хто","який","яка","які",
  "почему","как","когда","где","сколько","зачем","кто","какой","какая","какие"
];

const QUESTION_HINTS = [
  "підкажіть","скажіть","можна","чи","чи є","чи буде","чи можна",
  "скажите","подскажите","можно ли","правильно ли"
];

function normalizeText(s) {
  return (s || "")
    .toLowerCase()
    .replace(/[“”«»"]/g, "")
    .replace(/[.,!]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeLine(s) {
  return (s || "")
    .replace(/\s+/g, " ")
    .trim();
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

function looksLikeQuestion(text) {
  const t = normalizeText(text);
  if (!t) return false;
  if (text.includes("?")) return true;

  if (QUESTION_STARTERS.some(w => t.startsWith(w + " "))) return true;
  if (QUESTION_STARTERS.some(w => t.includes(" " + w + " "))) return true;
  if (QUESTION_HINTS.some(h => t.includes(h))) return true;
  if (t.startsWith("чи ")) return true;

  return false;
}

/* =========================
   5) SEGMENTATION (meaning chunks)
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
      lower.startsWith("слухай") ||
      lower.startsWith("слышь");

    if (buffer && looksLikeNewTurn) pushBuffer();

    buffer = buffer ? (buffer + " " + l) : l;

    // hard cut if too long
    if (buffer.length > 170) pushBuffer();
  }

  pushBuffer();
  return chunks;
}

/* =========================
   6) EXAM: Extract questions + DB answer
========================= */
function extractQuestions(rawText) {
  const chunks = segmentTranscript(rawText);
  const questions = [];

  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];

    if (looksLikeQuestion(c)) {
      questions.push({ idx: i, text: c });
      continue;
    }

    // Try merge with previous if it looks split
    if (i > 0) {
      const prev = chunks[i - 1];
      const merged = prev + " " + c;
      if (prev.length < 70 && looksLikeQuestion(merged)) {
        questions.push({ idx: i - 1, text: merged });
      }
    }
  }

  const seen = new Set();
  const uniq = [];
  for (const q of questions) {
    const k = normalizeText(q.text);
    if (!seen.has(k)) {
      seen.add(k);
      uniq.push(q);
    }
  }
  return { chunks, questions: uniq };
}

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

  // threshold
  if (!best || best.score < 2) return null;
  return best.item.answer;
}

function pipelineExam(rawText) {
  const { chunks, questions } = extractQuestions(rawText);
  const lastChunk = chunks.length ? chunks[chunks.length - 1] : "";
  const lastQuestion = questions.length ? questions[questions.length - 1].text : null;

  setText(ui.stableText, lastChunk || "—");
  setText(ui.detectedQuestion, lastQuestion || "—");

  if (!lastQuestion) {
    return { ok: false, type: "no_question", answer: "Я не почув(ла) питання. Сформулюй ще раз коротко." };
  }

  const ans = findAnswerByDB(lastQuestion);
  if (!ans) {
    return {
      ok: false,
      type: "not_found",
      question: lastQuestion,
      answer: "Питання розпізнано, але відповіді в базі поки немає.",
    };
  }

  return { ok: true, type: "answer", question: lastQuestion, answer: ans };
}

/* =========================
   7) MEETING: facts extraction + coaching patterns
========================= */
function extractMeetingFacts(rawText) {
  const chunks = segmentTranscript(rawText);
  const tAll = chunks.join(" ");

  const patterns = [
    { re: /(\d+)\s*(машин|машини|авто|тз)/gi, label: "Кількість ТЗ" },
    { re: /(черг[аеи].{0,20}(відсутн|нема))/gi, label: "Черга" },
    { re: /(\d+)\s*(хв|хвилин|годин|година|год)/gi, label: "Час" },
    { re: /(порядок|чистенько|все добре|добре)/gi, label: "Стан" },
  ];

  const facts = [];
  for (const p of patterns) {
    let m;
    while ((m = p.re.exec(tAll)) !== null) {
      facts.push({ type: p.label, value: m[0] });
    }
  }

  const uniq = [];
  const seen = new Set();
  for (const f of facts) {
    const k = (f.type + "|" + f.value).toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      uniq.push(f);
    }
  }

  return { chunks, facts: uniq };
}

const COACH_PATTERNS = [
  { tag: "Тиск/поспіх", re: /(терміново|зараз же|негайно|останнє попередження|або інакше)/i,
    tip: "Не приймай рішення в поспіху. Уточни вимогу та критерії: що саме, до якого часу, хто відповідальний." },

  { tag: "Знецінення", re: /(ти нічого не розумієш|це дурниці|ти завжди|ти ніколи)/i,
    tip: "Поверни розмову в факти: 'Давайте конкретно: що саме не влаштовує і які приклади?'" },

  { tag: "Ігнор/уникнення", re: /(неважливо|потім|не зараз|я зайнятий|без подробиць)/i,
    tip: "Зафіксуй питання і попроси строк відповіді: 'Коли повертаємось до цього пункту?'" },

  { tag: "Маніпуляція провиною", re: /(через тебе|ти винен|ти підвів|ти зіпсував)/i,
    tip: "Попроси конкретику: які дії/рішення призвели до наслідку, що треба змінити зараз." },

  { tag: "Підміна теми", re: /(до речі|взагалі|не про це|давай інше)/i,
    tip: "Коротко повернись до пункту: 'Закриємо попереднє питання, потім перейдемо далі'." },
];

function meetingCoachAnalyze(text) {
  const clean = normalizeText(text);
  const hits = [];

  for (const p of COACH_PATTERNS) {
    if (p.re.test(clean)) hits.push({ tag: p.tag, tip: p.tip });
  }

  const uniq = [];
  const seen = new Set();
  for (const h of hits) {
    if (!seen.has(h.tag)) {
      seen.add(h.tag);
      uniq.push(h);
    }
  }
  return uniq;
}

function pipelineMeeting(rawText) {
  const { chunks, facts } = extractMeetingFacts(rawText);
  const lastChunk = chunks.length ? chunks[chunks.length - 1] : "";

  setText(ui.stableText, lastChunk || "—");
  setText(ui.detectedQuestion, "—");

  const coach = lastChunk ? meetingCoachAnalyze(lastChunk) : [];

  const summaryFacts =
    facts.length ? facts.map(f => `${f.type}: ${f.value}`).join(" | ") : "Фактів/цифр поки не бачу.";

  const coachTips =
    coach.length ? coach.map(c => `• ${c.tag}: ${c.tip}`).join("\n") : "";

  return {
    ok: true,
    type: "meeting",
    answer:
      `Фіксація: ${summaryFacts}` + (coachTips ? `\n\nПідказки:\n${coachTips}` : ""),
  };
}

/* =========================
   8) CHAT (simple)
========================= */
function pipelineChat(rawText) {
  const chunks = segmentTranscript(rawText);
  const lastChunk = chunks.length ? chunks[chunks.length - 1] : "";

  setText(ui.stableText, lastChunk || "—");
  setText(ui.detectedQuestion, "—");

  return { ok: true, type: "chat", answer: lastChunk ? `Почув: ${lastChunk}` : "Слухаю." };
}

/* =========================
   9) PROCESSOR
========================= */
function processTranscript(mode, rawText) {
  if (mode === MODE.EXAM) return pipelineExam(rawText);
  if (mode === MODE.MEETING) return pipelineMeeting(rawText);
  return pipelineChat(rawText);
}

/* =========================
   10) STABILIZER (fix “words disappear / rewrite”)
========================= */
let lastRaw = "";
let lastChangeAt = 0;
let stableTimer = null;
let silenceTimer = null;
let lastActivityAt = Date.now();

function onTranscriptUpdate(newRawText) {
  lastActivityAt = Date.now();
  const now = Date.now();

  if (newRawText !== lastRaw) {
    lastRaw = newRawText;
    lastChangeAt = now;

    // wait until stable
    if (stableTimer) clearTimeout(stableTimer);
    stableTimer = setTimeout(() => {
      // stable reached
      if (silenceTimer) clearTimeout(silenceTimer);
      silenceTimer = setTimeout(() => {
        const result = processTranscript(currentMode, lastRaw);
        setText(ui.finalAnswer, result?.answer || "—");
        ui.statusLine.textContent = `Слухаю… (стабільно, аналіз виконано)`;
        log(`Analyzed (${currentMode}). Result type: ${result?.type || "?"}`);
      }, SILENCE_COMMIT_MS);
    }, STABLE_MS);
  } else {
    // same text: nothing
  }
}

// Long idle: do NOT stop anything
setInterval(() => {
  const idle = Date.now() - lastActivityAt;
  if (idle > LONG_IDLE_MS) {
    ui.statusLine.textContent = "Пауза (тиша). Я все ще слухаю.";
    // don't spam
    lastActivityAt = Date.now();
  }
}, 2500);

/* =========================
   11) SPEECH RECOGNITION (auto-start, auto-restart)
========================= */
let recognition = null;
let listeningWanted = true;

function ensureListening() {
  ui.listenState.textContent = "ON";

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    ui.listenState.textContent = "NO (browser)";
    ui.statusLine.textContent = "Браузер не підтримує SpeechRecognition. Потрібен Chrome/Edge.";
    log("SpeechRecognition not supported by this browser.", "warn");
    return;
  }

  if (!recognition) {
    recognition = new SR();
    recognition.lang = "uk-UA";
    recognition.interimResults = true; // gives “rewriting” — we handle by stabilizer
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
      // Do not stop on no-speech / silence
      const err = e?.error || String(e);
      ui.statusLine.textContent = `SR помилка: ${err} (перезапуск…)`;
      log(`SR error: ${err}`, "warn");
    };

    recognition.onend = () => {
      // Browser may stop on silence; we restart
      if (listeningWanted) {
        ui.statusLine.textContent = "Перезапуск слухання…";
        try { recognition.start(); } catch (_) {}
      }
    };
  }

  try {
    recognition.start();
    ui.statusLine.textContent = "Слухання активне.";
    log("Listening started/ensured.");
  } catch (e) {
    // start can throw if called twice quickly
  }
}

/* =========================
   12) WIRE UI + BOOT
========================= */
ui.btnExam.addEventListener("click", () => setMode(MODE.EXAM));
ui.btnMeeting.addEventListener("click", () => setMode(MODE.MEETING));
ui.btnChat.addEventListener("click", () => setMode(MODE.CHAT));

// Boot
setActiveButton(currentMode);
setText(ui.modeState, currentMode);
setText(ui.listenState, "—");
setText(ui.stableText, "—");
setText(ui.detectedQuestion, "—");
setText(ui.finalAnswer, "—");
ui.statusLine.textContent = "Запуск… дозволь мікрофон у браузері (якщо попросить).";

ensureListening();
log("App booted.");
