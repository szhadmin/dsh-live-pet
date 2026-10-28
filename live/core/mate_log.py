"""直播伴侣日志桥：从「抖音直播伴侣」自己的日志里抓礼物事件。

为什么需要它
------------
抖音网页端（游客身份）的 WS 只推 进场/点赞/弹幕，**不推礼物**（2026-10 实测）。
但主播端的「直播伴侣」是会收到礼物的，而且它把每条礼物写进了自己的日志：

    [2026-10-27T13:04:40] [INFO] <home> [centerConsoleGiftDebug][handleCenterConsoleGiftMessage]
        skip cheap/free repeatEnd {"giftId":"463","userId":"75954947779","groupId":"1793077479",
        "totalCount":"1","groupCount":"1","repeatCount":"1","comboCount":"1","repeatEnd":1}

所以：**盯住这份日志 → 解析成礼物事件 → 塞进直播事件队列**。
礼物照样走「动作 + 智能体道谢 + 礼物点歌」，优先级最高。

局限：日志里只有 userId（没有昵称）和 giftId（没有礼物名），
昵称靠我们自己的 WS 消息（进场/弹幕带 user.id + 昵称）攒表回填；
礼物名靠 id → 名字表（data/gift-names.json，可手改）。
"""
from __future__ import annotations

import json
import os
import re
import threading
import time
from pathlib import Path

from . import names

DEFAULT_DIR = Path(os.environ.get("APPDATA", "")) / "webcast_mate" / "biz-logs"

# 礼物 id → 名字（可以从 data/gift-names.json 覆盖/补充）
BUILTIN_GIFT_NAMES = {
    "463": "小心心",
}

LINE_RE = re.compile(
    r"\[(?P<ts>[0-9T:.\-]+)\].*handleCenterConsoleGiftMessage\]\s*(?P<action>[^{]*?)\s*(?P<json>\{.*\})\s*$"
)


class MateLogWatcher(threading.Thread):
    """盯 %APPDATA%\\webcast_mate\\biz-logs 下最新的日志，把礼物行变成事件。"""

    def __init__(self, emit, cfg_getter=None, log=None, stop_event: threading.Event | None = None,
                 poll: float = 1.0, replay_tail: int = 0):
        super().__init__(daemon=True, name="mate-log-watcher")
        self.emit = emit
        self.cfg_getter = cfg_getter or (lambda: {})
        self.log = log or (lambda msg: None)
        self._stop = stop_event or threading.Event()
        self.poll = max(0.3, poll)
        self.replay_tail = max(0, replay_tail)
        self._fh = None
        self._path: Path | None = None
        self._buf = ""
        self._combos: dict[str, dict] = {}
        self._seen_lines: set[str] = set()
        self.stats = {"gift": 0, "skip": 0, "last": "", "file": "", "errors": []}

    # ---- 文件定位 ----
    def _log_dir(self) -> Path:
        cfg = self.cfg_getter() or {}
        raw = str((cfg.get("douyin") or {}).get("mate_log_dir") or "").strip()
        return Path(raw) if raw else DEFAULT_DIR

    def _newest(self) -> Path | None:
        d = self._log_dir()
        try:
            files = [p for p in d.glob("*.log") if p.is_file()]
        except OSError:
            return None
        if not files:
            return None
        return max(files, key=lambda p: p.stat().st_mtime)

    def _open(self, path: Path) -> None:
        try:
            if self._fh:
                self._fh.close()
        except OSError:
            pass
        self._fh = open(path, "r", encoding="utf-8", errors="replace")
        self._path = path
        self.stats["file"] = str(path)
        if self.replay_tail:
            try:                                  # 自检用：从文件尾部回放几行
                lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
                for line in lines[-self.replay_tail:]:
                    self._handle_line(line)
            except OSError:
                pass
        else:
            self._fh.seek(0, os.SEEK_END)
            self.log(f"礼物日志桥已挂上：{path.name}")

    # ---- 行解析 ----
    def _handle_line(self, line: str) -> None:
        hit = LINE_RE.search(line)
        if not hit:
            return
        try:
            payload = json.loads(hit.group("json"))
        except json.JSONDecodeError:
            self._note_error("礼物日志 JSON 解析失败")
            return
        gid = str(payload.get("giftId") or "").strip()
        uid = str(payload.get("userId") or "").strip()
        if not gid:
            self.stats["skip"] += 1
            return
        group = str(payload.get("groupId") or "").strip()
        try:
            count = max(1, int(payload.get("totalCount") or payload.get("comboCount")
                               or payload.get("groupCount") or 1))
        except (TypeError, ValueError):
            count = 1
        repeat_end = payload.get("repeatEnd") in (1, "1", True)

        key = group or f"{uid}-{gid}-{hit.group('ts')}"
        now = time.time()
        entry = self._combos.get(key)
        if entry is None:
            entry = {"gid": gid, "uid": uid, "count": count, "at": now}
            self._combos[key] = entry
        else:
            entry["count"] = max(entry["count"], count)
            entry["at"] = now
        if group and not repeat_end:
            return                                # 连击还没结束，攒着
        self._combos.pop(key, None)
        self._emit(key, entry["gid"], entry["uid"], entry["count"])

    def _flush_idle(self, ttl: float = 2.5) -> None:
        now = time.time()
        for key in [k for k, v in self._combos.items() if now - v["at"] >= ttl]:
            entry = self._combos.pop(key)
            self._emit(key, entry["gid"], entry["uid"], entry["count"])

    def _gift_name(self, gid: str) -> str:
        cfg = self.cfg_getter() or {}
        custom = (cfg.get("douyin") or {}).get("gift_names") or {}
        if gid in custom:
            return str(custom[gid])
        try:
            learned = json.loads((Path.cwd() / "data" / "gift-names.json").read_text(encoding="utf-8"))
            if gid in learned:
                return str(learned[gid])
        except (OSError, json.JSONDecodeError):
            pass
        return BUILTIN_GIFT_NAMES.get(gid, "")

    def _emit(self, key: str, gid: str, uid: str, count: int) -> None:
        name = self._gift_name(gid) or "礼物"
        who = names.nickname_of(uid)
        event = {
            "kind": "gift",
            "username": who,
            "user_id": uid,
            "gift": name,
            "gift_id": gid,
            "count": int(count),
            "value": 0.0,                     # 价格交给上层按名字兜底
            "event_id": f"mate-{key}-{int(count)}",
            "source": "mate-log",
            "ts": time.time(),
        }
        self.stats["gift"] += 1
        self.stats["last"] = f"{time.strftime('%H:%M:%S')} {who} 送 {name}×{count}（giftId={gid}）"
        self.log("直播伴侣日志抓到礼物：" + self.stats["last"])
        try:
            self.emit(event)
        except Exception as exc:
            self._note_error(f"礼物事件投递失败：{exc}")

    def _note_error(self, text: str) -> None:
        self.stats["errors"] = (self.stats["errors"] + [str(text)[:160]])[-3:]

    # ---- 主循环 ----
    def run(self) -> None:
        while not self._stop.is_set():
            try:
                newest = self._newest()
                if newest is None:
                    self._stop.wait(self.poll)
                    continue
                if self._fh is None or self._path is None or newest != self._path:
                    self._open(newest)
                chunk = self._fh.read()
                if chunk:
                    self._buf += chunk
                    *lines, self._buf = self._buf.split("\n")
                    for line in lines:
                        if line and line not in self._seen_lines:
                            self._handle_line(line)
                            if len(self._seen_lines) < 5000:
                                self._seen_lines.add(line)
                    if len(self._seen_lines) >= 5000:
                        self._seen_lines.clear()
                self._flush_idle()
            except Exception as exc:              # 任何异常都不能把线程带走
                self._note_error(f"{type(exc).__name__}: {exc}")
            self._stop.wait(self.poll)

    def stop(self) -> None:
        self._stop.set()
        try:
            if self._fh:
                self._fh.close()
        except OSError:
            pass


def status() -> dict:
    cfg_path = DEFAULT_DIR
    return {"dir": str(cfg_path), "exists": cfg_path.exists(), "names": names.stats()}
