/**
 * dsh-live-pet 独立应用（exe）的宿主。
 *
 * 目标：不装 DSH 也能一键启动——双击 exe 就有宠物窗口 + 设置界面。
 *
 * 做法：把插件那套宿主逻辑（../index.js）原样挂到自己的 HTTP 服务上，
 * 只是不再依赖 DSH 的 ctx，而是给一个最小的 ctx 垫片：
 *   ctx.webServer.getOrigin() / ctx.webServer.register({handler}) / ctx.effect(fn)
 * 这样插件和 exe 用的是同一份代码，行为不会有第二套。
 *
 * 资源（frames / bg / live / profile / pet.ps1 / settings.html）在打包时压进 exe，
 * 首次运行时解到 %LOCALAPPDATA%\dsh-live-pet\app 下，之后直接复用。
 */
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/* 打包时由 esbuild --define 注入 */
const IS_SEA = typeof __IS_SEA__ === 'boolean' ? __IS_SEA__ : false
/** 资源解包布局版本：改了资源结构（新增/重命名目录）就 +1，强制重新解包 */
const ASSET_LAYOUT = '2026-10-31a'
/** 应用版本：解包后从 resources/package.json 读，读不到就是 dev */
let APP_VERSION = 'dev'

/**
 * 数据目录：默认 %LOCALAPPDATA%\dsh-live-pet。
 * 有些机器上（杀软拦截、受控文件夹访问、非管理员账户）这里写不进去，
 * 那就按顺序退到 %TEMP%\dsh-live-pet、exe 同目录 dsh-live-pet-data，保证双击一定能起来。
 * 也可以用环境变量 DSH_LIVE_PET_DATA 自己指定。
 */
function pickAppHome() {
  const candidates = []
  const fromEnv = String(process.env.DSH_LIVE_PET_DATA || '').trim()
  if (fromEnv !== '') candidates.push(fromEnv)
  candidates.push(join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'dsh-live-pet'))
  candidates.push(join(process.env.TEMP || process.env.TMP || homedir(), 'dsh-live-pet'))
  try { candidates.push(join(dirname(process.execPath), 'dsh-live-pet-data')) } catch { /* 拿不到 exe 路径就算了 */ }
  for (const dir of candidates) {
    try {
      mkdirSync(dir, { recursive: true })
      const probe = join(dir, '.write-test')
      writeFileSync(probe, 'ok')
      rmSync(probe, { force: true })
      return dir
    } catch { /* 试下一个 */ }
  }
  return candidates[candidates.length - 1]
}

const APP_HOME = pickAppHome()
const RUNTIME_DIR = join(APP_HOME, 'app')
const LOG_FILE = join(APP_HOME, 'app.log')
/** %LOCALAPPDATA% 写不进去时（权限 / 杀软占用）日志退到这里，方便排查 */
const FALLBACK_LOG_DIR = join(process.env.TEMP || process.env.TMP || homedir(), 'dsh-live-pet-logs')
const FALLBACK_LOG = join(FALLBACK_LOG_DIR, 'app.log')

function log(message) {
  const line = `${new Date().toISOString().slice(11, 19)} ${message}`
  try {
    mkdirSync(APP_HOME, { recursive: true })
    writeFileSync(LOG_FILE, `${line}\n`, { flag: 'a' })
  } catch {
    try {
      mkdirSync(FALLBACK_LOG_DIR, { recursive: true })
      writeFileSync(FALLBACK_LOG, `${line}\n`, { flag: 'a' })
    } catch { /* 日志写不了也要继续跑 */ }
  }
  process.stdout.write(`${line}\n`)
}

/* ---------------------------------------------------------------- 资源解包 */

/** SEA 里取内嵌的 assets.zip；不是 SEA（开发态直接 node app/main.js）就返回 null。 */
async function readEmbeddedAssets() {
  if (!IS_SEA) return null
  try {
    const sea = await import('node:sea')
    if (typeof sea.getAsset !== 'function') return null
    const asset = sea.getAsset('assets.zip')
    return Buffer.from(asset)
  } catch (error) {
    log(`读取内嵌资源失败: ${error && error.message ? error.message : error}`)
    return null
  }
}

function unzip(zipFile, destDir) {
  mkdirSync(destDir, { recursive: true })
  // Windows 10+ 自带 bsdtar，能直接解 zip
  const tar = spawnSync('tar', ['-xf', zipFile, '-C', destDir], { windowsHide: true })
  if (tar.status === 0) return true
  const ps = spawnSync('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
    `Expand-Archive -LiteralPath '${zipFile.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`,
  ], { windowsHide: true })
  return ps.status === 0
}

/** 确保资源目录存在且是最新版；返回资源根目录。 */
async function ensureAssets() {
  const marker = join(RUNTIME_DIR, '.version')
  const current = existsSync(marker) ? String(readFileSync(marker, 'utf8')).trim() : ''
  if (current === ASSET_LAYOUT && existsSync(join(RUNTIME_DIR, 'pet.ps1'))) return RUNTIME_DIR

  const embedded = await readEmbeddedAssets()
  if (embedded === null) {
    // 开发态：直接用仓库目录
    const devHome = process.env.DSH_LIVE_PET_HOME || join(process.cwd())
    log(`开发模式，资源目录 ${devHome}`)
    return devHome
  }
  log(`解包内嵌资源 -> ${RUNTIME_DIR} (${(embedded.length / 1024 / 1024).toFixed(1)}MB)`)
  let zipFile = join(APP_HOME, 'assets.zip')
  mkdirSync(APP_HOME, { recursive: true })
  // 杀软实时扫描 / 目录被占用时 writeFileSync 偶尔报 EPERM：重试几次，还不行就写到 %TEMP%
  let wrote = false
  for (let attempt = 0; attempt < 4 && !wrote; attempt += 1) {
    try {
      writeFileSync(zipFile, embedded)
      wrote = true
    } catch (error) {
      log(`写资源包失败（第 ${attempt + 1} 次）：${error && error.code ? error.code : error}`)
      if (attempt === 2) {
        zipFile = join(process.env.TEMP || process.env.TMP || homedir(), 'dsh-live-pet-assets.zip')
        log(`改写到 ${zipFile}`)
      }
      spawnSync('cmd', ['/c', 'ping', '-n', '2', '127.0.0.1'], { windowsHide: true })
    }
  }
  if (!wrote) throw new Error(`资源包写不进去：${zipFile}`)
  if (!unzip(zipFile, RUNTIME_DIR)) {
    throw new Error(`解包失败：${zipFile}`)
  }
  try { rmSync(zipFile, { force: true }) } catch { /* 留着也无所谓 */ }
  writeFileSync(marker, ASSET_LAYOUT, 'utf8')
  return RUNTIME_DIR
}

/** 应用版本（资源里带的 package.json） */
function readAppVersion(assetDir) {
  try {
    const pkg = JSON.parse(readFileSync(join(assetDir, 'package.json'), 'utf8').replace(/^\uFEFF/, ''))
    if (pkg && typeof pkg.version === 'string' && pkg.version.trim() !== '') return pkg.version.trim()
  } catch { /* 没有就算了 */ }
  return 'dev'
}

/* ---------------------------------------------------------------- 主流程 */

/** 用 Edge 的应用窗口打开设置页；没有 Edge 就丢给默认浏览器 */
function openWindow(url) {
  const candidates = [
    join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ]
  const edge = candidates.find((file) => existsSync(file))
  try {
    if (edge) {
      spawn(edge, [`--app=${url}`, '--window-size=1120,900'], { detached: true, stdio: 'ignore' }).unref()
    } else {
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
    }
    log(`设置窗口已打开：${url}`)
  } catch (error) {
    log(`打开设置窗口失败：${error && error.message ? error.message : error}（手动打开 ${url}）`)
  }
}

/** 探测已在运行的实例：返回它的 origin，没有就返回 '' */
async function findRunning(wantedPort) {
  const base = Number(wantedPort) || 8899
  for (let port = base; port <= base + 10; port += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(600) })
      if (!response.ok) continue
      const info = await response.json()
      if (info && info.app === 'dsh-live-pet') return `http://127.0.0.1:${port}`
    } catch { /* 这个端口没人 */ }
  }
  return ''
}

async function main() {
  const assetDir = await ensureAssets()
  APP_VERSION = readAppVersion(assetDir)
  // index.js 在模块加载时就算 PKG_DIR，所以必须在 import 之前设置
  process.env.DSH_LIVE_PET_HOME = assetDir
  mkdirSync(APP_HOME, { recursive: true })

  const configFile = join(assetDir, 'config.json')
  const readConfig = () => {
    try {
      return JSON.parse(readFileSync(configFile, 'utf8').replace(/^\uFEFF/, ''))
    } catch {
      return {}
    }
  }
  const wanted = Number(readConfig().appPort) || 8899

  // 已经有一份在跑了：再点一次 exe 就只把设置页弹出来，不要开第二只宠物
  const running = await findRunning(wanted)
  if (running !== '') {
    log(`已有实例在跑：${running}，只打开设置页`)
    openWindow(`${running}/`)
    return
  }

  /* ---- 起 HTTP 服务 ---- */
  const plugin = await import('../index.js')
  if (typeof plugin.apply !== 'function') throw new Error('index.js 没有导出 apply()')

  const handlers = []
  const disposers = []
  let origin = ''
  const appRoutes = {
    '/': serveSettings,
    '/settings': serveSettings,
    '/health': (req, res) => sendJson(res, { ok: true, app: 'dsh-live-pet', version: APP_VERSION, home: assetDir, origin }),
  }

  function sendJson(res, value) {
    const body = Buffer.from(JSON.stringify(value), 'utf8')
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store' })
    res.end(body)
  }

  function serveSettings(req, res) {
    const file = join(assetDir, 'app', 'settings.html')
    let html = ''
    try {
      html = readFileSync(file, 'utf8')
    } catch (error) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(`设置页缺失：${file}`)
      return
    }
    const body = Buffer.from(html + `\n<!-- v${APP_VERSION} -->`, 'utf8')
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store' })
    res.end(body)
  }

  const server = createServer((req, res) => {
    const url = typeof req.url === 'string' ? req.url : '/'
    const path = url.split('?')[0].replace(/\/+$/, '') || '/'
    const route = appRoutes[path]
    if (route) {
      try {
        route(req, res)
      } catch (error) {
        sendJson(res, { ok: false, error: String(error && error.message ? error.message : error) })
      }
      return
    }
    for (const entry of handlers) {
      if (path === entry.path || path.startsWith(`${entry.path}/`)) {
        Promise.resolve(entry.handler(req, res)).catch((error) => {
          log(`handler 出错 ${path}: ${error && error.message ? error.message : error}`)
          try { res.writeHead(500); res.end('error') } catch { /* 已经发出去了 */ }
        })
        return
      }
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('not found')
  })

  const port = await new Promise((resolve, reject) => {
    let attempt = wanted
    const tryListen = () => {
      server.once('error', (error) => {
        if (error && error.code === 'EADDRINUSE' && attempt < wanted + 10) {
          attempt += 1
          setImmediate(tryListen)
          return
        }
        reject(error)
      })
      server.listen(attempt, '127.0.0.1', () => resolve(attempt))
    }
    tryListen()
  })

  origin = `http://127.0.0.1:${port}`
  log(`dsh-live-pet ${APP_VERSION} 起来了：${origin}（资源 ${assetDir}）`)

  /* ---- 给 index.js 的最小 ctx 垫片 ---- */
  const ctx = {
    webServer: {
      getOrigin: () => origin,
      register: (options) => {
        handlers.push(options)
        return () => {
          const index = handlers.indexOf(options)
          if (index >= 0) handlers.splice(index, 1)
        }
      },
    },
    effect: (fn) => {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
  }

  plugin.apply(ctx)

  /* ---- 打开设置窗口（Edge --app，没有 Edge 就用默认浏览器） ---- */
  // 第一次跑（还没 config.json）就把设置页摊开；之后只开宠物窗口
  if (!existsSync(configFile)) {
    log('首次启动：打开设置页')
    setTimeout(() => openWindow(`${origin}/`), 1500)
  }

  function shutdown(reason) {
    log(`退出（${reason}）`)
    for (const dispose of disposers) {
      try { dispose() } catch { /* 清理失败也继续 */ }
    }
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 3000).unref()
  }

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('uncaughtException', (error) => log(`UNCAUGHT: ${error && error.stack ? error.stack : error}`))
  process.on('unhandledRejection', (error) => log(`UNHANDLED: ${error && error.stack ? error.stack : error}`))
  // 注意：不要监听 stdin 的 end —— 双击启动/重定向时 stdin 一关就退出，
  // 那样子进程会跟着一起被回收。退出只走 Ctrl+C（SIGINT）或任务管理器。

  // 兜底的自检：资源目录关键文件在不在
  for (const need of ['pet.ps1', 'frames', 'bg', 'live']) {
    if (!existsSync(join(assetDir, need))) log(`警告：资源目录缺 ${need}`)
  }
  log(`宠物窗口/直播服务状态见 ${join(assetDir, 'live-pet.log')}`)
}

/** 双击启动时控制台立刻关掉：把失败原因弹出来，别让用户一脸茫然 */
function showFatal(error) {
  const message = error && error.message ? error.message : String(error)
  const hint = [
    `启动失败：${message}`,
    '',
    `日志：${LOG_FILE}`,
    `（若该目录写不进去，日志在 ${FALLBACK_LOG}）`,
    '',
    '常见原因：杀毒软件拦截、%LOCALAPPDATA% 没写权限、端口被占用。',
    '可以先删掉下面这个目录再试：' + APP_HOME,
  ].join(String.fromCharCode(13, 10))
  try {
    const escaped = hint.replace(/'/g, "''")
    spawnSync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-Command',
      `Add-Type -AssemblyName System.Windows.Forms | Out-Null; [System.Windows.Forms.MessageBox]::Show('${escaped}', 'dsh-live-pet 启动失败') | Out-Null`,
    ], { windowsHide: true })
  } catch { /* 弹不出来就靠日志 */ }
}

main().catch((error) => {
  log(`启动失败：${error && error.stack ? error.stack : error}`)
  process.exitCode = 1
  showFatal(error)
})
