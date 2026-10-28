"""路径解析：开发环境 / 打包成 exe 之后两套规则。

- CODE_DIR：只读资源（web、gifs、vendor）。打包后是 PyInstaller 解压出来的 _MEIPASS。
- BASE_DIR：可写数据（data、settings.json、songs）。打包后是 exe 所在目录。

这样 exe 可以放在任何地方双击运行，配置/记忆/曲库都长在 exe 旁边。
"""
from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path

FROZEN = bool(getattr(sys, "frozen", False))

_SRC_ROOT = Path(__file__).resolve().parent.parent
CODE_DIR = Path(getattr(sys, "_MEIPASS", _SRC_ROOT))
BASE_DIR = Path(sys.executable).resolve().parent if FROZEN else _SRC_ROOT

# 可写根目录覆盖：DSH 插件托管的独立实例用这个跑，自己的 settings/data/songs/logs
# 落在指定目录，和主服务完全隔离。不设置时行为与以前完全一致。
_ENV_BASE_DIR = (os.environ.get("FATWHALE_BASE_DIR") or "").strip()
if _ENV_BASE_DIR:
    BASE_DIR = Path(_ENV_BASE_DIR).expanduser().resolve()

DATA_DIR = BASE_DIR / "data"
SONGS_DIR = BASE_DIR / "songs"
SETTINGS_FILE = BASE_DIR / "settings.json"
WEB_DIR = CODE_DIR / "web"
VENDOR_DIR = CODE_DIR / "vendor"
LOG_DIR = BASE_DIR / "logs"

# 动图：优先用 exe 旁边的（用户可替换），没有就用包里自带的
GIFS_DIR = BASE_DIR / "gifs" if (BASE_DIR / "gifs").exists() else CODE_DIR / "gifs"


def ensure_user_files() -> None:
    """首次运行时把随包默认配置 / 曲库 / 动图铺到 exe 旁边。"""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    SONGS_DIR.mkdir(parents=True, exist_ok=True)
    if not FROZEN:
        return

    seed_settings = CODE_DIR / "defaults" / "settings.json"
    if not SETTINGS_FILE.exists() and seed_settings.exists():
        shutil.copy2(seed_settings, SETTINGS_FILE)

    seed_songs = CODE_DIR / "defaults" / "songs"
    if seed_songs.exists():
        for item in seed_songs.iterdir():
            target = SONGS_DIR / item.name
            if not target.exists():
                try:
                    shutil.copy2(item, target)
                except OSError:
                    pass
