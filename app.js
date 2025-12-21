const btnStart = document.getElementById("btnStart");
const btnStop  = document.getElementById("btnStop");
const btnClear = document.getElementById("btnClear");
const btnCopy  = document.getElementById("btnCopy");
const out      = document.getElementById("out");
const statusEl = document.getElementById("status");

function setStatus(text) {
  statusEl.textContent = text;
}

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

let rec = null;
let isRunning = false;

function ensureRecognition() {
  if (!SpeechRecognition) return null;

  const r = new SpeechRecognition();
  r.lang = "uk-UA";          // украинский
  r.continuous = true;       // пытаться слушать непрерывно
  r.interimResults = true;   // промежуточный текст

  let finalText = "";

  r.onstart = () => setStatus("Слухаю…");
  r.onend = () => {
    isRunning = false;
    btnStart.disabled = false;
    btnStop.disabled = true;
    setStatus("Зупинено");
  };

  r.onerror = (e) => {
    setStatus("Помилка: " + (e.error || "невідома"));
  };

  r.onresult = (event) => {
    let interim = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const res = event.results[i];
      const text = res[0].transcript;
      if (res.isFinal) finalText += text + " ";
      else interim += text;
    }
    out.value = (finalText + interim).trim();
  };

  return r;
}

btnStart.addEventListener("click", () => {
  if (!SpeechRecognition) {
    alert("У цьому браузері немає SpeechRecognition. Спробуй інший браузер або інший пристрій.");
    return;
  }
  if (isRunning) return;

  rec = ensureRecognition();
  try {
    isRunning = true;
    btnStart.disabled = true;
    btnStop.disabled = false;
    rec.start();
  } catch (e) {
    setStatus("Не вдалося запустити");
    btnStart.disabled = false;
    btnStop.disabled = true;
    isRunning = false;
  }
});

btnStop.addEventListener("click", () => {
  if (rec && isRunning) rec.stop();
});

btnClear.addEventListener("click", () => {
  out.value = "";
  setStatus("Очищено");
});

btnCopy.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(out.value);
    setStatus("Скопійовано");
  } catch {
    setStatus("Не можу скопіювати");
  }
});
