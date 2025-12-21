// === Контрольные фразы и маркеры для вопросов ===
const Q_PHRASES = [
  // русские фразы
  "подскажи", "скажи", "скажите", "можно", "нужно ли", "правильно ли", "неправильно ли",
  "как правильно", "что значит", "как понять", "какое решение", "что делать", "на основании чего",
  "какой статьей", "каким пунктом", "каким законом", "что если", "почему", "сколько",
  "куда", "когда", "кто", "чем", "который",

  // украинские фразы
  "підкажи", "підкажіть", "скажіть", "можна", "чи можна", "чи потрібно", "на підставі чого",
  "якою статтею", "яким пунктом", "яким законом", "чому", "скільки", "куди", "коли", "хто", "чем",
  "якою", "яка", "які", "яким чином", "яким способом"
];

// Маркеры для распознавания вопросов
const Q_WORDS_RU = ["что", "как", "когда", "где", "куда", "почему", "сколько", "кто", "какой", "который"];
const Q_WORDS_UA = ["що", "як", "коли", "де", "куди", "чому", "скільки", "хто", "який", "якою", "які"];

// === Функция для извлечения вопроса ===
const seenQuestions = new Set();

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

// === Функция для добавления вопроса ===
function appendQuestion(q) {
  const clean = extractQuestionTail(q);
  const key = norm(clean);

  if (!key || seenQuestions.has(key)) {
    log(`QUESTION skipped (duplicate/empty): "${clean}"`);
    return;
  }
  seenQuestions.add(key);

  qCount += 1;
  outQuestions.value += `${qCount}) ${capFirst(clean)}?\n`;
}

// === Обработчик ошибок ===
rec.onerror = (e) => {
  const err = e?.error || String(e);

  if (err === "no-speech") {
    // это просто тишина — не спамим логом
    setStatus("Тишина… жду речь.");
    return;
  }

  log(`SR ERROR: ${err}`);
  setStatus(`Ошибка распознавания: ${err}. Попробую продолжить…`);
};

// === Дополнительные улучшения для более точного распознавания ===
const QUESTION_THRESHOLD = 1;  // Уменьшили порог для более агрессивного распознавания
const Q_WORDS_RU = ["что", "как", "когда", "где", "куда", "почему", "сколько", "кто", "какой", "который"];
const Q_WORDS_UA = ["що", "як", "коли", "де", "куди", "чому", "скільки", "хто", "який", "якою", "які"];

// === Функция для проверки слов в вопросе ===
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
