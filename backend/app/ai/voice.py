import os
import io
import wave
import time
import base64
import httpx
import tempfile
import subprocess
from groq import Groq

SARVAM_API_KEY = os.environ.get("SARVAM_API_KEY")
VOICE_STT_PROVIDER = os.environ.get("VOICE_STT_PROVIDER", "sarvam")
VOICE_TTS_PROVIDER = os.environ.get("VOICE_TTS_PROVIDER", "sarvam")
TTS_SPEAKER_TA = os.environ.get("TTS_SPEAKER_TA", "ritu")
TTS_SPEAKER_EN = os.environ.get("TTS_SPEAKER_EN", "priya")
TTS_PACE_TA = float(os.environ.get("TTS_PACE_TA", "0.95"))
TTS_PACE_EN = float(os.environ.get("TTS_PACE_EN", "0.9"))

_sarvam_disabled_until = 0

def is_sarvam_available():
    global _sarvam_disabled_until
    if not SARVAM_API_KEY:
        return False
    if time.time() < _sarvam_disabled_until:
        return False
    return True

def disable_sarvam(reason: str):
    global _sarvam_disabled_until
    print(f"[VOICE] Sarvam disabled for 10 min: {reason}")
    _sarvam_disabled_until = time.time() + 600

def _convert_to_wav(audio_bytes: bytes) -> bytes:
    """Converts any audio to 16kHz mono WAV using subprocess + ffmpeg."""
    with tempfile.NamedTemporaryFile(delete=False, suffix=".tmp") as tmp_in:
        tmp_in.write(audio_bytes)
        tmp_in_path = tmp_in.name
    
    tmp_out_path = tmp_in_path + ".wav"
    try:
        subprocess.run([
            "ffmpeg", "-y", "-i", tmp_in_path,
            "-ar", "16000", "-ac", "1", "-f", "wav", tmp_out_path
        ], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        
        with open(tmp_out_path, "rb") as f:
            wav_bytes = f.read()
        return wav_bytes
    finally:
        if os.path.exists(tmp_in_path):
            os.remove(tmp_in_path)
        if os.path.exists(tmp_out_path):
            os.remove(tmp_out_path)

def transcribe(audio_bytes: bytes, mime_type: str = "") -> dict:
    fallback_result = {"text": "", "language": "en", "provider": "groq"}
    current_audio = audio_bytes
    
    if VOICE_STT_PROVIDER == "sarvam" and is_sarvam_available():
        try:
            # We use a .webm extension as default for browser audio
            files = {"file": ("audio.webm", current_audio, mime_type or "audio/webm")}
            data = {"model": "saaras:v3", "language_code": "unknown", "mode": "transcribe"}
            headers = {"api-subscription-key": SARVAM_API_KEY}
            
            with httpx.Client(timeout=60.0) as client:
                for attempt in range(2):
                    try:
                        resp = client.post("https://api.sarvam.ai/speech-to-text", headers=headers, data=data, files=files)
                        
                        if resp.status_code in [400, 415]:
                            # Rejected format, convert and retry
                            current_audio = _convert_to_wav(current_audio)
                            files = {"file": ("audio.wav", current_audio, "audio/wav")}
                            resp = client.post("https://api.sarvam.ai/speech-to-text", headers=headers, data=data, files=files)
                            
                        if resp.status_code == 429 or resp.status_code >= 500:
                            if attempt == 0:
                                time.sleep(2)
                                continue
                            if resp.status_code == 429:
                                disable_sarvam(f"HTTP {resp.status_code}: {resp.text}")
                            raise Exception("Sarvam rate limit or error")
                        if resp.status_code in [401, 403]:
                            disable_sarvam(f"HTTP {resp.status_code}: {resp.text}")
                            raise Exception("Sarvam auth error")
                            
                        resp.raise_for_status()
                        res_json = resp.json()
                        break
                    except Exception as e:
                        if attempt == 0 and ("429" in str(e) or "50" in str(e)):
                            time.sleep(2)
                            continue
                        raise e
            
            text = res_json.get("transcript", "")
            detected_lang = res_json.get("language_code", "en")
            
            lang = "ta" if "ta" in detected_lang.lower() or "tamil" in detected_lang.lower() else "en"
            
            print(f"[STT] provider=sarvam language={lang} chars={len(text)}")
            return {"text": text, "language": lang, "provider": "sarvam"}
        except Exception as e:
            print(f"[ERROR] Sarvam STT failed: {e}")
            # Fall through to fallback
    
    # Fallback to Groq Whisper
    try:
        groq_client = Groq(api_key=os.environ.get("GROQ_API_KEY"))
        
        def call_groq(audio_data, file_name):
            return groq_client.audio.transcriptions.create(
                file=(file_name, audio_data),
                model="whisper-large-v3",
                response_format="verbose_json"
            )
            
        try:
            transcription = call_groq(current_audio, "audio.webm")
        except Exception:
            current_audio = _convert_to_wav(audio_bytes)
            transcription = call_groq(current_audio, "audio.wav")
            
        text = getattr(transcription, "text", "")
        detected_lang = getattr(transcription, "language", "en")
        
        lang = "ta" if "tamil" in detected_lang.lower() or "ta" in detected_lang.lower() else "en"
        print(f"[STT] provider=groq language={lang} chars={len(text)}")
        return {"text": text, "language": lang, "provider": "groq"}
    except Exception as e:
        print(f"[ERROR] Groq STT fallback failed: {e}")
        return fallback_result

def chunk_text(text: str, max_length: int = 500) -> list:
    sentences = text.replace('?', '.').replace('!', '.').split('.')
    chunks = []
    current_chunk = ""
    for s in sentences:
        s = s.strip()
        if not s: continue
        if len(current_chunk) + len(s) + 1 <= max_length:
            current_chunk += (s + ". ")
        else:
            if current_chunk: chunks.append(current_chunk.strip())
            if len(s) > max_length:
                for i in range(0, len(s), max_length):
                    chunks.append(s[i:i+max_length])
                current_chunk = ""
            else:
                current_chunk = s + ". "
    if current_chunk:
        chunks.append(current_chunk.strip())
    return chunks

def synthesize(text: str, language: str = "en") -> dict:
    if not text.strip():
        return {"provider": "browser"}
        
    if VOICE_TTS_PROVIDER == "sarvam" and is_sarvam_available():
        lang_code = "ta-IN" if language == "ta" else "en-IN"
        speaker = TTS_SPEAKER_TA if language == "ta" else TTS_SPEAKER_EN
        pace = TTS_PACE_TA if language == "ta" else TTS_PACE_EN
        chunks = chunk_text(text, 500)
        audio_chunks = []
        
        headers = {
            "api-subscription-key": SARVAM_API_KEY,
            "Content-Type": "application/json"
        }
        
        try:
            with httpx.Client(timeout=60.0) as client:
                for chunk in chunks:
                    payload = {
                        "text": chunk,
                        "language_code": lang_code,
                        "speaker": speaker.lower(),
                        "model": "bulbul:v3",
                        "pace": pace
                    }
                    for attempt in range(2):
                        try:
                            resp = client.post("https://api.sarvam.ai/text-to-speech", headers=headers, json=payload)
                            
                            if resp.status_code == 429 or resp.status_code >= 500:
                                if attempt == 0:
                                    time.sleep(2)
                                    continue
                                if resp.status_code == 429:
                                    disable_sarvam(f"HTTP {resp.status_code}: {resp.text}")
                                raise Exception("Sarvam TTS rate limit or error")
                            if resp.status_code in [401, 403]:
                                disable_sarvam(f"HTTP {resp.status_code}: {resp.text}")
                                raise Exception("Sarvam TTS auth error")
                                
                            resp.raise_for_status()
                            res_json = resp.json()
                            break
                        except Exception as e:
                            if attempt == 0 and ("429" in str(e) or "50" in str(e)):
                                time.sleep(2)
                                continue
                            raise e
                    audios = res_json.get("audios", [])
                    if audios:
                        audio_chunks.append(base64.b64decode(audios[0]))
                    
            if audio_chunks:
                out_buffer = io.BytesIO()
                with wave.open(out_buffer, 'wb') as wav_out:
                    for i, chunk_bytes in enumerate(audio_chunks):
                        try:
                            with wave.open(io.BytesIO(chunk_bytes), 'rb') as wav_in:
                                if i == 0:
                                    wav_out.setparams(wav_in.getparams())
                                wav_out.writeframes(wav_in.readframes(wav_in.getnframes()))
                        except wave.Error as we:
                            print(f"[ERROR] Failed to read WAV chunk: {we}")
                            pass
                            
                final_audio = out_buffer.getvalue()
                
                b64_out = base64.b64encode(final_audio).decode("utf-8")
                print(f"[TTS] provider=sarvam language={language} chars={len(text)}")
                return {"audio_base64": b64_out, "mime": "audio/wav", "provider": "sarvam"}
                
        except Exception as e:
            print(f"[ERROR] Sarvam TTS failed: {e}")
            
    print(f"[TTS] provider=browser language={language} chars={len(text)}")
    return {"provider": "browser"}
