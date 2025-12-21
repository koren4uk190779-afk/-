const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const recognition = new SpeechRecognition();

recognition.lang = 'uk-UA';
recognition.continuous = true;
recognition.interimResults = true;

const transcriptDiv = document.getElementById('transcript');
const detectedDiv = document.getElementById('detected');

let fullText = '';

recognition.onresult = (event) => {
  let last = event.results[event.results.length - 1];
  let text = last[0].transcript.trim();
  fullText += ' ' + text;
  transcriptDiv.textContent = fullText;

  detectQuestion(text);
};

function detectQuestion(text) {
  const triggers = [
    'чим регламентується',
    'на підставі чого',
    'якою статтею',
    'хто має право',
    'яка відповідальність',
    'у який строк'
  ];

  for (let t of triggers) {
    if (text.toLowerCase().includes(t)) {
      detectedDiv.textContent = '❗ Виявлено питання: ' + t;
      break;
    }
  }
}

document.getElementById('startBtn').onclick = () => recognition.start();
document.getElementById('stopBtn').onclick = () => recognition.stop();
