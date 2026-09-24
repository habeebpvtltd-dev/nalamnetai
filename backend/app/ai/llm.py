import os
import time
import json
import httpx
from groq import Groq

DEFAULT_LLM_CHAIN = "groq:openai/gpt-oss-120b,groq:openai/gpt-oss-20b,sarvam:sarvam-105b-conversations"
DEFAULT_LLM_CHAIN_TA = "sarvam:sarvam-105b-conversations,groq:openai/gpt-oss-120b,groq:openai/gpt-oss-20b"

_cool_downs = {}
groq_client = Groq(api_key=os.environ.get("GROQ_API_KEY"))
sarvam_api_key = os.environ.get("SARVAM_API_KEY")

def _parse_json(text: str) -> dict:
    start = text.find("{")
    end = text.rfind("}")
    if start != -1 and end != -1 and end >= start:
        text = text[start:end+1]
    return json.loads(text)

def _get_cooldown_time(error_msg: str) -> float:
    # Try to parse "Please try again in XmYs" from Groq error
    try:
        if "Please try again in" in error_msg:
            part = error_msg.split("Please try again in")[1].split(".")[0].strip()
            # e.g., "8m28" or "10m"
            mins = 0
            secs = 0
            if "m" in part:
                m_part, rest = part.split("m")
                mins = int(m_part)
                if "s" in rest:
                    secs = int(float(rest.replace("s", "")))
            elif "s" in part:
                secs = int(float(part.replace("s", "")))
            return time.time() + (mins * 60) + secs + 5 # +5s buffer
    except Exception:
        pass
    return time.time() + 600

def chat(messages: list[dict], **opts) -> str:
    if opts.get("use_ta_chain"):
        chain_env = os.environ.get("LLM_CHAIN_TA", DEFAULT_LLM_CHAIN_TA)
    else:
        chain_env = os.environ.get("LLM_CHAIN", DEFAULT_LLM_CHAIN)
    chain = [m.strip() for m in chain_env.split(",") if m.strip()]
    
    last_error = None
    fallback_from = None
    
    for model_key in chain:
        if model_key in _cool_downs:
            if time.time() < _cool_downs[model_key]:
                continue
            else:
                del _cool_downs[model_key]
                
        provider, model_name = model_key.split(":", 1)
        
        print(f"[LLM] model={model_key} fallback_from={fallback_from}")
        
        try:
            for attempt in range(2):
                try:
                    if provider == "groq":
                        groq_opts = {
                            "model": model_name,
                            "messages": messages,
                            "max_tokens": opts.get("max_tokens", 4096),
                            "timeout": 30.0
                        }
                        if "temperature" in opts:
                            groq_opts["temperature"] = opts["temperature"]
                        if opts.get("response_format"):
                            groq_opts["response_format"] = opts["response_format"]
                        
                        response = groq_client.chat.completions.create(**groq_opts)
                        return response.choices[0].message.content.strip()
                        
                    elif provider == "sarvam":
                        headers = {"api-subscription-key": sarvam_api_key, "Content-Type": "application/json"}
                        
                        payload = {
                            "model": model_name,
                            "messages": messages,
                            "temperature": opts.get("temperature", 0.2),
                            "max_tokens": opts.get("max_tokens", 4096),
                            "reasoning_effort": "low"
                        }
                        if opts.get("response_format"):
                            payload["response_format"] = opts["response_format"]
                        
                        resp = httpx.post("https://api.sarvam.ai/v1/chat/completions", headers=headers, json=payload, timeout=60.0)
                        
                        if resp.status_code == 429 or resp.status_code >= 500:
                            if attempt == 0:
                                time.sleep(2)
                                continue
                            if resp.status_code == 429:
                                _cool_downs[model_key] = time.time() + 600
                            last_error = f"Sarvam {resp.status_code}: {resp.text}"
                            fallback_from = model_key
                            raise Exception(last_error)
                        elif resp.status_code in (401, 404):
                            _cool_downs[model_key] = time.time() + 3600  # 1 hour cooldown for auth/not found
                            last_error = f"Sarvam {resp.status_code}: {resp.text}"
                            fallback_from = model_key
                            raise Exception(last_error)
                            
                        resp.raise_for_status()
                        data = resp.json()
                        content = data["choices"][0]["message"].get("content")
                        if content is None:
                            print(f"[LLM] Sarvam unexpected None response: {data}")
                            raise Exception("Sarvam response content is None")
                        return content.strip()
                except Exception as attempt_e:
                    error_str = str(attempt_e).lower()
                    if attempt == 0 and ("429" in error_str or "rate limit" in error_str or "500" in error_str or "502" in error_str or "503" in error_str or "504" in error_str):
                        time.sleep(2)
                        continue
                    raise attempt_e
                    
        except Exception as e:
            error_str = str(e).lower()
            last_error = str(e)
            fallback_from = model_key
            
            if "429" in error_str or "rate limit" in error_str:
                _cool_downs[model_key] = _get_cooldown_time(str(e))
            elif "404" in error_str or "401" in error_str or "not found" in error_str or "unauthorized" in error_str:
                _cool_downs[model_key] = time.time() + 3600
                
            continue
            
    raise Exception(f"All LLMs in chain failed. Last error: {last_error}")

