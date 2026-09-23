// API_BASE is defined in config.js (loaded before this script in index.html).
// It auto-detects local dev vs production Render URL at runtime.

/* ---------- Tab switching ---------- */
const screens = {
  scanner: document.getElementById("scanner-screen"),
  emergency: document.getElementById("emergency-screen"),
  assistant: document.getElementById("assistant-screen"),
};
const tabs = {
  scanner: document.getElementById("tab-scanner"),
  emergency: document.getElementById("tab-emergency"),
  assistant: document.getElementById("tab-assistant"),
};
function showScreen(name) {
  Object.values(screens).forEach((s) => s.classList.remove("active"));
  Object.values(tabs).forEach((t) => t.classList.remove("active"));
  screens[name].classList.add("active");
  tabs[name].classList.add("active");
  
  if (name === "assistant" && typeof playGreeting === "function") {
      playGreeting();
  }
}
tabs.scanner.addEventListener("click", () => showScreen("scanner"));
tabs.emergency.addEventListener("click", () => showScreen("emergency"));
tabs.assistant.addEventListener("click", () => showScreen("assistant"));

/* ---------- Scanner screen: camera capture OR file/PDF upload ---------- */
const captureBtn = document.getElementById("capture-btn");
const uploadBtn = document.getElementById("upload-btn");
const nativeCameraInput = document.getElementById("native-camera-input");
const uploadInput = document.getElementById("upload-input");
const previewImg = document.getElementById("preview-img");
const scanPlaceholder = document.getElementById("scan-placeholder");
const resultCard = document.getElementById("result-card");
const docTypeEl = document.getElementById("doc-type");
const fieldsListEl = document.getElementById("fields-list");
const statusEl = document.getElementById("status");

captureBtn.addEventListener("click", () => nativeCameraInput.click());
uploadBtn.addEventListener("click", () => uploadInput.click());

nativeCameraInput.addEventListener("change", (e) => handleFileSelected(e.target.files[0], nativeCameraInput));
uploadInput.addEventListener("change", (e) => handleFileSelected(e.target.files[0], uploadInput));

function handleFileSelected(file, inputEl) {
  if (!file) return;

  const placeholderText = scanPlaceholder.querySelector("p");
  if (file.type === "application/pdf") {
    previewImg.style.display = "none";
    placeholderText.textContent = `📄 PDF selected: ${file.name}`;
    placeholderText.style.display = "block";
  } else {
    previewImg.src = URL.createObjectURL(file);
    previewImg.style.display = "block";
    placeholderText.style.display = "none";
  }

  scanAndDisplay(file);
  inputEl.value = ""; // reset so the same file can be re-selected later
}

async function scanAndDisplay(file) {
  statusEl.style.display = "block";
  resultCard.classList.remove("visible");
  const formData = new FormData();
  formData.append("file", file, file.name || "scan.jpg");
  try {
    const response = await fetch(`${API_BASE}/scan`, { method: "POST", body: formData });
    if (!response.ok) throw new Error(`Server returned ${response.status}`);
    const data = await response.json();
    renderResult(data);
  } catch (err) {
    alert("Scan failed: " + err.message);
  } finally {
    statusEl.style.display = "none";
  }
}

function renderResult(data) {
  docTypeEl.textContent = `Detected: ${data.object_type.replace(/_/g, " ")}`;
  fieldsListEl.innerHTML = "";

  // Handwritten / low-confidence warning banner
  const existingBanner = document.getElementById("handwritten-banner");
  if (existingBanner) existingBanner.remove();

  const fields = data.fields || {};
  const confidences = data.field_confidence || {};
  const isHandwritten = !!data.handwritten;
  const meds = Array.isArray(fields.medications) ? fields.medications : [];
  const hasLowConfMed = meds.some((m, i) => {
    const nameKey = `medications_${i}_name`;
    const medKey = `medications_${i}`;
    const c = confidences[nameKey] ?? confidences[medKey] ?? confidences["medications"] ?? 1;
    return c < 0.5;
  });

  if (isHandwritten || hasLowConfMed) {
    const banner = document.createElement("div");
    banner.id = "handwritten-banner";
    banner.style.cssText = "background:#854d0e; color:#fef3c7; border:1px solid #ca8a04; border-radius:8px; padding:12px 16px; margin-bottom:16px; font-size:13px; display:flex; gap:10px; align-items:center;";
    banner.innerHTML = `<span style="font-size:18px;">⚠️</span><span><strong>Handwritten prescription</strong> — please confirm these medicines with your pharmacist or doctor.</span>`;
    fieldsListEl.appendChild(banner);
  }

  if (Object.keys(fields).length === 0) {
    fieldsListEl.innerHTML += `<div class="field-row"><span>No fields extracted — try a clearer, well-lit photo.</span></div>`;
  } else {
    for (const [key, value] of Object.entries(fields)) {
      const conf = confidences[key] || 0;
      let confClass = "conf-empty";
      let displayValue = value ?? "Please enter manually";
      if (Array.isArray(displayValue)) {
        if (displayValue.length > 0) {
          if (typeof displayValue[0] === 'object' && displayValue[0] !== null) {
            displayValue = displayValue.map((item, idx) => {
              // Per-medication confidence check
              const nameKey = `medications_${idx}_name`;
              const medKey = `medications_${idx}`;
              const medConf = confidences[nameKey] ?? confidences[medKey] ?? confidences["medications"] ?? 1;
              const unclearTag = medConf < 0.5
                ? `<span style="color:#f59e0b; font-size:11px; margin-left:4px;">⚠ Unclear</span>`
                : "";
              const itemRows = Object.entries(item)
                .filter(([k, v]) => v !== null && v !== undefined && v !== "")
                .map(([k, v]) => `<div class="sub-field"><strong>${k.replace(/_/g, " ")}:</strong> ${v}</div>`)
                .join("");
              return `<div class="obj-card">${itemRows}${unclearTag}</div>`;
            }).join("");
          } else {
            displayValue = displayValue.join(", ");
          }
        } else {
          displayValue = "Please enter manually";
        }
      }
      if (value !== null && value !== undefined && value !== "" && !(Array.isArray(value) && value.length === 0)) {
        confClass = conf >= 0.9 ? "conf-high" : "conf-low";
      }
      fieldsListEl.innerHTML += `<div class="field-row"><span>${key.replace(/_/g, " ")}</span><span class="${confClass}">${displayValue}</span></div>`;
    }
  }
  
  // Collapse preview image to give space for results
  previewImg.style.display = "none";
  const placeholderText = scanPlaceholder.querySelector("p");
  if (placeholderText) placeholderText.style.display = "none";
  scanPlaceholder.style.height = "auto";
  scanPlaceholder.style.padding = "0";

  resultCard.classList.add("visible");
}

/* ---------- Emergency screen ---------- */
async function loadPublicTools(public_token, profile_data) {
  try {
    const res = await fetch(`${API_BASE}/emergency/${public_token}/qr`);
    if (res.ok) {
      const qrData = await res.json();
      document.getElementById("qr-error").style.display = "none";
      document.getElementById("qr-code-img").src = `data:image/png;base64,${qrData.qr_code_base64}`;
      document.getElementById("qr-code-img").style.display = "block";
      
      const lockText = `EMERGENCY MEDICAL INFO\nBlood: ${profile_data.blood_group || '-'}\nAllergies: ${profile_data.allergies || '-'}\nConditions: ${profile_data.conditions || '-'}\nScan QR or visit: ${qrData.url}`;
      document.getElementById("lock-screen-text").value = lockText;
      
      document.getElementById("print-card-btn").onclick = () => {
        const printWindow = window.open('', '_blank');
        printWindow.document.write(`
          <html>
            <body style="font-family: sans-serif; width: 105mm; height: 148mm; margin: 0; padding: 10mm; box-sizing: border-box; border: 2px solid black;">
              <h1 style="color: red; text-align: center; margin-top: 0; font-size: 20px;">🚨 EMERGENCY MEDICAL ID</h1>
              <p><strong>Name:</strong> _____________________</p>
              <p><strong>Blood Group:</strong> ${profile_data.blood_group || '-'}</p>
              <p><strong>Allergies:</strong> ${profile_data.allergies || '-'}</p>
              <p><strong>Conditions:</strong> ${profile_data.conditions || '-'}</p>
              <p><strong>Emergency Contact:</strong> ${profile_data.emergency_contact || '-'}</p>
              <div style="text-align: center; margin-top: 20px;">
                <img src="data:image/png;base64,${qrData.qr_code_base64}" style="width: 100px;" />
                <p style="font-size: 10px; color: #555;">Scan for latest prescription medicines</p>
              </div>
            </body>
          </html>
        `);
        printWindow.document.close();
        printWindow.focus();
        setTimeout(() => printWindow.print(), 500);
      };
      
      document.getElementById("public-emergency-tools").style.display = "block";
    } else {
        document.getElementById("qr-error").style.display = "block";
        document.getElementById("qr-code-img").style.display = "none";
        document.getElementById("public-emergency-tools").style.display = "block";
    }
  } catch(e) { 
      console.error("QR load failed", e); 
      document.getElementById("qr-error").style.display = "block";
      document.getElementById("qr-code-img").style.display = "none";
      document.getElementById("public-emergency-tools").style.display = "block";
  }
}

document.getElementById("save-emergency-btn").addEventListener("click", async () => {
  const params = new URLSearchParams({
    blood_group: document.getElementById("e-blood").value,
    allergies: document.getElementById("e-allergies").value,
    conditions: document.getElementById("e-conditions").value,
    emergency_contact: document.getElementById("e-contact").value,
    preferred_hospital: document.getElementById("e-hospital").value,
    pin: document.getElementById("e-pin").value,
  });
  try {
    const res = await fetch(`${API_BASE}/emergency/setup?${params}`, { method: "POST" });
    alert(res.ok ? "Emergency profile saved." : "Failed to save. Check all fields are filled.");
  } catch (err) {
    alert("Couldn't reach the server: " + err.message);
  }
});

document.getElementById("unlock-emergency-btn").addEventListener("click", async () => {
  const pin = document.getElementById("unlock-pin").value;
  const params = new URLSearchParams({ pin });
  const card = document.getElementById("emergency-card");
  try {
    const res = await fetch(`${API_BASE}/emergency/unlock?${params}`, { method: "POST" });
    if (!res.ok) {
      alert("Incorrect PIN or no profile set up yet.");
      card.classList.remove("visible");
      return;
    }
    const data = await res.json();
    document.getElementById("v-blood").textContent = data.blood_group || "—";
    document.getElementById("v-allergies").textContent = data.allergies || "—";
    document.getElementById("v-conditions").textContent = data.conditions || "—";
    document.getElementById("v-hospital").textContent = data.preferred_hospital || "—";
    document.getElementById("v-contact").textContent = data.emergency_contact || "—";
    document.getElementById("call-btn").onclick = () => (window.location.href = `tel:${data.emergency_contact}`);
    
    if (data.public_token) {
      loadPublicTools(data.public_token, data);
    }
    
    card.classList.add("visible");
  } catch (err) {
    alert("Couldn't reach the server: " + err.message);
  }
});

document.getElementById("regenerate-btn").addEventListener("click", async () => {
  const pin = document.getElementById("unlock-pin").value || document.getElementById("e-pin").value;
  if (!pin) { alert("Enter PIN first to regenerate."); return; }
  try {
    const params = new URLSearchParams({ pin });
    const res = await fetch(`${API_BASE}/emergency/regenerate?${params}`, { method: "POST" });
    if (res.ok) {
      alert("Link regenerated! Old QR codes will no longer work.");
      document.getElementById("unlock-emergency-btn").click();
    } else { alert("Failed to regenerate."); }
  } catch(e) {}
});

/* ---------- Assistant screen: text chat + voice input + spoken replies ---------- */
const chatLog = document.getElementById("chat-log");
const chatInput = document.getElementById("chat-input");
const micBtn = document.getElementById("mic-btn");
const chatSendBtn = document.getElementById("chat-send-btn");

function appendMessage(sender, text, msgId) {
  const el = document.createElement("div");
  el.className = `msg ${sender}`;
  if (msgId) el.id = msgId;
  
  const textEl = document.createElement("div");
  textEl.className = "msg-text";
  textEl.innerHTML = text.replace(/\n/g, "<br/>");
  el.appendChild(textEl);
  
  if (sender === "ai") {
      const controls = document.createElement("div");
      controls.className = "msg-controls";
      
      const repeatBtn = document.createElement("button");
      repeatBtn.innerText = "🔁 Repeat";
      repeatBtn.onclick = () => {
          if (typeof replayAudio === "function") replayAudio(msgId);
      };
      
      const stopBtn = document.createElement("button");
      stopBtn.innerText = "⏹️ Stop";
      stopBtn.onclick = () => {
          if (typeof stopAnyAudio === "function") stopAnyAudio();
      };
      
      controls.appendChild(repeatBtn);
      controls.appendChild(stopBtn);
      el.appendChild(controls);
  }
  
  chatLog.appendChild(el);
  
  setTimeout(() => {
    chatLog.parentElement.scrollTop = chatLog.parentElement.scrollHeight;
  }, 100);
}

function appendSysNote(msgId, noteText) {
    const el = document.getElementById(msgId);
    if (el) {
        const note = document.createElement("div");
        note.style.fontSize = "12px";
        note.style.color = "#f87171";
        note.style.marginTop = "8px";
        note.innerText = noteText;
        el.appendChild(note);
    }
}

function addMessageTag(msgId, tagText) {
    const el = document.getElementById(msgId);
    if (el) {
        const tag = document.createElement("div");
        tag.style.fontSize = "11px";
        tag.style.color = "#aaa";
        tag.style.marginTop = "4px";
        tag.innerText = tagText;
        el.appendChild(tag);
    }
}

const greetingId = "greeting-0";
appendMessage("ai", "Vanakkam! I'm NalamNet. How can I help you today?", greetingId);

if (micBtn) {
    micBtn.addEventListener("click", () => {
        if (typeof toggleRecording === "function") toggleRecording();
    });
}

async function processVoiceInput(audioBlob) {
    const tempId = "user-" + Date.now();
    appendMessage("user", "🎙️ Processing...", tempId);
    
    const formData = new FormData();
    formData.append("file", audioBlob, "audio.webm");
    
    try {
        const res = await fetch(`${window.API_BASE}/voice/transcribe`, {
            method: "POST",
            body: formData,
        });
        const sttData = await res.json();
        
        const msgEl = document.getElementById(tempId);
        if (msgEl) {
            msgEl.querySelector(".msg-text").innerText = sttData.text;
        }
        
        if (sttData.text) {
            await handleAssistantQuery(sttData.text, sttData.language);
        }
    } catch (e) {
        console.error(e);
        const msgEl = document.getElementById(tempId);
        if (msgEl) msgEl.querySelector(".msg-text").innerText = "❌ Voice error.";
    }
}

async function handleAssistantQuery(text, lang) {
  const aiId = "ai-" + Date.now();
  appendMessage("ai", "Thinking...", aiId);

  try {
    const res = await fetch(`${window.API_BASE}/assistant?question=${encodeURIComponent(text)}&language=${lang}`, {
      method: "POST",
    });
    const data = await res.json();
    
    const el = document.getElementById(aiId);
    if (el) el.querySelector(".msg-text").innerHTML = (data.display_text || "").replace(/\n/g, "<br/>");

    if (data.speech_text && typeof playAssistantAudio === "function") {
        const ttsRes = await fetch(`${window.API_BASE}/voice/tts`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: data.speech_text, language: lang })
        });
        const ttsData = await ttsRes.json();
        const providerName = ttsData.provider === 'browser' ? 'Phone voice' : 'Sarvam';
        addMessageTag(aiId, `🔊 ${providerName}`);
        
        playAssistantAudio(aiId, data.speech_text, lang, ttsData);
    }
  } catch (err) {
    const el = document.getElementById(aiId);
    if (el) el.querySelector(".msg-text").innerText = "Error reaching assistant.";
  }
}

if (chatSendBtn) {
    chatSendBtn.addEventListener("click", () => {
      const text = chatInput.value.trim();
      if (!text) return;
      chatInput.value = "";
      
      if (typeof unlockAudio === "function") unlockAudio();
      
      appendMessage("user", text, "user-" + Date.now());
      
      const isTamil = /[\u0B80-\u0BFF]/.test(text);
      handleAssistantQuery(text, isTamil ? "ta" : "en");
    });
}

if (chatInput) {
    chatInput.addEventListener("keydown", (e) => { 
        if (e.key === "Enter" && chatSendBtn) chatSendBtn.click(); 
    });
}