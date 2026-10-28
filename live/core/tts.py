"""语音合成：Edge 神经网络音色，落盘缓存，按字节估算时长。"""
from __future__ import annotations

import asyncio
import hashlib
import threading
import time

from .config import DATA_DIR

AUDIO_DIR = DATA_DIR / "audio"
AUDIO_DIR.mkdir(parents=True, exist_ok=True)
_LOCK = threading.Lock()

# edge-tts 默认输出 audio-24khz-48kbitrate-mono-mp3 ≈ 6000 字节/秒
BYTES_PER_SECOND = 6000.0


def synth(text: str, voice: str, rate: str, pitch: str) -> dict:
    """返回 {url, duration, cached, error?}"""
    text = (text or "").strip()[:400]
    if not text:
        return {"url": "", "duration": 0, "error": "空文本"}
    digest = hashlib.sha1(f"{voice}|{rate}|{pitch}|{text}".encode("utf-8")).hexdigest()[:16]
    path = AUDIO_DIR / f"{digest}.mp3"
    if path.exists() and path.stat().st_size > 1000:
        return {"url": f"/audio/{path.name}", "duration": _duration(path), "cached": True}

    try:
        import edge_tts
    except ImportError:
        return {"url": "", "duration": max(1.5, len(text) * 0.19), "error": "缺少 edge-tts，请先 pip install edge-tts"}

    with _LOCK:
        if path.exists() and path.stat().st_size > 1000:
            return {"url": f"/audio/{path.name}", "duration": _duration(path), "cached": True}

        async def run() -> None:
            communicate = edge_tts.Communicate(text, voice, rate=rate, pitch=pitch)
            await communicate.save(str(path))

        for attempt in range(2):
            try:
                asyncio.run(run())
                if path.exists() and path.stat().st_size > 1000:
                    return {"url": f"/audio/{path.name}", "duration": _duration(path), "cached": False}
            except Exception as exc:  # 网络抖动重试一次
                if attempt == 1:
                    return {"url": "", "duration": max(1.5, len(text) * 0.19), "error": str(exc)[:120]}
                time.sleep(0.8)
    return {"url": "", "duration": max(1.5, len(text) * 0.19), "error": "合成失败"}


def _duration(path) -> float:
    size = path.stat().st_size
    return round(min(120.0, max(0.8, size / BYTES_PER_SECOND)), 2)


def cleanup(max_files: int = 400) -> int:
    files = sorted(AUDIO_DIR.glob("*.mp3"), key=lambda p: p.stat().st_mtime, reverse=True)
    removed = 0
    for f in files[max_files:]:
        try:
            f.unlink()
            removed += 1
        except OSError:
            pass
    return removed
