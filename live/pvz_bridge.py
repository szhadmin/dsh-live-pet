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
    'started_at': 0,
}


def build_server(port, menubar, constants):
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
    parser.add_argument('--no-topmost', action='store_true')
    args = parser.parse_args()

    root = os.path.abspath(args.game_root)
    os.chdir(root)
    if root not in sys.path:
        sys.path.insert(0, root)

    x, y = args.pos.split(',')
    os.environ['SDL_VIDEO_WINDOW_POS'] = '%s,%s' % (x.strip(), y.strip())

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

    # 0) 窗口钉在最上面 + 改个标题，不然会被别的程序盖住。
    #    注意：pygame/SDL 只能在主线程摸，所以 hwnd 在这里取一次，
    #    之后后台线程只用 Win32（纯 ctypes），不然会把游戏线程卡死。
    import ctypes

    pos_x, pos_y = [int(v) for v in args.pos.split(',')]
    HWND_TOPMOST = -1
    SWP_NOSIZE = 0x0001
    SWP_SHOWWINDOW = 0x0040
    try:
        hwnd = int(pg.display.get_wm_info().get('window') or 0)
    except Exception:  # noqa: BLE001
        hwnd = 0

    def pin_once():
        if hwnd == 0:
            return
        try:
            ctypes.windll.user32.ShowWindow(hwnd, 5)  # SW_SHOW：父进程用 SW_HIDE 起我们时窗口是隐藏的
            ctypes.windll.user32.SetWindowPos(hwnd, HWND_TOPMOST, pos_x, pos_y, 0, 0, SWP_NOSIZE | SWP_SHOWWINDOW)
        except Exception:  # noqa: BLE001
            pass

    def keep_visible():
        # 前 8 秒反复确认窗口是显示状态（启动方式不同，首个窗口可能被建出来就是隐藏的）
        for _ in range(16):
            pin_once()
            time.sleep(0.5)

    pin_once()
    try:
        pg.display.set_caption('植物大战僵尸 · 小海豚在打')
    except Exception:  # noqa: BLE001
        pass
    if not args.no_topmost:
        threading.Thread(target=keep_visible, daemon=True).start()

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

    server, _ = build_server(args.port, menubar, c)
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
