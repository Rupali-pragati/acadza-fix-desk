"""LLM access: one small Gemini client with a content-addressed cache.

Every call is cached by (model, system prompt, user prompt, temperature). The cache is
committed, so `python -m engine run --replay` rebuilds results.json byte-for-byte
without an API key or credits - and a reviewer can read exactly what the model said.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import threading
import time
from dataclasses import dataclass
from pathlib import Path

import httpx

from .load import ROOT

CACHE = ROOT / "engine" / "cache"
API = "https://generativelanguage.googleapis.com/v1beta"


def load_env():
    p = ROOT / ".env"
    if p.exists():
        for line in p.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


load_env()

# used only when a model's free daily quota runs out mid-run; the cache key keeps the requested model
FALLBACK = {"gemini-3.5-flash": "gemini-3-flash-preview", "gemini-3-flash-preview": "gemini-3.5-flash", "gemini-3.5-flash-lite": "gemini-3.5-flash"}

MODELS = {
    "solver": os.environ.get("SOLVER_MODEL", "gemini-3.5-flash"),
    "check": os.environ.get("CHECK_MODEL", "gemini-3-flash-preview"),
    "triage": os.environ.get("TRIAGE_MODEL", "gemini-3.5-flash"),
    "reply": os.environ.get("REPLY_MODEL", "gemini-3.5-flash-lite"),
}
MIN_INTERVAL = float(os.environ.get("LLM_MIN_INTERVAL_S", "4"))
WORKERS = int(os.environ.get("LLM_WORKERS", "4"))


class CacheMiss(RuntimeError):
    pass


@dataclass
class Usage:
    calls: int = 0
    cached: int = 0
    prompt_tokens: int = 0
    output_tokens: int = 0

    def as_dict(self):
        return self.__dict__.copy()


PENDING = CACHE.parent / "pending"
STANDIN = "claude-opus-5-5 (Claude Code, standing in while the Gemini free-tier daily quota was exhausted)"


class PendingCall(Exception):
    """Raised in manual mode when a prompt has no cached answer yet."""


def answer_pending() -> int:
    """Move every pending/<tag>/<h>.response.json into the cache, declared as a stand-in answer."""
    n = 0
    for resp in sorted(PENDING.glob("*/*.response.json")):
        req = json.loads(resp.with_name(resp.name.replace(".response", "")).read_text(encoding="utf-8"))
        text = resp.read_text(encoding="utf-8").strip()
        parse_json(text)  # refuse to cache broken JSON
        h = resp.name.split(".")[0]
        out = CACHE / req["tag"] / f"{h}.json"
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps({"model": req["model"], "answeredBy": STANDIN, "temperature": req["temperature"],
                                   "created": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "usage": {},
                                   "system_sha": hashlib.sha256(req["system"].encode()).hexdigest()[:12],
                                   "user": req["user"], "response": text}, ensure_ascii=False, indent=1), encoding="utf-8")
        resp.with_name(resp.name.replace(".response", "")).unlink()
        resp.unlink()
        n += 1
    return n


class LLM:
    def __init__(self, mode: str = "live"):
        assert mode in ("live", "replay", "refresh", "manual", "regemini")
        self.mode = mode
        self.key = os.environ.get("GEMINI_API_KEY", "")
        self.usage = Usage()
        self._last = 0.0
        self._lock = threading.Lock()  # groups run in parallel threads; the request pacing is shared
        self._http = httpx.Client(timeout=240)

    # ------------------------------------------------------------------ public
    def json_call(self, role: str, system: str, user: str, *, temperature: float = 0.0, tag: str = "") -> dict:
        """Call the model for `role` and return parsed JSON. Retries once if the JSON is broken."""
        model = MODELS[role]
        text = self._call(model, system, user, temperature, tag or role)
        try:
            return parse_json(text)
        except ValueError:
            fix_user = user + "\n\nYour previous reply was not valid JSON. Reply again with ONLY the JSON object."
            return parse_json(self._call(model, system, fix_user, temperature, tag or role))

    def list_models(self) -> list[str]:
        r = self._http.get(f"{API}/models", headers={"x-goog-api-key": self.key}, params={"pageSize": 200})
        r.raise_for_status()
        return [m["name"].split("/", 1)[1] for m in r.json().get("models", [])
                if "generateContent" in m.get("supportedGenerationMethods", [])]

    # ------------------------------------------------------------------ internals
    def _call(self, model, system, user, temperature, tag) -> str:
        h = hashlib.sha256(json.dumps([model, system, user, temperature], ensure_ascii=False).encode()).hexdigest()[:20]
        path = CACHE / tag / f"{h}.json"
        if self.mode != "refresh" and path.exists():
            entry = json.loads(path.read_text(encoding="utf-8"))
            if not (self.mode == "regemini" and entry.get("answeredBy")):
                self.usage.cached += 1
                return entry["response"]
        if self.mode == "manual":
            # stand-in mode: park the exact prompt for a human/assistant to answer, then re-run
            pend = PENDING / tag / f"{h}.json"
            pend.parent.mkdir(parents=True, exist_ok=True)
            if not pend.exists():
                pend.write_text(json.dumps({"tag": tag, "model": model, "temperature": temperature, "system": system, "user": user},
                                           ensure_ascii=False, indent=1), encoding="utf-8")
            raise PendingCall(str(pend))
        if self.mode == "replay":
            raise CacheMiss(f"no cached response for {tag}/{h} (run without --replay and with GEMINI_API_KEY)")
        if not self.key:
            raise RuntimeError("GEMINI_API_KEY is not set (put it in .env) - or use --replay to run from the committed cache")
        text, usage = self._post(model, system, user, temperature)
        with self._lock:
            self.usage.calls += 1
        self.usage.prompt_tokens += usage.get("promptTokenCount", 0)
        self.usage.output_tokens += usage.get("candidatesTokenCount", 0) + usage.get("thoughtsTokenCount", 0)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"model": model, "temperature": temperature, "created": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                                    "usage": usage, "system_sha": hashlib.sha256(system.encode()).hexdigest()[:12],
                                    "user": user, "response": text}, ensure_ascii=False, indent=1), encoding="utf-8")
        return text

    def _post(self, model, system, user, temperature):
        body = {
            "systemInstruction": {"parts": [{"text": system}]},
            "contents": [{"role": "user", "parts": [{"text": user}]}],
            "generationConfig": {"temperature": temperature, "responseMimeType": "application/json", "maxOutputTokens": 32768},
        }
        delay = 10.0
        for attempt in range(7):
            with self._lock:
                wait = self._last + MIN_INTERVAL - time.time()
                if wait > 0:
                    time.sleep(wait)
                self._last = time.time()
            r = self._http.post(f"{API}/models/{model}:generateContent", headers={"x-goog-api-key": self.key}, json=body)
            if r.status_code == 200:
                data = r.json()
                cands = data.get("candidates") or []
                parts = (cands[0].get("content") or {}).get("parts", []) if cands else []
                text = "".join(p.get("text", "") for p in parts if not p.get("thought"))
                if text.strip():
                    return text, {**data.get("usageMetadata", {}), "servedModel": model}
                reason = cands[0].get("finishReason") if cands else data.get("promptFeedback")
                print(f"  ! empty response from {model} ({reason}); retrying")
            elif r.status_code in (429, 500, 502, 503, 504):
                m = re.search(r'"retryDelay":\s*"(\d+)', r.text)
                asked = float(m.group(1)) + 1 if m else delay
                if asked > 300 and FALLBACK.get(model) and attempt >= 1:
                    # a multi-hour retryDelay means this model's daily bucket is spent: switch instead of sleeping
                    print(f"  ! {model} quota spent (retry in {asked/3600:.1f}h); falling back to {FALLBACK[model]}")
                    model = FALLBACK[model]
                    continue
                pause = min(asked, 90)  # never sleep for hours inside a run
                print(f"  ! {model} HTTP {r.status_code}; waiting {pause:.0f}s")
                time.sleep(pause)
                delay = min(delay * 2, 90)
            else:
                raise RuntimeError(f"{model} HTTP {r.status_code}: {r.text[:500]}")
        raise RuntimeError(f"{model}: gave up after retries")


def parse_json(text: str) -> dict:
    t = text.strip()
    t = re.sub(r"^```(?:json)?\s*|\s*```$", "", t)
    try:
        return json.loads(t)
    except json.JSONDecodeError:
        a, b = t.find("{"), t.rfind("}")
        if a != -1 and b > a:
            try:
                return json.loads(t[a:b + 1])
            except json.JSONDecodeError:
                pass
    raise ValueError(f"not JSON: {text[:200]!r}")
