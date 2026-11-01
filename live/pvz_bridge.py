"""小海豚的「植物大战僵尸」外挂大脑接口（bridge）。

上游游戏：marblexu/PythonPlantsVsZombies（真实素材的 PvZ 复刻）。
这个脚本做的事：
  1. 用真实游戏窗口跑起来（原版素材、原版手感），跳过主菜单直接开打；
  2. 把「当前局面」用 HTTP 暴露出去（阳光、植物、僵尸、卡片冷确）；
  3. 接收命令（种什么、种哪格、收阳光），在游戏线程里执行 —— 相当于有一双手在玩。

用法（必须用游戏目录做 cwd 或者给 --game-root）：
    python pvz_bridge.py --game-root <dir> --port 8793 --level 1
接口：
    GET  /state   -> 局面 JSON
    POST /cmd     -> {"action":"plant","name":"SunFlower","col":1,"row":2}
                     {"action":"collect"}         收掉场上所有阳光
                     {"action":"quit"}            退出游戏
"""

import argparse
import io
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

GAME = {
    'level': None,        # 当前 Level 实例
    'control': None,      # tool.Control 实例
    'queue': [],          # 待执行命令（在游戏线程里跑）
    'target': None,       # 临时告诉 canSeedPlant 该落在哪一格
    'error': '',
    'last_cmd': '',
    'win': {},            # 窗口挂到哪一层了（调试用）
    'started_at': 0,
}


def build_server(port, menubar, constants, grab_frame):
    plant_names = menubar.plant_name_list

    def snapshot():
        level = GAME['level']
        control = GAME['control']
        if level is None:
            return {'ready': False, 'error': GAME['error']}
        sun_value = getattr(getattr(level, 'menubar', None), 'sun_value', 0)
        plants = []
        for row in range(level.map.height):
            group = level.plant_groups[row] if level.plant_groups else []
            for sprite in group:
                plants.append({
                    'name': getattr(sprite, 'name', ''),
                    'row': row,
                    'col': int((sprite.rect.centerx - constants.MAP_OFFSET_X) // constants.GRID_X_SIZE),
                    'x': sprite.rect.x,
                })
        zombies = []
        for row in range(level.map.height):
            for sprite in level.zombie_groups[row]:
                zombies.append({
                    'name': getattr(sprite, 'name', ''),
                    'row': row,
                    'x': sprite.rect.x,
                    'health': getattr(sprite, 'health', 0),
                })
        cards = []
        for card in getattr(level.menubar, 'card_list', []):
            cards.append({
                'name': plant_names[card.name_index],
                'cost': card.sun_cost,
                'ready': bool(card.canClick(sun_value, getattr(level, 'current_time', 0))),
            })
        state_name = getattr(control, 'state_name', '') if control else ''
        return {
            'ready': True,
            'sun': sun_value,
            'suns_on_lawn': len(level.sun_group),
            'plants': plants,
            'zombies': zombies,
            'cards': cards,
            'grid': level.map.map,
            'playing': getattr(level, 'state', '') == constants.PLAY,
            'screen': state_name,
            'victory': state_name == constants.GAME_VICTORY,
            'lose': state_name == constants.GAME_LOSE,
            'error': GAME['error'],
            'last_cmd': GAME['last_cmd'],
            'win': GAME.get('win', {}),
        }

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):  # 别把访问日志刷进 stderr
            pass

        def _send(self, payload, code=200):
            body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
            self.send_response(code)
            self.send_header('content-type', 'application/json; charset=utf-8')
            self.send_header('content-length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if self.path.startswith('/state'):
                try:
                    self._send(snapshot())
                except Exception as exc:  # noqa: BLE001
                    self._send({'ready': False, 'error': repr(exc)}, 500)
                return
            if self.path.startswith('/frame.png'):
                # 把游戏画面裁成调用方要的比例，给宠物窗口当背景板用
                try:
                    query = {}
                    if '?' in self.path:
                        for part in self.path.split('?', 1)[1].split('&'):
                            if '=' in part:
                                k, v = part.split('=', 1)
                                query[k] = v
                    width = max(80, min(1600, int(float(query.get('w', '320')))))
                    height = max(60, min(1200, int(float(query.get('h', '400')))))
                    bias = max(0.0, min(1.0, float(query.get('bias', '0.55'))))
                    data = grab_frame(width, height, bias)
                    if data is None:
                        self._send({'ok': False, 'error': 'no surface'}, 503)
                        return
                    self.send_response(200)
                    self.send_header('content-type', 'image/jpeg')
                    self.send_header('cache-control', 'no-store')
                    self.send_header('content-length', str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                except BrokenPipeError:
                    pass
                except Exception as exc:  # noqa: BLE001
                    self._send({'ok': False, 'error': repr(exc)}, 500)
                return
            if self.path.startswith('/health'):
                self._send({'ok': True})
                return
            self._send({'ok': False, 'error': 'unknown path'}, 404)

        def do_POST(self):
            try:
                length = int(self.headers.get('content-length') or 0)
                raw = self.rfile.read(length) if length else b'{}'
                cmd = json.loads(raw.decode('utf-8') or '{}')
            except Exception as exc:  # noqa: BLE001
                self._send({'ok': False, 'error': 'bad json: %r' % exc}, 400)
                return
            action = str(cmd.get('action') or '')
            if action == 'quit':
                self._send({'ok': True})
                threading.Thread(target=_quit_soon, daemon=True).start()
                return
            GAME['queue'].append(cmd)
            self._send({'ok': True, 'queued': len(GAME['queue'])})

    return ThreadingHTTPServer(('127.0.0.1', port), Handler), snapshot


def _quit_soon():
    import time
    time.sleep(0.2)
    os._exit(0)


def apply_cmd(level, menubar, constants, cmd):
    """在游戏线程里执行一条命令。"""
    action = str(cmd.get('action') or '')
    GAME['last_cmd'] = action

    if action == 'collect':
        gained = 0
        for sun in list(level.sun_group):
            if sun.checkCollision(sun.rect.centerx, sun.rect.centery):
                gained += sun.sun_value
                level.menubar.increaseSunValue(sun.sun_value)
        GAME['last_cmd'] = 'collect +%d' % gained
        return

    if action == 'plant':
        name = str(cmd.get('name') or '')
        col = int(cmd.get('col'))
        row = int(cmd.get('row'))
        if not (0 <= row < level.map.height and 0 <= col < level.map.width):
            raise RuntimeError('格子越界')
        if level.map.map[row][col] != constants.MAP_EMPTY:
            raise RuntimeError('格子被占')
        card = None
        for item in level.menubar.card_list:
            if menubar.plant_name_list[item.name_index] == name:
                card = item
                break
        if card is None:
            raise RuntimeError('没这张卡：%s' % name)
        if not card.canClick(level.menubar.sun_value, level.current_time):
            raise RuntimeError('阳光不够或冷却中：%s' % name)
        picked = level.menubar.checkCardClick(card.rect.center)
        if not picked:
            raise RuntimeError('卡片点不动：%s' % name)
        level.setupMouseImage(picked[0], picked[1])
        GAME['target'] = (col, row)
        try:
            level.addPlant()
        finally:
            GAME['target'] = None
        GAME['last_cmd'] = 'plant %s @%d,%d' % (name, col, row)
        return

    raise RuntimeError('未知动作：%s' % action)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--game-root', default='.')
    parser.add_argument('--port', type=int, default=8793)
    parser.add_argument('--level', type=int, default=1)
    parser.add_argument('--pos', default='1080,180')
    parser.add_argument('--cards', default='0,1,3,4')
    parser.add_argument('--layer', default='desktop',
                        choices=['desktop', 'wallpaper', 'topmost', 'window', 'background', 'offscreen'])
    parser.add_argument('--width', type=int, default=800)
    parser.add_argument('--height', type=int, default=600)
    parser.add_argument('--no-topmost', action='store_true')
    args = parser.parse_args()
    if args.no_topmost:
        args.layer = 'desktop'
    if args.layer == 'window':
        args.layer = 'desktop'
    if args.layer == 'background':
        args.layer = 'wallpaper'

    root = os.path.abspath(args.game_root)
    os.chdir(root)
    if root not in sys.path:
        sys.path.insert(0, root)

    x, y = args.pos.split(',')
    os.environ['SDL_VIDEO_WINDOW_POS'] = '%s,%s' % (x.strip(), y.strip())
    if args.layer == 'offscreen':
        # 不出自己的窗口，把画面交给宠物窗口当背景（dummy 驱动：照样渲染，只是不显示）
        os.environ['SDL_VIDEODRIVER'] = 'dummy'

    import time
    import pygame as pg  # noqa: F401  (本文件顶部已确认可用)

    # pygame 2.6 在 Windows 上扫系统字体时会炸（splitext(int)），这里换成默认字体
    def _safe_sysfont(name, size, *a, **k):
        try:
            return pg.font.Font(None, int(size))
        except Exception:  # noqa: BLE001
            return pg.font.Font(None, 20)

    pg.font.SysFont = _safe_sysfont

    from source import tool, constants as c
    from source.state import level as level_mod, mainmenu, screen
    from source.component import menubar

    card_indices = [int(part) for part in str(args.cards).split(',') if part.strip() != '']

    # 0) 窗口摆法：background＝塞进桌面壁纸层（在图标后面，当桌面背景）
    #    window＝普通窗口，topmost＝钉在最上面。
    #    注意：pygame/SDL 只能在主线程摸，所以 hwnd 在这里取一次，
    #    之后后台线程只用 Win32（纯 ctypes），不然会把游戏线程卡死。
    import ctypes
    from ctypes import wintypes

    user32 = ctypes.windll.user32
    pos_x, pos_y = [int(v) for v in args.pos.split(',')]
    HWND_TOPMOST = -1
    HWND_NOTOPMOST = -2
    HWND_BOTTOM = 1
    SWP_NOSIZE = 0x0001
    SWP_NOACTIVATE = 0x0010
    SWP_SHOWWINDOW = 0x0040
    WS_CHILD = 0x40000000
    WS_VISIBLE = 0x10000000
    WS_POPUP = 0x80000000
    WS_CAPTION_BITS = 0x00C00000   # WS_BORDER | WS_DLGFRAME
    WS_EX_NOACTIVATE = 0x08000000
    WS_EX_TOOLWINDOW = 0x00000080
    WS_EX_APPWINDOW = 0x00040000
    GWL_STYLE = -16
    GWL_EXSTYLE = -20
    try:
        hwnd = int(pg.display.get_wm_info().get('window') or 0)
    except Exception:  # noqa: BLE001
        hwnd = 0

    # Win32 原型（64 位下不声明 restype 会把 HWND 截断成 int，直接找不到窗口）
    user32.FindWindowW.restype = wintypes.HWND
    user32.FindWindowW.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR]
    user32.FindWindowExW.restype = wintypes.HWND
    user32.FindWindowExW.argtypes = [wintypes.HWND, wintypes.HWND, wintypes.LPCWSTR, wintypes.LPCWSTR]
    user32.EnumWindows.argtypes = [ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM), wintypes.LPARAM]
    user32.SendMessageTimeoutW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM,
                                           wintypes.UINT, wintypes.UINT, ctypes.POINTER(ctypes.c_ulonglong)]
    user32.GetWindowLongW.argtypes = [wintypes.HWND, ctypes.c_int]
    user32.SetWindowLongW.argtypes = [wintypes.HWND, ctypes.c_int, ctypes.c_long]
    user32.SetParent.argtypes = [wintypes.HWND, wintypes.HWND]
    user32.SetWindowPos.argtypes = [wintypes.HWND, wintypes.HWND, ctypes.c_int, ctypes.c_int,
                                    ctypes.c_int, ctypes.c_int, wintypes.UINT]
    user32.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
    user32.IsWindowVisible.argtypes = [wintypes.HWND]
    user32.GetParent.argtypes = [wintypes.HWND]
    user32.GetParent.restype = wintypes.HWND
    user32.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]

    wallpaper = {'layer': 0, 'spawned': False, 'warned': False}

    def screen_area():
        return int(user32.GetSystemMetrics(0)) * int(user32.GetSystemMetrics(1))

    def pick_workerw_under_icons():
        """在 Progman 的子窗口里挑“图标后面那层 WorkerW”：可见 + 铺满屏幕。"""
        progman = user32.FindWindowW('Progman', None)
        if not progman:
            return 0
        if not wallpaper['spawned']:
            # 只踢一次：让 explorer 生成 WorkerW（多踢几次会生出一堆没用的 WorkerW）
            for lparam in (0, 1):
                user32.SendMessageTimeoutW(progman, 0x052C, 0xD, lparam, 0, 2000, None)
            wallpaper['spawned'] = True
        need = screen_area() * 0.5
        child = user32.FindWindowExW(progman, None, 'WorkerW', None)
        while child:
            rect = wintypes.RECT()
            user32.GetWindowRect(child, ctypes.byref(rect))
            area = (rect.right - rect.left) * (rect.bottom - rect.top)
            if user32.IsWindowVisible(child) and area >= need:
                return child
            child = user32.FindWindowExW(progman, child, 'WorkerW', None)
        return 0

    def find_wallpaper_layer():
        """桌面图标后面那层 WorkerW：塞进去就是“桌面壁纸”。

        本机（Win11）布局：Progman -> [SHELLDLL_DefView, WorkerW]
        老布局：顶层某窗口挂着 SHELLDLL_DefView，它后面紧跟一个 WorkerW
        """
        try:
            worker = pick_workerw_under_icons()
            if worker:
                return worker
            found = []

            @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
            def callback(win, _):
                if user32.FindWindowExW(win, None, 'SHELLDLL_DefView', None):
                    sibling = user32.FindWindowExW(None, win, 'WorkerW', None)
                    if sibling:
                        found.append(sibling)
                return True

            user32.EnumWindows(callback, 0)
            return found[0] if found else 0
        except Exception as exc:  # noqa: BLE001
            print('[pvz] find layer failed: %r' % (exc,), flush=True)
            return 0

    def to_background():
        """子窗口方式挂到壁纸层：图标在上、别的窗口也在上，游戏就在桌面背景里跑。"""
        if hwnd == 0:
            return False
        layer = find_wallpaper_layer()
        if not layer:
            print('[pvz] no WorkerW layer found, fallback to bottom window', flush=True)
            return False
        if int(user32.GetParent(hwnd) or 0) != int(layer):
            style = user32.GetWindowLongW(hwnd, GWL_STYLE)
            user32.SetWindowLongW(hwnd, GWL_STYLE, (int(style) & ~0x80C00000) | WS_CHILD | WS_VISIBLE)
            prev = user32.SetParent(hwnd, layer)
            print('[pvz] reparent -> WorkerW %s (prev %s)' % (layer, prev), flush=True)
        user32.ShowWindow(hwnd, 5)
        user32.SetWindowPos(hwnd, 0, pos_x, pos_y, int(args.width), int(args.height), SWP_SHOWWINDOW | SWP_NOACTIVATE)
        visible = bool(user32.IsWindowVisible(hwnd))
        GAME['win'] = {'mode': 'background', 'hwnd': int(hwnd), 'parent': int(layer), 'visible': visible,
                       'x': pos_x, 'y': pos_y, 'w': int(args.width), 'h': int(args.height)}
        if not visible and not wallpaper['warned']:
            wallpaper['warned'] = True
            print('[pvz] still hidden after reparent (parent not visible?)', flush=True)
        return True

    def as_window(topmost):
        """普通窗口：topmost=盖在最上面；否则无边框 + 不进任务栏 + 不吃焦点 + 压到最底层（当桌面背景）。"""
        if hwnd == 0:
            return
        try:
            if not topmost:
                ex = user32.GetWindowLongW(hwnd, GWL_EXSTYLE)
                user32.SetWindowLongW(hwnd, GWL_EXSTYLE, (int(ex) | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW) & ~WS_EX_APPWINDOW)
                style = user32.GetWindowLongW(hwnd, GWL_STYLE)
                user32.SetWindowLongW(hwnd, GWL_STYLE, (int(style) & ~WS_CAPTION_BITS) | WS_POPUP | WS_VISIBLE)
            user32.ShowWindow(hwnd, 5)  # SW_SHOW：父进程用 SW_HIDE 起我们时窗口是隐藏的
            user32.SetWindowPos(hwnd, HWND_TOPMOST if topmost else HWND_BOTTOM, pos_x, pos_y,
                                int(args.width), int(args.height), SWP_SHOWWINDOW | SWP_NOACTIVATE)
            GAME['win'] = {'mode': 'topmost' if topmost else 'desktop', 'hwnd': int(hwnd), 'parent': 0,
                           'visible': bool(user32.IsWindowVisible(hwnd)),
                           'x': pos_x, 'y': pos_y, 'w': int(args.width), 'h': int(args.height)}
        except Exception as exc:  # noqa: BLE001
            print('[pvz] place window failed: %r' % (exc,), flush=True)

    def place():
        if args.layer == 'topmost':
            as_window(True)
            return
        if args.layer == 'wallpaper' and to_background() and user32.IsWindowVisible(hwnd):
            return
        as_window(False)  # 默认：无边框、压在所有窗口下面 → 相当于桌面背景

    def keep_visible():
        # 前 8 秒反复确认（有的启动方式会把首个窗口建成隐藏的；explorer 也可能重建 WorkerW）
        for _ in range(16):
            place()
            time.sleep(0.5)

    if args.layer != 'offscreen':
        place()
        try:
            pg.display.set_caption('植物大战僵尸 · 小海豚在打')
        except Exception:  # noqa: BLE001
            pass
        threading.Thread(target=keep_visible, daemon=True).start()

    def grab_frame(width, height, bias):
        """裁一块当前画面、缩到指定尺寸，编码成 PNG（给宠物窗口当背景板）。"""
        surface = pg.display.get_surface()
        if surface is None:
            return None
        sw, sh = surface.get_size()
        ratio = float(width) / float(height)
        crop_h = sh
        crop_w = int(round(sh * ratio))
        if crop_w > sw:
            crop_w = sw
            crop_h = int(round(sw / ratio))
        left = int(round((sw - crop_w) * min(1.0, max(0.0, bias))))
        left = max(0, min(sw - crop_w, left))
        top = max(0, (sh - crop_h) // 2)
        piece = surface.subsurface((left, top, crop_w, crop_h)).copy()
        small = pg.transform.smoothscale(piece, (width, height))
        buffer = io.BytesIO()
        pg.image.save(small, buffer, 'frame.jpg')
        return buffer.getvalue()

    # 1) 跳过选卡，直接开打
    def init_state(self):
        self.bar_type = c.CHOOSEBAR_STATIC
        self.initPlay(card_indices)

    level_mod.Level.initState = init_state

    # 2) 抓住 Level 实例
    orig_startup = level_mod.Level.startup

    def startup(self, current_time, persist):
        persist[c.LEVEL_NUM] = args.level
        orig_startup(self, current_time, persist)
        GAME['level'] = self
        GAME['started_at'] = time.time()

    level_mod.Level.startup = startup

    # 3) 种植物时用接口指定的格子（不依赖真实鼠标）
    orig_can_seed = level_mod.Level.canSeedPlant

    def can_seed(self):
        cell = GAME['target']
        if cell is not None:
            return self.map.getMapGridPos(cell[0], cell[1])
        return orig_can_seed(self)

    level_mod.Level.canSeedPlant = can_seed

    # 4) 命令在游戏线程执行
    orig_play = level_mod.Level.play

    def play(self, mouse_pos, mouse_click):
        while GAME['queue']:
            cmd = GAME['queue'].pop(0)
            try:
                apply_cmd(self, menubar, c, cmd)
                GAME['error'] = ''
            except Exception as exc:  # noqa: BLE001
                GAME['error'] = repr(exc)
        return orig_play(self, mouse_pos, mouse_click)

    level_mod.Level.play = play

    server, _ = build_server(args.port, menubar, c, grab_frame)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    print('bridge listening on 127.0.0.1:%d (level %d)' % (args.port, args.level), flush=True)

    game = tool.Control()
    states = {
        c.MAIN_MENU: mainmenu.Menu(),
        c.GAME_VICTORY: screen.GameVictoryScreen(),
        c.GAME_LOSE: screen.GameLoseScreen(),
        c.LEVEL: level_mod.Level(),
    }
    game.setup_states(states, c.LEVEL)
    GAME['control'] = game
    try:
        game.main()
    finally:
        try:
            pg.quit()
        except Exception:  # noqa: BLE001
            pass


if __name__ == '__main__':
    main()
