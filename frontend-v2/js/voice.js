/**
 * voice.js — ported from frontend-xr/voice.js.
 * The recording / audio-unlock / Sarvam + browser-TTS playback logic is kept
 * as-is (it is proven on phones). Only the DOM hooks changed: the UI is now
 * driven through the `VoiceHooks` callbacks, and a Web Audio analyser feeds the
 * live "listening" animation.
 */

let mediaRecorder;
let audioChunks = [];
let isRecording = false;
let currentAudio = null;
let currentUtterance = null;
let recordTimer = null;
let levelRaf = null;
let levelCtx = null;

const audioCache = new Map();
let greetingPlayed = false;

/* UI hooks — set by assistant.js */
const VoiceHooks = {
  onRecordingChange: (recording) => {},
  onLevels: (levels) => {},          // array of 0..1 values while listening
  onVoiceInput: async (blob) => {},  // called with the recorded audio blob
  onPlayBlocked: (msgId) => {},      // autoplay refused -> ask user to tap Repeat
  onSpeaking: (speaking) => {},
  addTag: (msgId, text) => {},
  addNote: (msgId, text) => {},
};

function unlockAudio() {
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (AudioContext) {
    try {
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      osc.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.001);
    } catch (e) {
      console.error(e);
    }
  }
  if ("speechSynthesis" in window) {
    const utterance = new SpeechSynthesisUtterance("");
    utterance.volume = 0;
    speechSynthesis.speak(utterance);
  }
}

function stopAnyAudio() {
  if (currentAudio) {
    currentAudio.pause();
    currentAudio.currentTime = 0;
  }
  if ("speechSynthesis" in window) {
    speechSynthesis.cancel();
  }
  VoiceHooks.onSpeaking(false);
}

async function playAssistantAudio(msgId, text, language, ttsData) {
  stopAnyAudio();
  const isTamil = language === "ta";

  if (!ttsData || ttsData.provider === "browser" || !ttsData.audio_base64) {
    if (!("speechSynthesis" in window)) return;
    const langCode = isTamil ? "ta-IN" : "en-IN";

    let availableVoices = speechSynthesis.getVoices();
    if (availableVoices.length === 0) {
      await new Promise((resolve) => {
        const timeout = setTimeout(resolve, 1000);
        speechSynthesis.onvoiceschanged = () => {
          clearTimeout(timeout);
          resolve();
        };
      });
      availableVoices = speechSynthesis.getVoices();
    }

    const voice = availableVoices.find((v) => v.lang.startsWith(isTamil ? "ta" : "en"));
    if (isTamil && !voice) {
      VoiceHooks.addNote(msgId, "Tamil voice not installed on this phone.");
    }

    audioCache.set(msgId, { type: "browser", text, lang: langCode });
    playCachedBrowser(msgId);
  } else {
    const src = `data:${ttsData.mime};base64,${ttsData.audio_base64}`;
    audioCache.set(msgId, { type: "api", src });
    playCachedApi(msgId);
  }
}

function playCachedBrowser(msgId) {
  const data = audioCache.get(msgId);
  if (!data) return;

  stopAnyAudio();
  const availableVoices = speechSynthesis.getVoices();
  const voice = availableVoices.find((v) => v.lang.startsWith(data.lang.split("-")[0]));

  currentUtterance = new SpeechSynthesisUtterance(data.text);
  currentUtterance.lang = data.lang;
  currentUtterance.rate = 0.85;
  if (voice) currentUtterance.voice = voice;
  currentUtterance.onstart = () => VoiceHooks.onSpeaking(true);
  currentUtterance.onend = () => VoiceHooks.onSpeaking(false);
  currentUtterance.onerror = () => VoiceHooks.onSpeaking(false);
  speechSynthesis.speak(currentUtterance);
}

function playCachedApi(msgId) {
  const data = audioCache.get(msgId);
  if (!data) return;

  stopAnyAudio();
  currentAudio = new Audio(data.src);
  currentAudio.onplaying = () => VoiceHooks.onSpeaking(true);
  currentAudio.onended = () => VoiceHooks.onSpeaking(false);
  currentAudio.play().catch((e) => {
    console.error("Audio play failed:", e);
    VoiceHooks.onSpeaking(false);
    VoiceHooks.onPlayBlocked(msgId);
  });
}

function replayAudio(msgId) {
  const data = audioCache.get(msgId);
  if (data) {
    if (data.type === "browser") playCachedBrowser(msgId);
    else playCachedApi(msgId);
    return true;
  }
  return false;
}

/* Live input level for the listening animation (visual only). */
function startLevelMeter(stream) {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    levelCtx = new AC();
    const src = levelCtx.createMediaStreamSource(stream);
    const analyser = levelCtx.createAnalyser();
    analyser.fftSize = 64;
    src.connect(analyser);
    const buf = new Uint8Array(analyser.frequencyBinCount);
    const tick = () => {
      analyser.getByteFrequencyData(buf);
      const bars = 9, out = [];
      for (let i = 0; i < bars; i++) out.push(buf[2 + i * 2] / 255);
      VoiceHooks.onLevels(out);
      levelRaf = requestAnimationFrame(tick);
    };
    tick();
  } catch (e) {
    console.warn("Level meter unavailable", e);
  }
}
function stopLevelMeter() {
  cancelAnimationFrame(levelRaf);
  if (levelCtx) { try { levelCtx.close(); } catch (e) {} levelCtx = null; }
}

async function startRecording() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorder = new MediaRecorder(stream);
    audioChunks = [];

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) audioChunks.push(e.data);
    };

    mediaRecorder.onstop = async () => {
      const audioBlob = new Blob(audioChunks, { type: "audio/webm" });
      stream.getTracks().forEach((t) => t.stop());
      stopLevelMeter();
      await VoiceHooks.onVoiceInput(audioBlob);
    };

    mediaRecorder.start();
    isRecording = true;
    VoiceHooks.onRecordingChange(true);
    startLevelMeter(stream);

    clearTimeout(recordTimer);
    recordTimer = setTimeout(() => {
      if (isRecording) stopRecording();
    }, 15000);
  } catch (e) {
    console.error("Mic error:", e);
    toast("Microphone permission denied or not available. You can type your question instead.", 4500);
  }
}

function stopRecording() {
  clearTimeout(recordTimer);
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
  }
  isRecording = false;
  VoiceHooks.onRecordingChange(false);
}

function toggleRecording() {
  if (isRecording) {
    stopRecording();
    unlockAudio();
  } else {
    stopAnyAudio();
    startRecording();
  }
}

/* Speak any text through the backend TTS (Sarvam) with browser fallback. */
async function speakText(msgId, text, language) {
  let ttsData = { provider: "browser" };
  try {
    ttsData = await api("/voice/tts", { method: "POST", json: { text, language }, timeout: 45000 });
  } catch (e) {
    console.warn("TTS failed, using phone voice", e);
  }
  await playAssistantAudio(msgId, text, language, ttsData);
  return ttsData.provider === "browser" || !ttsData.audio_base64 ? "Phone voice" : "Sarvam";
}

async function playGreeting(msgId, greetingText) {
  if (greetingPlayed) return;
  greetingPlayed = true;
  try {
    const provider = await speakText(msgId, greetingText, "en");
    VoiceHooks.addTag(msgId, `🔊 ${provider}`);
  } catch (e) {
    console.error("Greeting TTS error:", e);
  }
}
