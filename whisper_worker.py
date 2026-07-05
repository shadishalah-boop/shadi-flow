#!/usr/bin/env python3
import json
import os
import sys
import time
import traceback

os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

try:
    import mlx_whisper
except Exception:
    mlx_whisper = None

try:
    import whisper
except Exception:
    whisper = None

try:
    from parakeet_mlx import from_pretrained as parakeet_from_pretrained
except Exception:
    parakeet_from_pretrained = None


DEFAULT_OPENAI_MODEL = "large-v3-turbo"
DEFAULT_MLX_MODEL = "mlx-community/whisper-large-v3-turbo"
DEFAULT_PARAKEET_MODEL = "mlx-community/parakeet-tdt-0.6b-v3"
OPENAI_MODELS = {}
PARAKEET_MODELS = {}


def resolve_engine(requested_engine=None):
    if requested_engine == "openai":
        if whisper is None:
            raise RuntimeError("openai-whisper is not available in this Python environment.")
        return "openai"

    if requested_engine == "mlx":
        if mlx_whisper is None:
            raise RuntimeError("mlx-whisper is not available in this Python environment.")
        return "mlx"

    if requested_engine == "parakeet":
        if parakeet_from_pretrained is None:
            raise RuntimeError("parakeet-mlx is not available in this Python environment.")
        return "parakeet"

    if mlx_whisper is not None:
        return "mlx"
    if parakeet_from_pretrained is not None:
        return "parakeet"
    if whisper is not None:
        return "openai"
    raise RuntimeError("No supported local ASR runtime is available.")


def mlx_model_name(model_name):
    name = model_name or DEFAULT_OPENAI_MODEL
    if "/" in name:
        return name
    if name in ("large-v3-turbo", "turbo"):
        return DEFAULT_MLX_MODEL
    return f"mlx-community/whisper-{name}"


def openai_model_name(model_name):
    return model_name or DEFAULT_OPENAI_MODEL


def parakeet_model_name(model_name):
    name = model_name or DEFAULT_PARAKEET_MODEL
    if "/" in name:
        return name
    if name in ("v3", "0.6b-v3", "parakeet-v3"):
        return DEFAULT_PARAKEET_MODEL
    if name in ("v2", "0.6b-v2", "parakeet-v2"):
        return "mlx-community/parakeet-tdt-0.6b-v2"
    return name


def load_openai_model(model_name):
    name = openai_model_name(model_name)
    if name not in OPENAI_MODELS:
        print(f"Loading OpenAI Whisper model: {name}", file=sys.stderr, flush=True)
        OPENAI_MODELS[name] = whisper.load_model(name)
    return OPENAI_MODELS[name], name


def load_parakeet_model(model_name):
    name = parakeet_model_name(model_name)
    if name not in PARAKEET_MODELS:
        print(f"Loading MLX Parakeet model: {name}", file=sys.stderr, flush=True)
        PARAKEET_MODELS[name] = parakeet_from_pretrained(name)
    return PARAKEET_MODELS[name], name


def warm_mlx_model(model_name):
    repo = mlx_model_name(model_name)
    from mlx_whisper.transcribe import ModelHolder
    import mlx.core as mx

    print(f"Loading MLX Whisper model: {repo}", file=sys.stderr, flush=True)
    ModelHolder.get_model(repo, mx.float16)
    return repo


def transcribe_mlx(audio_path, model_name, language):
    repo = mlx_model_name(model_name)
    options = {
        "path_or_hf_repo": repo,
        "task": "transcribe",
        "verbose": None,
        "temperature": 0,
        "condition_on_previous_text": False,
        "compression_ratio_threshold": 1.8,
        "logprob_threshold": -1.0,
        "no_speech_threshold": 0.55,
        "fp16": True,
    }
    if language and language != "auto":
        options["language"] = language
    try:
        result = mlx_whisper.transcribe(audio_path, **options)
    except TypeError:
        options.pop("compression_ratio_threshold", None)
        options.pop("logprob_threshold", None)
        options.pop("no_speech_threshold", None)
        result = mlx_whisper.transcribe(audio_path, **options)
    return (result.get("text") or "").strip(), repo


def transcribe_openai(audio_path, model_name, language):
    model, name = load_openai_model(model_name)
    options = {
        "task": "transcribe",
        "verbose": False,
        "temperature": 0,
        "condition_on_previous_text": False,
        "compression_ratio_threshold": 1.8,
        "logprob_threshold": -1.0,
        "no_speech_threshold": 0.55,
        "fp16": False,
    }
    if language and language != "auto":
        options["language"] = language
    result = model.transcribe(audio_path, **options)
    return (result.get("text") or "").strip(), name


def transcribe_parakeet(audio_path, model_name, _language):
    model, name = load_parakeet_model(model_name)
    result = model.transcribe(audio_path)
    return (getattr(result, "text", "") or "").strip(), name


def handle_request(request):
    op = request.get("op") or "transcribe"
    engine = resolve_engine(request.get("engine"))
    model_name = request.get("model")

    if op == "warm":
        if engine == "mlx":
            model = warm_mlx_model(model_name)
        elif engine == "parakeet":
            _, model = load_parakeet_model(model_name)
        else:
            _, model = load_openai_model(model_name)
        return {"ok": True, "engine": engine, "model": model, "warm": True}

    if op != "transcribe":
        raise ValueError(f"Unknown worker operation: {op}")

    audio_path = request.get("audioPath")
    if not audio_path:
        raise ValueError("Missing audioPath.")

    language = (request.get("language") or "").strip()
    started = time.time()
    if engine == "mlx":
        text, model = transcribe_mlx(audio_path, model_name, language)
    elif engine == "parakeet":
        text, model = transcribe_parakeet(audio_path, model_name, language)
    else:
        text, model = transcribe_openai(audio_path, model_name, language)

    return {
        "ok": True,
        "engine": engine,
        "model": model,
        "device": "",
        "text": text,
        "workerDurationMs": round((time.time() - started) * 1000),
    }


def respond(message):
    print(json.dumps(message, ensure_ascii=True), flush=True)


def main():
    for line in sys.stdin:
        raw = line.strip()
        if not raw:
            continue

        request_id = None
        try:
            request = json.loads(raw)
            request_id = request.get("id")
            response = handle_request(request)
            response["id"] = request_id
            respond(response)
        except Exception as exc:
            respond(
                {
                    "id": request_id,
                    "ok": False,
                    "error": str(exc),
                    "traceback": traceback.format_exc()[-2000:],
                }
            )


if __name__ == "__main__":
    main()
