(() => {
  // ===== Helpers =====
  const $ = (id) => document.getElementById(id);

  const btnStart = $("btnStart");
  const btnStop  = $("btnStop");
  const btnClear = $("btnClear");
  const btnCopy  = $("btnCopy");
  const statusEl = $("status");
  const outEl    = $("out");

  const setStatus = (text) => { if (statusEl) statusEl.textContent = text; };
  const setDisabled = (el, v) => { if (el) el.disabled = v; };

  // ===== UI initial state =====
  setStatus("Готово");
  setDisabled(btnStop, true);

  // ===== SpeechRecognition detection =====
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

  if (!SpeechRecognition) {
    setStatus("❌ Браузер не підтримує розпізнавання. Спробуй Chrome (Android/PC) або Safari (iPhone).");
    setDisabled(btnStart, true);
    setDisabled(btnStop, true);
    return;
  }

  // ===== Create recognizer =====
  const rec = new SpeechRecognition();
  rec.lang = "uk-UA";          // можно поменять на "ru-RU" при желании
  rec.continuous = false;       // держим сессию
  rec.interimResults = true;   // показываем черновик текста
  rec.maxAlternatives = 1;


  let listening = false;
  let finalText = "";
  const MAX_CHARS = 4000; // можно 4000–12000, но лучше начать с 4000
  let restartOnEnd = false;

  const render = (interim = "") => {
    if (!outEl) return;
    const t = finalText.trim();
    const i = interim.trim();
    outEl.value = (t + (i ? "\n\n⏳ " + i : "")).trim();
  };

  const startListening = async () => {
    // Важно: запуск только по клику пользователя
    if (listening) return;

    restartOnEnd = true;
    try {
      // На некоторых браузерах полезно спросить доступ к микрофону заранее:
      if (navigator.mediaDevices?.getUserMedia) {
        await navigator.mediaDevices.getUserMedia({ audio: true });
      }

      rec.start();
      listening = true;

      setStatus("🎙️ Слухаю…");
      let dots = 0;
      window.__pulse && clearInterval(window.__pulse);
      window.__pulse = setInterval(() => {
        if (!restartOnEnd) return;
        dots = (dots + 1) % 4;
        setStatus("🎙️ Слухаю" + ".".repeat(dots));
}, 500);
      setDisabled(btnStart, true);
      setDisabled(btnStop, false);
    } catch (e) {
      setStatus("❌ Немає доступу до мікрофона (дозволь у налаштуваннях браузера).");
      setDisabled(btnStart, false);
      setDisabled(btnStop, true);
    }
  };

  const stopListening = () => {
    restartOnEnd = false;
    if (!listening) return;

    try { rec.stop(); } catch {}
    listening = false;

    setStatus("Готово");
    window.__pulse && clearInterval(window.__pulse);
    window.__pulse = null;
    setDisabled(btnStart, false);
    setDisabled(btnStop, true);
  };

  // ===== Recognition events =====
  rec.onresult = (event) => {
    let interim = "";

    for (let i = event.resultIndex; i < event.results.length; i++) {
      const res = event.results[i];
      const text = res[0]?.transcript ?? "";
      if (res.isFinal) {
        finalText += (finalText ? "\n" : "") + text.trim();
          // держим только последние MAX_CHARS символов
       if (finalText.length > MAX_CHARS) {
  finalText = finalText.slice(-MAX_CHARS);
}
 
      } else {
        interim += text;
      }
    }

    render(interim.trim());
  };

  rec.onerror = (event) => {
    // Частые ошибки: not-allowed, service-not-allowed, no-speech, audio-capture, network
    const code = event.error || "unknown";
    if (code === "no-speech") {
  // просто игнорируем тишину и продолжаем слушать
  setStatus("🎙️ Слухаю…");
  return;
}

    }
    if (code === "not-allowed" || code === "service-not-allowed") {
      setStatus("❌ Доступ до мікрофона заборонено. Дозволь у браузері.");
      stopListening();
      return;
    }
    if (code === "audio-capture") {
      setStatus("❌ Мікрофон не знайдено / зайнятий іншим додатком.");
      stopListening();
      return;
    }
    setStatus("⚠️ Помилка розпізнавання: " + code);
  };

  rec.onend = () => {
    // Если браузер сам завершил — перезапускаем, пока пользователь не нажал "Стоп"
    if (restartOnEnd) {
      try {
        rec.start();
        setStatus("🎙️ Слухаю…");
      } catch {
        // иногда start() может падать, тогда разрешаем старт вручную
        listening = false;
        setStatus("⚠️ Зупинилось. Натисни Старт ще раз.");
        setDisabled(btnStart, false);
        setDisabled(btnStop, true);
      }
    } else {
      listening = false;
      setStatus("Готово");
      setDisabled(btnStart, false);
      setDisabled(btnStop, true);
    }
  };

  // ===== Buttons =====
  btnStart?.addEventListener("click", startListening);
  btnStop?.addEventListener("click", stopListening);

  btnClear?.addEventListener("click", () => {
    finalText = "";
    render("");
    setStatus("Очищено");
    // вернём статус в норму через секунду
    setTimeout(() => setStatus(listening ? "🎙️ Слухаю…" : "Готово"), 800);
  });

  btnCopy?.addEventListener("click", async () => {
    const text = outEl?.value ?? "";
    if (!text.trim()) {
      setStatus("Нема що копіювати");
      setTimeout(() => setStatus(listening ? "🎙️ Слухаю…" : "Готово"), 800);
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      setStatus("✅ Скопійовано");
    } catch {
      setStatus("⚠️ Не вдалось скопіювати (браузер блокує).");
    }
    setTimeout(() => setStatus(listening ? "🎙️ Слухаю…" : "Готово"), 900);
  });
})();
