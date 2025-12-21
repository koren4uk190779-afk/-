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
  rec.lang = "uk-UA";
  rec.continuous = false;     // стабильнее, перезапускаем сами
  rec.interimResults = true;
  rec.maxAlternatives = 1;

  let listening = false;
  let restartOnEnd = false;

  const MAX_CHARS = 12000; // "хвост" текста
  let finalText = localStorage.getItem("transcript") || "";

  const render = (interim = "") => {
    if (!outEl) return;
    const t = finalText.trim();
    const i = interim.trim();
    outEl.value = (t + (i ? "\n\n⏳ " + i : "")).trim();
  };

  // показать то, что уже сохранено
  render("");

  // ===== Status pulse =====
  const startPulse = () => {
    let dots = 0;
    if (window.__pulse) clearInterval(window.__pulse);
    window.__pulse = setInterval(() => {
      if (!restartOnEnd) return;
      dots = (dots + 1) % 4;
      setStatus("🎙️ Слухаю" + ".".repeat(dots));
    }, 500);
  };

  const stopPulse = () => {
    if (window.__pulse) clearInterval(window.__pulse);
    window.__pulse = null;
  };

  // ===== Start / Stop =====
  const startListening = async () => {
    if (listening) return;

    restartOnEnd = true;

    try {
      // заранее спросить доступ к микрофону (полезно для некоторых браузеров)
      if (navigator.mediaDevices?.getUserMedia) {
        await navigator.mediaDevices.getUserMedia({ audio: true });
      }

      rec.start();
      listening = true;

      setStatus("🎙️ Слухаю…");
      startPulse();

      setDisabled(btnStart, true);
      setDisabled(btnStop, false);
    } catch {
      restartOnEnd = false;
      listening = false;

      setStatus("❌ Немає доступу до мікрофона (дозволь у налаштуваннях браузера).");
      stopPulse();

      setDisabled(btnStart, false);
      setDisabled(btnStop, true);
    }
  };

  const stopListening = () => {
    restartOnEnd = false;

    try { rec.stop(); } catch {}
    listening = false;

    stopPulse();
    setStatus("Готово");

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

        // ограничиваем хвост
        if (finalText.length > MAX_CHARS) {
          finalText = finalText.slice(-MAX_CHARS);
        }

        // сохраняем
        localStorage.setItem("transcript", finalText);
      } else {
        interim += text;
      }
    }

    render(interim);
  };

  rec.onerror = (event) => {
    const code = event.error || "unknown";

    // На ПК лучше игнорировать "тишину"
    if (code === "no-speech") {
      setStatus("🎙️ Слухаю…");
      return;
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
    if (restartOnEnd) {
      try {
        rec.start();
        listening = true;
        setStatus("🎙️ Слухаю…");
      } catch {
        listening = false;
        stopPulse();
        setStatus("⚠️ Зупинилось. Натисни Старт ще раз.");
        setDisabled(btnStart, false);
        setDisabled(btnStop, true);
      }
    } else {
      listening = false;
      stopPulse();
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
    localStorage.removeItem("transcript");
    render("");
    setStatus("Очищено");
    setTimeout(() => setStatus(restartOnEnd ? "🎙️ Слухаю…" : "Готово"), 800);
  });

  btnCopy?.addEventListener("click", async () => {
    const text = outEl?.value ?? "";
    if (!text.trim()) {
      setStatus("Нема що копіювати");
      setTimeout(() => setStatus(restartOnEnd ? "🎙️ Слухаю…" : "Готово"), 800);
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      setStatus("✅ Скопійовано");
    } catch {
      setStatus("⚠️ Не вдалось скопіювати (браузер блокує).");
    }
    setTimeout(() => setStatus(restartOnEnd ? "🎙️ Слухаю…" : "Готово"), 900);
  });
})();
