/* assistant.js — chat UI on top of voice.js. Same flow as frontend-xr/app.js:
   voice -> /voice/transcribe (language auto-detected by the backend)
   text  -> Tamil detected by script range /[஀-௿]/
   -> /assistant -> /voice/tts (Sarvam, browser fallback). */

window.AssistantUI = (() => {
  const $ = (id) => document.getElementById(id);
  const GREETING = "Vanakkam! I'm NalamNet. How can I help you today?";
  const GREETING_ID = "greeting-0";
  let greeted = false;
  let busy = false;

  function scrollDown() {
    const sc = $("chat-scroll");
    requestAnimationFrame(() => sc.scrollTo({ top: sc.scrollHeight, behavior: "smooth" }));
  }

  function formatText(t) {
    return escHtml(t || "").replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/\n/g, "<br>");
  }

  function appendMessage(sender, html, msgId, { lang } = {}) {
    const el = document.createElement("div");
    el.className = `msg ${sender}${lang === "ta" ? " ta" : ""}`;
    if (msgId) el.id = msgId;
    const textEl = document.createElement("div");
    textEl.className = "msg-text";
    textEl.innerHTML = html;
    el.appendChild(textEl);

    if (sender === "ai") {
      const controls = document.createElement("div");
      controls.className = "msg-controls";
      controls.hidden = true;
      const repeat = document.createElement("button");
      repeat.className = "repeat";
      repeat.innerHTML = "🔁 Repeat";
      repeat.onclick = () => { unlockAudio(); repeat.classList.remove("hint"); if (!replayAudio(msgId)) toast("No voice for this message yet."); };
      const stop = document.createElement("button");
      stop.innerHTML = "■ Stop";
      stop.onclick = () => stopAnyAudio();
      controls.append(repeat, stop);
      el.appendChild(controls);
    }
    $("chat-log").appendChild(el);
    animateIn(el, { y: 10, duration: 0.35 });
    scrollDown();
    return el;
  }

  function setText(msgId, html, lang) {
    const el = $(msgId);
    if (!el) return;
    el.querySelector(".msg-text").innerHTML = html;
    if (lang) el.classList.toggle("ta", lang === "ta");
    scrollDown();
  }
  function showControls(msgId) { const c = $(msgId)?.querySelector(".msg-controls"); if (c) c.hidden = false; }

  const typing = `<span class="typing"><i></i><i></i><i></i></span>`;

  async function ask(text, lang) {
    const aiId = "ai-" + Date.now();
    appendMessage("ai", typing, aiId);
    busy = true;
    try {
      const data = await api(`/assistant?question=${encodeURIComponent(text)}&language=${lang}`, {
        method: "POST", timeout: 90000,
        onSlow: () => setText(aiId, `${typing} <span style="color:var(--text-2);font-size:15px">Still thinking… the server may be waking up.</span>`),
      });
      // Defensive: the LLM sometimes returns an empty display_text, or speech in
      // the other language. Show whatever text we got and voice it by its script.
      const shown = (data.display_text || "").trim() || (data.speech_text || "").trim() || "Sorry, I couldn't answer that. Please try again.";
      setText(aiId, formatText(shown), isTamilText(shown) ? "ta" : "en");
      showControls(aiId);
      if (data.speech_text) {
        const provider = await speakText(aiId, data.speech_text, isTamilText(data.speech_text) ? "ta" : "en");
        VoiceHooks.addTag(aiId, `🔊 ${provider}`);
      }
    } catch (e) {
      setText(aiId, e.status ? "Sorry, I couldn't answer that. Please try again." : "I can't reach the server right now. Please check your internet and try again.");
    } finally {
      busy = false;
    }
  }

  function sendTyped(textOverride) {
    const input = $("chat-input");
    const text = (textOverride ?? input.value).trim();
    if (!text) return;
    input.value = "";
    unlockAudio();
    stopAnyAudio();
    const lang = isTamilText(text) ? "ta" : "en";
    appendMessage("user", formatText(text), "user-" + Date.now(), { lang });
    ask(text, lang);
  }

  async function onVoiceInput(blob) {
    const tempId = "user-" + Date.now();
    appendMessage("user", `🎙️ ${typing}`, tempId);
    const fd = new FormData();
    fd.append("file", blob, "audio.webm");
    try {
      const stt = await api("/voice/transcribe", { method: "POST", body: fd, timeout: 60000 });
      if (!stt.text) {
        setText(tempId, "🎙️ I couldn't hear that clearly. Please try again.");
        return;
      }
      const lang = stt.language === "ta" || isTamilText(stt.text) ? "ta" : "en";
      setText(tempId, formatText(stt.text), lang);
      await ask(stt.text, lang);
    } catch (e) {
      setText(tempId, "❌ Voice error. Please try again or type your question.");
    }
  }

  function init() {
    Object.assign(VoiceHooks, {
      onRecordingChange: (rec) => {
        $("mic-btn").classList.toggle("listening", rec);
        $("mic-btn").setAttribute("aria-label", rec ? "Stop listening" : "Speak");
        $("listening").hidden = !rec;
        $("chat-suggest").hidden = rec;
        if (rec) animateIn($("listening"), { y: 8, duration: 0.3 });
      },
      onLevels: (levels) => {
        const bars = $("wave").children;
        for (let i = 0; i < bars.length; i++) bars[i].style.height = `${6 + Math.min(1, levels[i] * 1.4) * 30}px`;
      },
      onVoiceInput,
      onPlayBlocked: (msgId) => {
        const b = $(msgId)?.querySelector(".repeat");
        if (b) { b.classList.add("hint"); b.innerHTML = "🔊 Tap to listen"; }
      },
      addTag: (msgId, text) => {
        const el = $(msgId); if (!el) return;
        const tag = document.createElement("div"); tag.className = "msg-tag"; tag.textContent = text; el.appendChild(tag);
      },
      addNote: (msgId, text) => {
        const el = $(msgId); if (!el) return;
        const n = document.createElement("div"); n.className = "msg-note"; n.textContent = text; el.appendChild(n);
      },
    });

    $("mic-btn").onclick = () => {
      if (!navigator.mediaDevices || !window.MediaRecorder) { toast("Voice input isn't supported in this browser. Please type instead."); return; }
      toggleRecording();
    };
    $("chat-send").onclick = () => sendTyped();
    $("chat-input").addEventListener("keydown", (e) => { if (e.key === "Enter") sendTyped(); });
    document.querySelectorAll("#chat-suggest .chip-btn").forEach((b) => (b.onclick = () => sendTyped(b.dataset.q)));
  }

  function onShow(opts = {}) {
    if (!greeted) {
      greeted = true;
      appendMessage("ai", formatText(GREETING), GREETING_ID);
      showControls(GREETING_ID);
      playGreeting(GREETING_ID, GREETING);
      staggerIn(document.querySelectorAll("#chat-suggest .chip-btn"), { stagger: 0.06, delay: 0.3 });
    }
    if (opts.ask) sendTyped(opts.ask);
  }

  function onHide() {
    if (isRecording) stopRecording();
  }

  return { init, onShow, onHide };
})();
