/**
 * voice.js - NalamNet Spatial Voice Assistant Logic
 */

let mediaRecorder;
let audioChunks = [];
let isRecording = false;
let currentAudio = null;
let currentUtterance = null;

const audioCache = new Map();
let greetingPlayed = false;

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
        const utterance = new SpeechSynthesisUtterance('');
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
}

async function playAssistantAudio(msgId, text, language, ttsData) {
    stopAnyAudio();
    const isTamil = language === 'ta';
    
    if (ttsData.provider === 'browser') {
        if (!("speechSynthesis" in window)) return;
        const langCode = isTamil ? 'ta-IN' : 'en-IN';
        
        let availableVoices = speechSynthesis.getVoices();
        if (availableVoices.length === 0) {
            await new Promise(resolve => {
                const timeout = setTimeout(resolve, 1000);
                speechSynthesis.onvoiceschanged = () => {
                    clearTimeout(timeout);
                    resolve();
                };
            });
            availableVoices = speechSynthesis.getVoices();
        }

        const voice = availableVoices.find(v => v.lang.startsWith(isTamil ? 'ta' : 'en'));
        if (isTamil && !voice && typeof appendSysNote === "function") {
            appendSysNote(msgId, "Tamil voice not installed on this phone.");
        }
        
        audioCache.set(msgId, { type: 'browser', text, lang: langCode });
        playCachedBrowser(msgId);
    } else if (ttsData.audio_base64) {
        const src = `data:${ttsData.mime};base64,${ttsData.audio_base64}`;
        audioCache.set(msgId, { type: 'api', src });
        playCachedApi(msgId);
    }
}

function playCachedBrowser(msgId) {
    const data = audioCache.get(msgId);
    if (!data) return;
    
    stopAnyAudio();
    const availableVoices = speechSynthesis.getVoices();
    const voice = availableVoices.find(v => v.lang.startsWith(data.lang.split('-')[0]));
    
    currentUtterance = new SpeechSynthesisUtterance(data.text);
    currentUtterance.lang = data.lang;
    currentUtterance.rate = 0.85;
    if (voice) {
        currentUtterance.voice = voice;
    }
    speechSynthesis.speak(currentUtterance);
}

function playCachedApi(msgId) {
    const data = audioCache.get(msgId);
    if (!data) return;
    
    stopAnyAudio();
    currentAudio = new Audio(data.src);
    currentAudio.play().catch(e => console.error("Audio play failed:", e));
}

function replayAudio(msgId) {
    const data = audioCache.get(msgId);
    if (data) {
        if (data.type === 'browser') playCachedBrowser(msgId);
        else playCachedApi(msgId);
    }
}

async function startRecording() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        mediaRecorder = new MediaRecorder(stream);
        audioChunks = [];
        
        mediaRecorder.ondataavailable = e => {
            if (e.data.size > 0) audioChunks.push(e.data);
        };
        
        mediaRecorder.onstop = async () => {
            const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
            stream.getTracks().forEach(t => t.stop());
            if (typeof processVoiceInput === "function") {
                await processVoiceInput(audioBlob);
            }
        };
        
        mediaRecorder.start();
        isRecording = true;
        
        const micBtn = document.getElementById('mic-btn');
        if (micBtn) {
            micBtn.classList.add('listening');
            micBtn.innerText = "⏹";
        }
        
        setTimeout(() => {
            if (isRecording) stopRecording();
        }, 15000);
    } catch (e) {
        console.error("Mic error:", e);
        alert("Microphone permission denied or not available.");
    }
}

function stopRecording() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop();
    }
    isRecording = false;
    
    const micBtn = document.getElementById('mic-btn');
    if (micBtn) {
        micBtn.classList.remove('listening');
        micBtn.innerText = "🎤";
    }
}

function toggleRecording() {
    if (isRecording) {
        stopRecording();
        unlockAudio(); 
    } else {
        startRecording();
    }
}

async function playGreeting() {
    if (greetingPlayed) return;
    greetingPlayed = true;
    
    const greetingText = "Vanakkam! I'm NalamNet. How can I help you today?";
    const msgId = "greeting-0";
    
    try {
        const res = await fetch(`${window.API_BASE}/voice/tts`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: greetingText, language: "en" })
        });
        const ttsData = await res.json();
        
        const providerName = ttsData.provider === 'browser' ? 'Phone voice' : 'Sarvam';
        if (typeof addMessageTag === "function") {
            addMessageTag(msgId, `🔊 ${providerName}`);
        }
        
        playAssistantAudio(msgId, greetingText, "en", ttsData);
    } catch (e) {
        console.error("Greeting TTS error:", e);
    }
}
