import os
import time
import base64
import httpx
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), '..', '.env'))
SARVAM_API_KEY = os.environ.get("SARVAM_API_KEY")

speakers = [
    "Shubh", "Aditya", "Ritu", "Priya", "Neha", "Rahul", "Pooja", 
    "Rohan", "Simran", "Kavya", "Amit", "Dev", "Ishita", "Shreya", 
    "Ratan", "Varun", "Manan", "Sumit", "Roopa", "Kabir", "Aayan", 
    "Ashutosh", "Advait"
]
paces = [0.9, 1.0]

text = "வணக்கம்! இன்று இரவு எட்டு மணிக்கு உங்கள் சர்க்கரை மாத்திரையை சாப்பிட மறக்காதீர்கள். உடம்பை நல்லா பாத்துக்கோங்க."
language_code = "ta-IN"

out_dir = os.path.join(os.path.dirname(__file__), '..', 'samples')
os.makedirs(out_dir, exist_ok=True)

with httpx.Client(timeout=30.0) as client:
    for speaker in speakers:
        for pace in paces:
            payload = {
                "text": text,
                "language_code": language_code,
                "speaker": speaker.lower(),
                "model": "bulbul:v3",
                "pace": pace
            }
            headers = {
                "api-subscription-key": SARVAM_API_KEY,
                "Content-Type": "application/json"
            }
            try:
                resp = client.post("https://api.sarvam.ai/text-to-speech", headers=headers, json=payload)
                resp.raise_for_status()
                data = resp.json()
                if "audios" in data and data["audios"]:
                    audio_b64 = data["audios"][0]
                    audio_bytes = base64.b64decode(audio_b64)
                    
                    out_file = os.path.join(out_dir, f"ta_{speaker.lower()}_{pace}.wav")
                    with open(out_file, "wb") as f:
                        f.write(audio_bytes)
                    print(f"Saved {out_file}")
            except Exception as e:
                print(f"Error for {speaker} at {pace}: {e}")
            
            time.sleep(0.5)
