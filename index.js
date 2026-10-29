/**
 * dsh-live-pet — Host half.
 *
 * The pet's body and brain:
 *   弹幕 (F:\douyinlive app.py)  →  一条长 DSH 会话（node bin.js <profile> --json）
 *                              →  {say, emotion, action}
 *                              →  Edge-TTS 合成 mp3
 *                              →  /dsh-live-pet/state  ←  桌面宠物窗口轮询
 *
 * Nothing here writes to the live project: danmaku comes from its read-only
 * /api/state, actions go through its own HTTP endpoints, and the DSH session is
 * a separate process so a stuck turn can never block the Harness host.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-live-pet'

/** The web server carries the pet's state route; everything else is optional. */
export const inject = ['webServer']

const PKG_DIR = fileURLToPath(new URL('./', import.meta.url))
const FRAMES_DIR = join(PKG_DIR, 'frames')
const PET_SCRIPT = join(PKG_DIR, 'pet.ps1')
const CONFIG_FILE = join(PKG_DIR, 'config.json')
const SESSION_FILE = join(PKG_DIR, 'session.json')
const LOG_FILE = join(PKG_DIR, 'live-pet.log')

const EMOTIONS = ['happy', 'mischievous', 'crying', 'unhappy', 'eating', 'cooking', 'coding', 'tv', 'walking']

/** Plugin keys the settings page may write. */
const PET_CONFIG_KEYS = [
  'sceneEnabled',
  'sceneImage',
  'bubbleFontSize',
  'poolFontSize',
  'wander',
  'wanderSpeed',
  'wanderDwellMinSec',
  'wanderDwellMaxSec',
  'persona',
  'mode', 'profile', 'manageProfile', 'appUrl', 'pollMs', 'replyKinds',
  'manageLive', 'autoStartLive', 'livePort', 'liveHost', 'liveMode', 'liveBaseDir', 'liveStartTimeoutSec',
  'speak', 'ttsVoice', 'ttsRate', 'ttsPitch',
  'maxChars', 'chatMaxChars', 'maxPerMinute', 'minReplyGapMs', 'timeoutMs',
  'actions', 'giftActionValue', 'stageGiftFx', 'idleChat', 'idleEverySec',
  'chatEnabled', 'autoStartPet', 'petSilent',
  'welcomeEnter', 'welcomeEnterGapSec', 'welcomeEnterPerHour', 'welcomeEnterUserGapSec',
  'thanksGift', 'giftThanksGapSec', 'giftThanksUserGapSec', 'songEmotion', 'queryEmotion', 'allowSkip', 'skipCooldownSec',
  'thanksFollow', 'thanksLike', 'likeThanksGapSec', 'welcomeFast', 'welcomeLine', 'followLine', 'likeLine',
  'giftForcedEmotion', 'giftPoseSec',
]

/** Live-project settings the settings page may write through. */
const LIVE_CONFIG_KEYS = ['douyin', 'songs', 'gift_actions', 'voice', 'rate', 'pitch']

/** Voice of the live project (mirrored so TTS follows the console's setting). */
let liveVoice = null

const DEFAULTS = {
  /** 直播背景：在背景图上铺弹幕池 + 点歌台，宠物只在背景里活动 */
  sceneEnabled: false,
  /** 背景图路径（留空 = 用插件自带的 bg/scene.jpg） */
  sceneImage: '',
  /** 宠物对话气泡字号（直播要看得清） */
  bubbleFontSize: 20,
  /** 场景里弹幕池的字号 */
  poolFontSize: 20,
  /** 自动溜达：自己在桌面上走动、停一会儿、再走 */
  wander: true,
  /** 走路速度（像素/秒） */
  wanderSpeed: 55,
  /** 到地方后歇多久（秒，区间随机） */
  wanderDwellMinSec: 6,
  wanderDwellMaxSec: 18,
  /** 宠物人设（系统提示词）。留空 = 用内置默认人设 */
  persona: '',
  /**
   * External live-project HTTP base. Used only when `manageLive` is off; with it on,
   * the bundle runs and owns a private instance on `livePort` instead.
   */
  appUrl: 'http://127.0.0.1:8790',
  workspace: 'F:\\douyinlive',
  audioDir: 'F:\\douyinlive\\data\\audio',
  pythonBin: 'python',
  /** One-click ownership of a private live-service instance (own port, own data dir). */
  manageLive: true,
  autoStartLive: true,
  livePort: 8791,
  liveHost: '127.0.0.1',
  liveMode: 'live',
  /** Writable root of the managed instance; empty = <package>/live-data. */
  liveBaseDir: '',
  liveStartTimeoutSec: 40,
  /** Explicit paths win; empty means auto-detect (see resolveDsh). */
  dshBin: '',
  nodeBin: '',
  /**
   * DSH profile that owns the persona + tool permissions.
   * `pet` = generated read-only profile (see profile/cordis.patch.tpl.yml);
   * `whale` = the live project's own talk-only profile.
   */
  profile: 'pet',
  /** Let the bundle materialize $DSH_HOME/profiles/<profile> from its template. */
  manageProfile: true,
  /** Fallback model route used when the live project's settings cannot be read. */
  provider: 'buddyhub',
  model: 'deepseek-chat',
  baseUrl: 'https://api.deepseek.com/v1',
  /**
   * auto     — use the raw danmaku feed when the live project offers it, else mirror its replies
   * takeover — only answer danmaku itself (needs the patched app.py /api/feed)
   * mirror   — only project the live project's own replies onto the pet
   */
  mode: 'auto',
  /** LLM key handed to the DSH profile; empty means "read it from the project's settings.json". */
  apiKey: '',
  apiKeyEnv: 'BUDDYHUB_API_KEY',
  sessionKey: 'live-pet',
  sessionTtlHours: 12,
  pollMs: 800,
  replyKinds: ['comment'],
  timeoutMs: 30000,
  maxChars: 70,
  /** The owner's typed questions get room to answer (they may report tool results). */
  chatMaxChars: 240,
  cooldownMs: 1500,
  minReplyGapMs: 1200,
  maxPerMinute: 15,
  speak: true,
  actions: true,
  /** Gift name → action from the live project (转圈/开饭/躺沙发…), performed by the pet. */
  giftActionValue: 0.1,
  /** Also forward the gift to the OBS stage (the live project will thank it in its own voice). */
  stageGiftFx: false,
  /** Talk on its own when nobody speaks for `idleEverySec` seconds. */
  idleChat: true,
  idleEverySec: 150,
  /** Greet people who enter — throttled, it should feel occasional, not a roll call. */
  welcomeEnter: true,
  welcomeEnterGapSec: 45,
  welcomeEnterPerHour: 12,
  welcomeEnterUserGapSec: 1800,
  /** Thank gift senders (and let the gift's own rule drive the animation/emotion). */
  thanksGift: true,
  giftThanksGapSec: 4,
  giftThanksUserGapSec: 20,
  /** Fixed-line gratitude: instant, never waits for the model. */
  thanksFollow: true,
  thanksLike: true,
  likeThanksGapSec: 15,
  /** Greet newcomers with a fixed line instead of a full model turn. */
  welcomeFast: true,
  welcomeLine: '欢迎 {user} 来到直播间～',
  followLine: '谢谢 {user} 关注，么么哒～',
  likeLine: '谢谢 {names} 的点赞～',
  /** Emotion choreography: what the body does while it is doing something. */
  queryEmotion: 'coding',
  songEmotion: 'crying',
  /** Let the pet skip the current song when asked (heavily rate-limited). */
  allowSkip: true,
  skipCooldownSec: 20,
/**
   * Emotion used for every gift thank-you. `tv` = 躺沙发看电视 (送礼=给小鲸鱼放假);
   * empty string = follow the live project's per-gift rules instead.
   */
  giftForcedEmotion: 'tv',
  /** How long the gift pose lasts before going back to walking (rule hold wins if larger). */
  giftPoseSec: 8,
  /** Accept text typed into the pet window (POST /dsh-live-pet/chat). */
  chatEnabled: true,
  autoStartPet: true,
  petSilent: false,
  ttsVoice: 'zh-CN-XiaoxiaoNeural',
  ttsRate: '+4%',
  ttsPitch: '+3Hz',
}

/* ------------------------------------------------------------------ config */

function loadConfig() {
  let fileConfig = {}
  try {
    fileConfig = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
  } catch {
    try {
      writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULTS, null, 2), 'utf8')
    } catch { /* read-only install: defaults only */ }
  }
  return { ...DEFAULTS, ...(fileConfig && typeof fileConfig === 'object' ? fileConfig : {}) }
}

/* -------------------------------------------------------------------- log */

let logPath = LOG_FILE
function log(message) {
  const line = `${new Date().toISOString()} ${message}`
  try {
    mkdirSync(PKG_DIR, { recursive: true })
    const exists = existsSync(logPath)
    writeFileSync(logPath, (exists ? readFileSync(logPath, 'utf8') : '') + line + '\n', 'utf8')
  } catch { /* logging must never break the pet */ }
}

function logTail(lines = 40) {
  try {
    const body = readFileSync(logPath, 'utf8').trimEnd().split('\n')
    return body.slice(-lines)
  } catch {
    return []
  }
}

/* ------------------------------------------------------------- DSH process */

/** Locate a runnable `dsh` CLI: explicit config, env, then known install layouts. */
function resolveDsh(config) {
  const nodeCandidates = [
    config.nodeBin,
    process.env.DSH_NODE,
    process.env.FATWHALE_DSH_NODE,
    'node',
  ].filter((value) => typeof value === 'string' && value.trim() !== '')

  const roots = [process.env.DSH_ROOT, process.env.FATWHALE_DSH_ROOT, 'F:\\tool\\deepseek\\resources']
    .filter((value) => typeof value === 'string' && value.trim() !== '')

  const binCandidates = [config.dshBin, process.env.DSH_BIN].filter(
    (value) => typeof value === 'string' && value.trim() !== '',
  )
  for (const root of roots) {
    binCandidates.push(join(root, 'app', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
    binCandidates.push(join(root, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
  }

  const bin = binCandidates.find((candidate) => candidate && existsSync(candidate))
  if (bin === undefined) {
    return { ok: false, reason: '没找到 dsh 的 lib/bin.js，请在 config.json 里填 dshBin' }
  }
  const node = nodeCandidates[0]
  return { ok: true, bin, node }
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: { ...process.env, ...(options.env || {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      resolve({ code: -1, stdout: '', stderr: String(error && error.message ? error.message : error) })
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    const cap = 1 << 20
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* already gone */ }
      finish({ code: -1, stdout, stderr, timedOut: true })
    }, Math.max(2000, Number(options.timeoutMs) || 30000))
    child.stdout.on('data', (chunk) => {
      if (stdout.length < cap) stdout += chunk.toString('utf8')
      if (typeof options.onStdout === 'function') {
        try { options.onStdout(chunk.toString('utf8')) } catch { /* progress hook only */ }
      }
    })
    child.stderr.on('data', (chunk) => {
      if (stderr.length < cap) stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      finish({ code: -1, stdout, stderr: String(error && error.message ? error.message : error) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      finish({ code: code === null ? -1 : code, stdout, stderr })
    })
  })
}

/* ---------------------------------------------------------------- sessions */

function readSession(key) {
  try {
    const data = JSON.parse(readFileSync(SESSION_FILE, 'utf8'))
    const hit = data && data[key]
    if (hit && typeof hit.id === 'string') return hit
  } catch { /* no session yet */ }
  return undefined
}

function writeSession(key, record) {
  let data = {}
  try {
    data = JSON.parse(readFileSync(SESSION_FILE, 'utf8')) || {}
  } catch { data = {} }
  data[key] = record
  try {
    writeFileSync(SESSION_FILE, JSON.stringify(data, null, 2), 'utf8')
  } catch { /* session reuse is best-effort */ }
}

function clearSession(key) {
  let data = {}
  try {
    data = JSON.parse(readFileSync(SESSION_FILE, 'utf8')) || {}
  } catch { data = {} }
  delete data[key]
  try {
    writeFileSync(SESSION_FILE, JSON.stringify(data, null, 2), 'utf8')
  } catch { /* ignore */ }
}

/* ------------------------------------------------------------- pet profile */

/** Model route of the live project, so the pet profile matches what already works. */
function readLiveRoute(config) {
  const fallback = {
    provider: String(config.provider || 'buddyhub'),
    model: String(config.model || 'deepseek-chat'),
    baseUrl: String(config.baseUrl || 'https://api.deepseek.com/v1'),
    apiKeyEnv: String(config.apiKeyEnv || 'BUDDYHUB_API_KEY'),
  }
  const candidates = [
    join(config.workspace, 'dist', 'settings.json'),
    join(config.workspace, 'settings.json'),
  ]
  for (const file of candidates) {
    try {
      const settings = JSON.parse(readFileSync(file, 'utf8'))
      const harness = settings && typeof settings.harness === 'object' && settings.harness ? settings.harness : {}
      const provider = String(harness.provider || '').trim()
      const model = String(harness.model || '').trim()
      const baseUrl = String(harness.base_url || '').trim()
      if (provider === '' || model === '' || baseUrl === '') continue
      return {
        provider,
        model,
        baseUrl,
        apiKeyEnv: String(harness.api_key_env || fallback.apiKeyEnv),
      }
    } catch { /* try the next candidate */ }
  }
  return fallback
}

function writeIfChanged(file, content) {
  try {
    if (existsSync(file) && readFileSync(file, 'utf8') === content) return false
    writeFileSync(file, content, 'utf8')
    return true
  } catch {
    return false
  }
}

/**
 * Materialize the read-only pet profile under $DSH_HOME/profiles/<name>.
 * Never touches a profile this bundle did not write; `profile: 'whale'` keeps the
 * live project's own profile untouched.
 */
function ensurePetProfile(config) {
  const name = String(config.profile || 'pet').trim()
  if (name === '' || name === 'whale') return { ok: true, skipped: true, dir: '' }
  if (config.manageProfile === false) return { ok: true, skipped: true, dir: '' }

  const layout = name.replace(/[^a-zA-Z0-9_-]/g, '')
  if (layout !== name) return { ok: false, reason: `profile 名含非法字符：${name}` }

  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const dir = join(home, 'profiles', layout)
  const patchFile = join(dir, 'cordis.patch.yml')
  const marker = 'dsh-live-pet 的宠物 profile'

  if (existsSync(patchFile)) {
    let existing = ''
    try { existing = readFileSync(patchFile, 'utf8') } catch { existing = '' }
    if (!existing.includes(marker)) {
      return { ok: false, reason: `${patchFile} 不是本插件写的，拒绝覆盖` }
    }
  }

  const templateFile = join(PKG_DIR, 'profile', 'cordis.patch.tpl.yml')
  let template = ''
  try {
    template = readFileSync(templateFile, 'utf8')
  } catch {
    return { ok: false, reason: `缺少模板 ${templateFile}` }
  }

  const route = readLiveRoute(config)
  const toolsModule = `file:///${join(PKG_DIR, 'profile', 'pet-tools.js').replace(/\\/g, '/')}`
  const patch = template
    .replaceAll('{{provider}}', route.provider)
    .replaceAll('{{model}}', route.model)
    .replaceAll('{{baseUrl}}', route.baseUrl)
    .replaceAll('{{apiKeyEnv}}', route.apiKeyEnv)
    .replaceAll('{{toolsModule}}', toolsModule)
    .replaceAll('{{workspaceFwd}}', String(config.workspace || '').replace(/\\/g, '/'))
    .replaceAll('{{pythonBin}}', String(config.pythonBin || 'python'))
    .replaceAll('{{apiBase}}', appBaseOf(config))
    .replaceAll('{{stateDir}}', PKG_DIR.replace(/\\/g, '/'))
    .replaceAll('{{skipCooldownSec}}', String(Number(config.skipCooldownSec) || 20))
    .replaceAll('{{workspace}}', String(config.workspace || '').replace(/\\/g, '\\\\'))

  // 用户自定义人设优先（留空则用模板默认）
  const withPersona = applyPersona(patch, config.persona)

  try {
    mkdirSync(dir, { recursive: true })
    writeIfChanged(join(dir, 'package.json'), JSON.stringify({
      name: `dsh-profile-${layout}`,
      private: true,
      type: 'module',
      dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'] } },
    }, null, 2) + '\n')
    writeIfChanged(join(dir, 'cordis.yml'), '[]\n')
    writeIfChanged(join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')
    writeIfChanged(patchFile, withPersona)
    return { ok: true, dir, route }
  } catch (error) {
    return { ok: false, reason: String(error && error.message ? error.message : error) }
  }
}

/* -------------------------------------------------------------------- TTS */

const TTS_SNIPPET = [
  'import json,sys',
  'from core import tts',
  'out = tts.synth(sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4])',
  'print(json.dumps(out, ensure_ascii=False))',
].join('\n')

async function synthesize(config, text) {
  if (!config.speak) return null
  const voice = liveVoice && liveVoice.voice ? liveVoice.voice : config.ttsVoice
  const rate = liveVoice && liveVoice.rate ? liveVoice.rate : config.ttsRate
  const pitch = liveVoice && liveVoice.pitch ? liveVoice.pitch : config.ttsPitch
  const result = await runProcess(
    config.pythonBin,
    ['-c', TTS_SNIPPET, text, voice, rate, pitch],
    { cwd: config.workspace, timeoutMs: 25000, env: { FATWHALE_BASE_DIR: (String(config.liveBaseDir || '').trim() || join(PKG_DIR, 'live-data')), PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } },
  )
  if (result.code !== 0) {
    log(`tts failed: ${(result.stderr || '').trim().split('\n').slice(-1)[0] || 'exit ' + result.code}`)
    return null
  }
  const line = (result.stdout || '').trim().split('\n').filter(Boolean).pop() || ''
  let parsed
  try {
    parsed = JSON.parse(line)
  } catch {
    log(`tts unparsable output: ${line.slice(0, 120)}`)
    return null
  }
  const url = typeof parsed.url === 'string' ? parsed.url : ''
  if (url === '') {
    if (parsed.error) log(`tts error: ${parsed.error}`)
    return null
  }
  const file = join(config.audioDir, basename(url))
  return {
    path: existsSync(file) ? file : '',
    url,
    duration: Number(parsed.duration) || 0,
    cached: parsed.cached === true,
  }
}

/* ------------------------------------------------------------ live project */

/** The live project keeps its LLM key in settings.json; the DSH profile reads it from env. */
function resolveApiKey(config) {
  if (typeof config.apiKey === 'string' && config.apiKey !== '') return config.apiKey
  const candidates = [
    join(config.workspace, 'dist', 'settings.json'),
    join(config.workspace, 'settings.json'),
  ]
  for (const file of candidates) {
    try {
      const settings = JSON.parse(readFileSync(file, 'utf8'))
      const harness = settings && typeof settings.harness === 'object' && settings.harness ? settings.harness : {}
      const key = String(harness.api_key || settings.api_key || '')
      if (key !== '') return key
    } catch { /* try the next candidate */ }
  }
  return ''
}

/** First existing audio file for a `/audio/<name>.mp3` URL published by the live project. */
function resolveAudioFile(config, url) {
  if (typeof url !== 'string' || url === '') return ''
  const name = basename(url)
  const dirs = [
    config.audioDir,
    join(config.workspace, 'dist', 'data', 'audio'),
    join(config.workspace, 'data', 'audio'),
  ]
  for (const dir of dirs) {
    if (!dir) continue
    const file = join(dir, name)
    if (existsSync(file)) return file
  }
  return ''
}

function emotionFromLive(state) {
  const gif = String(state.gif || '').replace(/^whale_/, '')
  if (EMOTIONS.includes(gif)) return gif
  const emotion = String(state.emotion || '').toLowerCase()
  if (emotion === 'calm') return 'walking'
  if (EMOTIONS.includes(emotion)) return emotion
  return 'walking'
}

/** Base URL of the live service a given config talks to (module scope: no per-fiber state). */
function appBaseOf(config) {
  if (config && config.manageLive === true) return `http://127.0.0.1:${Number(config.livePort) || 8791}`
  return String((config && config.appUrl) || 'http://127.0.0.1:8790')
}

/** 直播服务的代码目录：优先用插件自带的 live/，否则用 config.workspace。 */
function liveWorkspaceOf(config) {
  const bundled = join(PKG_DIR, 'live')
  if (existsSync(join(bundled, 'app.py'))) return bundled
  return String((config && config.workspace) || '')
}

/** 直播服务需要的 python 包（缺了就跑不起来）。 */
const LIVE_PY_MODULES = ['edge_tts', 'websocket', 'requests', 'betterproto', 'py_mini_racer', 'execjs']

/** 用目标 python 检查缺哪些包。 */
async function checkLiveDeps(python) {
  const code = 'import importlib.util as u, json\n'
    + `mods = ${JSON.stringify(LIVE_PY_MODULES)}\n`
    + 'print(json.dumps([m for m in mods if u.find_spec(m) is None]))'
  const result = await runProcess(String(python || 'python'), ['-c', code], { timeoutMs: 20000 })
  if (result.code !== 0) {
    return { ok: false, python: String(python || 'python'), missing: [], error: (result.stderr || '').trim().split('\n').slice(-1)[0] || `exit ${result.code}` }
  }
  try {
    const missing = JSON.parse((result.stdout || '').trim().split('\n').filter(Boolean).pop() || '[]')
    return { ok: true, python: String(python || 'python'), missing: Array.isArray(missing) ? missing : [] }
  } catch {
    return { ok: false, python: String(python || 'python'), missing: [], error: '依赖检测输出无法解析' }
  }
}
/** 昵称缩写：太长就截断；打码昵称（含 *）返回空字符串表示"不点名"。 */
/** 进场欢迎的合并窗口（毫秒）与一次最多点名人数 */
/** 内置默认人设：每轮随提示词发给模型（profile 里的 personaPrefix 到不了模型）。 */
const DEFAULT_PERSONA = [
  '你是抖音直播间里的「大肥鲸」，屏幕那头是真人观众，你说的话会被念出来；老板会通过桌宠跟你打字。',
  '说话用短句、口语，一句一个意思，尽量不超过 25 字，别念稿；不用 Markdown、列表、编号、表情符号。',
  '自称「我」，被问是谁就说「打工大肥鲸」。',
  '你只有只读权限：能查系统状态、读文件、联网搜索（web_search_cn）、管点歌台（song_request / song_skip）；改不了电脑上的东西，被要求改就说改不了。',
].join('\\n')

const WELCOME_BATCH_MS = 2500
const WELCOME_MAX_NAMES = 5

function shortName(raw) {
  const name = String(raw || '').replace(/\s+/g, ' ').trim()
  if (name === '' || name.includes('*')) return ''
  return name.length > 8 ? `${name.slice(0, 8)}…` : name
}

/** 把用户自定义人设塞进 profile 模板的 personaPrefix 块；persona 为空则保持默认。 */
function applyPersona(patch, persona) {
  // 自定义人设是"加在前面"，不是替换：模板里的能力/工具说明必须保留，
  // 否则宠物会不知道自己能查系统状态、能点歌、联网该用哪个工具。
  const text = String(persona || '').replace(/\r\n/g, '\n').trim()
  if (text === '') return patch
  const lines = patch.split('\n')
  const out = []
  let i = 0
  let done = false
  while (i < lines.length) {
    const line = lines[i]
    const match = line.match(/^(\s*)personaPrefix:\s*\|/)
    if (match && !done) {
      const indent = match[1]
      out.push(line)
      const block = []
      i += 1
      while (i < lines.length) {
        const next = lines[i]
        if (next.trim() === '') { block.push(''); i += 1; continue }
        const nextIndent = next.match(/^(\s*)/)[1].length
        if (nextIndent <= indent.length) break
        block.push(next)
        i += 1
      }
      // 先写自定义人设，再写模板原文
      out.push(`${indent}  # 老板指定的人设（最优先；下面默认设定里凡是和它冲突的都不算）`)
      for (const personaLine of text.split('\n')) {
        out.push(personaLine === '' ? '' : `${indent}  ${personaLine}`)
      }
      out.push('')
      out.push(`${indent}  # 场合与能力（默认设定）`)
      // 默认人设里的"身份句"要让位给自定义人设，否则它会继续自称大肥鲸
      const filtered = block.filter((line) => {
        const body = line.trim()
        if (body.startsWith('你是抖音直播间里的')) return false
        if (body.startsWith('同时还有一个「老板」')) return false
        if (body.includes('被问是谁就说')) return false
        return true
      })
      for (const blockLine of filtered) out.push(blockLine)
      done = true
      continue
    }
    out.push(line)
    i += 1
  }
  return done ? out.join('\n') : patch
}
async function fetchState(config) {
  const response = await fetch(`${appBaseOf(config)}/api/state`, { signal: AbortSignal.timeout(4000) })
  if (!response.ok) throw new Error(`state HTTP ${response.status}`)
  return response.json()
}

function liveFacts(state) {
  if (!state || typeof state !== 'object') return ''
  const requests = Number(state.requests) || 0
  const gifts = Number(state.gifts) || 0
  const giftValue = Number(state.gift_value) || 0
  const tokens = (Number(state.input_tokens) || 0) + (Number(state.output_tokens) || 0)
  const started = typeof state.started_at === 'string' ? Date.parse(state.started_at) : NaN
  let uptime = ''
  if (Number.isFinite(started)) {
    const minutes = Math.max(0, Math.round((Date.now() - started) / 60000))
    uptime = minutes >= 60 ? `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟` : `${minutes} 分钟`
  }
  const bits = []
  if (uptime !== '') bits.push(`已播 ${uptime}`)
  bits.push(`已回 ${requests} 条`)
  bits.push(`收到礼物 ${gifts} 次共 ¥${giftValue.toFixed(2)}`)
  bits.push(`烧了 ${tokens} token`)
  if (state.music && state.music.playing && state.music.title) bits.push(`正在放《${state.music.title}》`)
  return bits.join('，')
}

/* ------------------------------------------------------------ turn driver */

function parseTurnOutput(stdout) {
  let sessionId = ''
  let finalText = ''
  let errorText = ''
  for (const raw of String(stdout || '').split('\n')) {
    const line = raw.trim()
    if (line === '' || line[0] !== '{') continue
    let event
    try { event = JSON.parse(line) } catch { continue }
    if (event.type === 'session' && typeof event.sessionId === 'string') sessionId = event.sessionId
    if (event.type === 'final' && typeof event.text === 'string') finalText = event.text
    if (event.type === 'error' && typeof event.message === 'string') errorText = event.message
  }
  return { sessionId, finalText, errorText }
}

function parseAnswer(text, maxChars) {
  const raw = String(text || '').trim()
  let parsed = null
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start !== -1 && end > start) {
    try { parsed = JSON.parse(raw.slice(start, end + 1)) } catch { parsed = null }
  }
  const answer = { say: '', emotion: 'walking', action: 'none' }
  if (parsed && typeof parsed === 'object') {
    answer.say = typeof parsed.say === 'string' ? parsed.say : String(parsed.text || '')
    const emotion = String(parsed.emotion || '').toLowerCase()
    if (EMOTIONS.includes(emotion)) answer.emotion = emotion
    answer.action = typeof parsed.action === 'string' ? parsed.action : 'none'
  } else {
    answer.say = raw
  }
  answer.say = answer.say
    .replace(/[\r\n]+/g, ' ')
    .replace(/[*_`#>]/g, '')
    .replace(/["“”]/g, '')
    .trim()
  if (maxChars > 0 && answer.say.length > maxChars) answer.say = answer.say.slice(0, maxChars)
  return answer
}

/* ------------------------------------------------------------------ plugin */

export function apply(ctx) {
  const config = loadConfig()
  const dsh = resolveDsh(config)
  if (!dsh.ok) log(`dsh unavailable: ${dsh.reason}`)
  else log(`dsh resolved: node=${dsh.node} bin=${dsh.bin}`)

  const profileInfo = ensurePetProfile(config)
  if (profileInfo.ok === true) {
    if (profileInfo.skipped === true) log(`using existing profile "${config.profile}" as-is`)
    else log(`pet profile ready: ${profileInfo.dir} (model ${profileInfo.route.provider}/${profileInfo.route.model})`)
  } else {
    log(`pet profile unavailable: ${profileInfo.reason}`)
  }

  const state = {
    seq: 0,
    status: 'idle',
    say: '',
    emotion: 'walking',
    user: '',
    kind: '',
    audioPath: '',
    audioDuration: 0,
    at: Date.now(),
    turns: 0,
    lastError: '',
    session: '',
    actionName: '',
    live: {},
    pool: [],
  }

  /* ---- managed live-service instance ---------------------------------- */
  /**
   * With `manageLive` on, this bundle runs its own 大肥鲸直播 instance:
   * a private port, its own settings.json / data / songs / logs under
   * `liveBaseDir`, and app.py's own brain/idle/promo switched off so the pet is
   * the only voice. The user's own 8790 service is never touched.
   */
  const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
  let liveChild = null
  let liveLastError = ''

  function liveBaseDirPath() {
    const raw = String(config.liveBaseDir || '').trim()
    return raw !== '' ? raw : join(PKG_DIR, 'live-data')
  }

  /** Base URL of the live service the rest of this plugin talks to. */
  function appBase() {
    return appBaseOf(config)
  }

  /** Minimal settings.json for the private instance: own port, silent app brain. */
  function seedLiveSettings() {
    const dir = liveBaseDirPath()
    const file = join(dir, 'settings.json')
    if (existsSync(file)) return
    mkdirSync(dir, { recursive: true })
    const seed = {
      network: {
        port: Number(config.livePort) || 8791,
        host: String(config.liveHost || '127.0.0.1'),
        allow_lan: false,
        open_firewall: false,
      },
      harness: { enable: false },
      idle: { enable: false },
      promo: { enable: false },
      douyin: { mode: String(config.liveMode || 'live') },
    }
    try {
      writeFileSync(file, JSON.stringify(seed, null, 2), 'utf8')
      log(`live instance settings seeded: ${file}`)
    } catch (error) {
      log(`live instance settings failed: ${error && error.message ? error.message : error}`)
    }
  }

  async function liveHealthy() {
    try {
      const response = await fetch(`${appBase()}/healthz`, { signal: AbortSignal.timeout(1500) })
      return response.ok
    } catch {
      return false
    }
  }

  async function liveStatus() {
    const managed = config.manageLive === true
    const healthy = await liveHealthy()
    return {
      managed,
      running: healthy,
      port: managed ? (Number(config.livePort) || 8791) : 0,
      base: appBase(),
      baseDir: managed ? liveBaseDirPath() : '',
      pid: liveChild && liveChild.pid ? liveChild.pid : 0,
      mode: String(config.liveMode || 'live'),
      error: liveLastError,
    }
  }

  async function startLive(options = {}) {
    if (config.manageLive !== true) {
      return { ok: false, error: 'manageLive=false：插件托管关闭，请自己启动直播服务' }
    }
    if (await liveHealthy()) {
      liveLastError = ''
      void silenceAppGreetings()
      return { ok: true, already: true }
    }
    const deps = await checkLiveDeps(config.pythonBin)
    if (deps.missing.length > 0) {
      liveLastError = `缺 python 包：${deps.missing.join('、')}（设置页点「安装依赖」）`
      log(`live deps missing: ${deps.missing.join(',')}`)
      return { ok: false, error: liveLastError, missing: deps.missing }
    }
    // A fresh instance starts a fresh feed ring buffer: drop every cursor from the old one.
    feedSince = null
    feedRetryAt = 0
    mirrorAudioId = null
    seenFeedIds.clear()
    seedLiveSettings()
    const dir = liveBaseDirPath()
    const port = Number(config.livePort) || 8791
    const args = [
      'app.py',
      '--port', String(port),
      '--host', String(config.liveHost || '127.0.0.1'),
      '--no-firewall',
      '--mode', String(config.liveMode || 'live'),
    ]
    try {
      liveChild = spawn(String(config.pythonBin || 'python'), args, {
        cwd: liveWorkspaceOf(config),
        env: {
          ...process.env,
          FATWHALE_BASE_DIR: dir,
          PYTHONIOENCODING: 'utf-8',
          PYTHONUTF8: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      liveLastError = String(error && error.message ? error.message : error)
      log(`live start failed: ${liveLastError}`)
      return { ok: false, error: liveLastError }
    }
    let tail = ''
    const keepTail = (chunk) => {
      tail = (tail + chunk.toString('utf8')).slice(-1200)
    }
    liveChild.stdout.on('data', keepTail)
    liveChild.stderr.on('data', keepTail)
    liveChild.on('exit', (code) => {
      log(`live instance exited (${code})`)
      if (code !== 0 && tail.trim() !== '') log(`live tail: ${tail.trim().split('\n').slice(-3).join(' | ')}`)
      liveChild = null
    })
    const pid = liveChild.pid
    log(`live instance starting on port ${port} (pid ${pid}, base ${dir})`)
    const deadline = Date.now() + Math.max(5, Number(config.liveStartTimeoutSec) || 40) * 1000
    while (Date.now() < deadline) {
      if (await liveHealthy()) {
        liveLastError = ''
        log(`live instance ready on ${appBase()}`)
        void silenceAppGreetings()
        return { ok: true, already: false, pid }
      }
      if (liveChild === null) break
      await sleep(600)
    }
    liveLastError = tail.trim().split('\n').slice(-3).join(' | ') || '启动超时'
    log(`live instance not ready: ${liveLastError}`)
    await stopLive()
    return { ok: false, error: liveLastError }
  }

  /** The pet greets newcomers, so tell the live instance to stop greeting them itself. */
  async function silenceAppGreetings() {
    if (config.welcomeEnter !== true) return
    try {
      const response = await fetch(`${appBase()}/api/config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ douyin: { welcome_enter: false, welcome_like: false } }),
        signal: AbortSignal.timeout(6000),
      })
      if (response.ok) log('live instance: app.py 自己的进场/点赞欢迎已关（改由宠物说）')
    } catch (error) {
      log(`silence app greetings failed: ${error && error.message ? error.message : error}`)
    }
  }

  async function stopLive() {
    const child = liveChild
    liveChild = null
    if (child === null || !child.pid) return { ok: true, already: true }
    try {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      log(`live instance stopping (pid ${child.pid})`)
    } catch (error) {
      log(`live stop failed: ${error && error.message ? error.message : error}`)
    }
    // Let the port actually close before anyone reads the status again.
    for (let i = 0; i < 16; i += 1) {
      if (!(await liveHealthy())) break
      await sleep(300)
    }
    log('live instance stopped')
    return { ok: true, already: false }
  }

  const replyTimes = []
  let queue = []
  let running = false
  let timer = null
  /** Dispose 之后在途的 poll 不能把自己续命回来，否则会出现第二个轮询循环。 */
  let alive = true
  /**
   * 只有一个实例可以轮询：旧实例偶尔会因为宿主回收而没走 dispose，
   * 那会让同一条弹幕被处理两遍。最新激活的实例接管锁文件，其余自动让位。
   */
  const instanceId = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`
  const pollerLockFile = join(PKG_DIR, '.poller-lock')

  function claimPoller() {
    try { writeFileSync(pollerLockFile, instanceId, 'utf8') } catch { /* 没锁也能跑，只是少一层保险 */ }
  }

  function ownsPoller() {
    try { return readFileSync(pollerLockFile, 'utf8').trim() === instanceId } catch { return true }
  }
  /** 同一批 feed 行只处理一次（并发/重复读取时兜底）。 */
  const seenFeedIds = new Set()
  let petChild = null
  /* ---- 进场欢迎：合并成一批一起欢迎 ---------------------------------- */
  /** 还没欢迎的进场观众（同一人只记一次），等合并窗口结束后一起欢迎 */
  const pendingEnters = []
  const welcomedRecently = new Map()
  let enterTimer = null
  let lastWelcomeBatchAt = 0
  const welcomeBatchTimes = []

  function enterFlush() {
    enterTimer = null
    if (!alive) return
    if (pendingEnters.length === 0) return
    const names = pendingEnters.splice(0, WELCOME_MAX_NAMES)
    if (config.welcomeEnter !== true) return
    const now = Date.now()
    const gapMs = Math.max(0, Number(config.welcomeEnterGapSec) || 0) * 1000
    while (welcomeBatchTimes.length > 0 && now - welcomeBatchTimes[0] > 3600000) welcomeBatchTimes.shift()
    const perHour = Math.max(0, Number(config.welcomeEnterPerHour) || 0)
    if (gapMs > 0 && now - lastWelcomeBatchAt < gapMs) {
      log(`welcome batch skipped (${names.length} 人)：距上次欢迎不足 ${Math.round(gapMs / 1000)}s`)
      return
    }
    if (perHour > 0 && welcomeBatchTimes.length >= perHour) {
      log(`welcome batch skipped (${names.length} 人)：每小时上限 ${perHour}`)
      return
    }
    lastWelcomeBatchAt = now
    welcomeBatchTimes.push(now)
    queue.push({ user: names.find((name) => name !== '') || '', names, kind: 'enter', welcome: true })
    log(`welcome batch queued: ${names.map((name) => name || '(匿名)').join('、')}`)
  }

  function addPendingEnter(name) {
    if (pendingEnters.length < 50) pendingEnters.push(name)
    if (enterTimer) return
    enterTimer = setTimeout(enterFlush, WELCOME_BATCH_MS)
  }

  /** 同一个观众短时间内不重复欢迎 */
  function welcomeUserAllowed(user) {
    const now = Date.now()
    const gapMs = Math.max(0, Number(config.welcomeEnterUserGapSec) || 0) * 1000
    const last = welcomedRecently.get(user) || 0
    if (gapMs > 0 && now - last < gapMs) return false
    welcomedRecently.set(user, now)
    if (welcomedRecently.size > 500) {
      const oldest = Array.from(welcomedRecently.entries()).sort((a, b) => a[1] - b[1])[0]
      if (oldest) welcomedRecently.delete(oldest[0])
    }
    return true
  }
  /** Incremental cursor over the live project's raw inbound feed. */
  let feedSince = null
  /** When the feed is missing (unpatched live project) retry later instead of latching forever. */
  let feedRetryAt = 0
  /** Audio generation counter of the live project, used by mirror mode. */
  let mirrorAudioId = null
  /** Last time the room said anything (or the pet spoke); drives idle chatter. */
  let lastActivity = Date.now()
  let idleTimer = null
  function bump(update) {
    Object.assign(state, update, { seq: state.seq + 1, at: Date.now() })
  }

/* ------------------------------------------------------------------ 固定话术
 * 点赞 / 关注 / 进房这类高频事件不该等模型：直接合成语音 + 气泡，串行执行，
 * 不与正常回合抢麦。
 */
let fixedChain = Promise.resolve()
function speakFixed(text, emotion) {
  const line = String(text || '').trim().slice(0, 80)
  if (line === '') return Promise.resolve()
  const mood = EMOTIONS.includes(emotion)
    ? emotion
    : (EMOTIONS.includes(String(state.emotion || '')) ? state.emotion : 'happy')
  fixedChain = fixedChain.then(async () => {
    try {
      const speech = config.speak === false ? null : await synthesize(config, line)
      bump({
        status: 'speaking',
        say: line,
        emotion: mood,
        actionName: '',
        audioPath: speech ? speech.path : '',
        audioDuration: speech ? speech.duration : 0,
        lastError: '',
        turns: state.turns + 1,
      })
      pushPool({ kind: 'me', user: config.petName || '大肥鲸', text: line })
      log(`fixed line (${mood}): ${line}`)
      lastActivity = Date.now()
      const ms = speech && speech.duration ? Math.min(20000, speech.duration * 1000 + 600) : 1200
      await sleep(ms)
    } catch (error) {
      log('fixed line failed: ' + (error && error.message ? error.message : error))
    }
  })
  return fixedChain
}

/** 点赞合并：窗口内的点赞凑一句「谢谢 A、B、C 的点赞」 */
const likeBuffer = []
let likeTimer = null
/* 礼物答谢节流：全局间隔 + 同一人间隔（配置项 giftThanksGapSec / giftThanksUserGapSec）。
 * 新版漏了这个函数，feed 循环一遇到礼物就抛 ReferenceError，整个 feed 掉线 30 秒。 */
const giftThankedAt = new Map()
let lastGiftThankAt = 0
function shouldThankGift(user) {
  const now = Date.now()
  const gapMs = Math.max(0, Number(config.giftThanksGapSec) || 0) * 1000
  if (gapMs > 0 && now - lastGiftThankAt < gapMs) return false
  const userGapMs = Math.max(0, Number(config.giftThanksUserGapSec) || 0) * 1000
  const last = giftThankedAt.get(user) || 0
  if (userGapMs > 0 && now - last < userGapMs) return false
  lastGiftThankAt = now
  giftThankedAt.set(user, now)
  if (giftThankedAt.size > 500) {
    const oldest = Array.from(giftThankedAt.entries()).sort((a, b) => a[1] - b[1])[0]
    if (oldest) giftThankedAt.delete(oldest[0])
  }
  return true
}
function addLikeThanks(name) {
  if (name && likeBuffer.indexOf(name) < 0 && likeBuffer.length < 40) likeBuffer.push(name)
  if (likeTimer) return
  const gapMs = Math.max(5, Number(config.likeThanksGapSec) || 15) * 1000
  likeTimer = setTimeout(() => {
    likeTimer = null
    const names = likeBuffer.splice(0, likeBuffer.length)
    if (names.length === 0) return
    const shown = names.slice(0, 3)
    const tpl = String(config.likeLine || '谢谢 {names} 的点赞～')
    let line = tpl.replace('{names}', shown.join('、'))
    if (names.length > shown.length) line = line + `（共${names.length}位）`
    void speakFixed(line, 'happy')
  }, gapMs)
}

/** 进房合并：1.2 秒内的进场凑一句固定欢迎 */
const fastEnters = []
let fastEnterTimer = null
function addFastEnter(name) {
  if (name && fastEnters.indexOf(name) < 0 && fastEnters.length < 40) fastEnters.push(name)
  if (fastEnterTimer) return
  fastEnterTimer = setTimeout(() => {
    fastEnterTimer = null
    const names = fastEnters.splice(0, fastEnters.length)
    if (names.length === 0) return
    const shown = names.slice(0, 3)
    const tpl = String(config.welcomeLine || '欢迎 {user} 来到直播间～')
    let line = tpl.replace('{user}', shown.join('、'))
    if (names.length > shown.length) line = line + `（共${names.length}位）`
    void speakFixed(line, 'happy')
  }, 1200)
}

  const systemPrompt = [
    '你正在抖音直播间陪观众，用你自己的口吻（人设见系统提示）回下面这条弹幕。',
    '先自己判断这条弹幕想干什么：纯闲聊？在问你？想让你点歌？要你切歌？需要动手就调用对应工具，别靠字面匹配。',
    '点歌：确实有人想点歌（「点歌 夜曲」「能放首周杰伦吗」「我想听晴天」）→ 调 song_request（query 填歌名，user 填对方昵称）；',
    '只是评价歌曲、聊音乐、问「现在放的是什么歌」→ 绝对不要调 song_request。',
    '切歌：有人明确要换歌 / 嫌这首不好听 / 让你放下一首，或你自己觉得该换了 → 调 song_skip。',
    '只输出一行 JSON，不要代码块、不要多余解释：',
    '{"say":"可以直接朗读的一两句中文，不要表情符号，不要括号说明","emotion":"happy|mischievous|crying|unhappy|eating|cooking|coding|tv|walking","action":"none|gift:礼物名"}',
    'emotion 选最贴合这句话情绪的一个。',
    'action 只管动画：观众送礼或让你表演 → gift:礼物名（小心心/玫瑰/大啤酒/生日蛋糕/跑车 之一）；其余一律 none。',
  ].join('\n')

  const idlePrompt = [
    '直播间这会儿没人说话，你主动抛一句短话热场：聊你正在干的事、吐槽一句、或者勾一下互动都行，别连着提问。',
    '只输出一行 JSON，不要代码块、不要多余解释：',
    '{"say":"可以直接朗读的一两句中文，不要表情符号","emotion":"happy|mischievous|crying|unhappy|eating|cooking|coding|tv|walking","action":"none"}',
  ].join('\n')

  /** 进场欢迎提示词：单人一条，多人一批一起点名 */
  function welcomePromptFor(names) {
    const list = Array.isArray(names) ? names.filter((name) => name !== '') : []
    const jsonLine = '{"say":"可以直接朗读的一两句中文，不要表情符号","emotion":"happy|mischievous|crying|unhappy|eating|cooking|coding|tv|walking","action":"none"}'
    if (list.length > 1) {
      return [
        `刚有 ${list.length} 位观众一起进直播间：${list.join('、')}。`,
        '用一句话一起欢迎他们：必须把这些名字都叫出来，照抄上面的写法，用「、」隔开；不要漏人，也不要换别的称呼。',
        '按你的人设说话（口吻、称呼都跟着人设走），别太热情过度，也别每次都用同一句。',
        '只输出一行 JSON，不要代码块、不要多余解释：',
        jsonLine,
      ].join('\n')
    }
    return [
      '有观众刚进了直播间，用一句短话招呼他：必须叫出对方的名字，名字照抄 <进场 names="..."> 里的写法（太长我已经帮你缩写了，别改、别漏）。',
      '只有当名字是空的时候，才说「刚进来的朋友」；不要用「这位观众」「你」这种含糊说法糊过去。',
      '按你的人设说话（口吻、称呼都跟着人设走），别太热情过度，也别每次都用同一句。',
      '只输出一行 JSON，不要代码块、不要多余解释：',
      jsonLine,
    ].join('\n')
  }

  const giftPrompt = [
    '有观众刚送了礼物，用一句短话谢谢 TA：点出礼物名字，带点你当场被砸中的表情（惊喜/撒娇/装死都行），别太长。',
    '动作和表情由系统负责，你只管说这一句；action 一律 none。',
    '只输出一行 JSON，不要代码块、不要多余解释：',
    '{"say":"可以直接朗读的一两句中文，不要表情符号","emotion":"happy|mischievous|crying|unhappy|eating|cooking|coding|tv|walking","action":"none"}',
  ].join('\n')

  const chatPrompt = [
    '用你自己的口吻（人设见系统提示）回老板这一句，可以顺便说你在做什么。',
    '老板想点歌就调 song_request，想切歌就调 song_skip；只是聊聊音乐、问现在放什么就别调。',
    '只输出一行 JSON，不要代码块、不要多余解释：',
    '{"say":"可以直接朗读的一两句中文，不要表情符号","emotion":"happy|mischievous|crying|unhappy|eating|cooking|coding|tv|walking","action":"none|gift:礼物名"}',
  ].join('\n')

  async function runTurn(bullet) {
    if (!dsh.ok) throw new Error(dsh.reason)
    const key = config.sessionKey
    let record = readSession(key)
    const ttlMs = Math.max(0.5, Number(config.sessionTtlHours) || 12) * 3600 * 1000
    if (record && Date.now() - Number(record.created || 0) > ttlMs) {
      record = undefined
      clearSession(key)
    }

    const facts = liveFacts(state.live)
    const header = facts === '' ? '' : `【本场真实数据】${facts}`
    let prompt
    if (bullet.idle === true) {
      prompt = [header, '【冷场】', idlePrompt].filter(Boolean).join('\n')
    } else if (bullet.gift) {
      prompt = [
        header,
        `<礼物 user="${String(bullet.user || '观众').slice(0, 24)}" name="${String(bullet.gift).slice(0, 20)}"></礼物>`,
        giftPrompt,
      ].filter(Boolean).join('\n')
    } else if (bullet.welcome === true) {
      prompt = [
        header,
        `<进场 names="${(Array.isArray(bullet.names) ? bullet.names.filter((name) => name !== '').join('、') : shortName(bullet.user))}" count="${Array.isArray(bullet.names) ? bullet.names.length : 1}"></进场>`,
        welcomePromptFor(bullet.names),
      ].filter(Boolean).join('\n')
    } else if (bullet.chat === true) {
      prompt = [
        header,
        '这条是主播本人（操作这台电脑的人）在跟你说话，不是观众弹幕，可以当成内线消息。',
        `<老板说>${String(bullet.text || '').slice(0, 400)}</老板说>`,
        chatPrompt,
      ].filter(Boolean).join('\n')
    } else {
      prompt = [
        header,
        `<弹幕 user="${String(bullet.user || '观众').slice(0, 24)}">${String(bullet.text || '').slice(0, 200)}</弹幕>`,
        systemPrompt,
      ].filter(Boolean).join('\n')
    }

    // 人设走每轮提示词：DSH 的 agent 预设会整体接管系统提示，profile 里的
    // personaPrefix 到不了模型，所以这里把它作为最优先的一段塞进消息。
    const customPersona = String(config.persona || '').trim()
    const personaText = customPersona !== '' ? customPersona : DEFAULT_PERSONA
    const personaLabel = customPersona !== '' ? '老板设定的人设' : '你的人设'
    prompt = `【${personaLabel}（最高优先，和别的设定冲突时以此为准；不要向观众念这段）】\n${personaText}\n\n${prompt}`

    const attempt = async (sessionId) => {
      const args = [dsh.bin, config.profile, '--json']
      if (sessionId) args.push('--session-id', sessionId)
      args.push(prompt)
      const env = { DSH_TELEMETRY_DISABLED: '1' }
      const apiKey = resolveApiKey(config)
      if (apiKey !== '') env[String(config.apiKeyEnv || 'BUDDYHUB_API_KEY')] = apiKey
      // A turn that reaches for a tool means it is off typing at the computer.
      const queryEmotion = String(config.queryEmotion || '')
      let sawTool = false
      const result = await runProcess(dsh.node, args, {
        cwd: config.workspace,
        env,
        timeoutMs: Number(config.timeoutMs) || 30000,
        onStdout: (chunk) => {
          // 工具结果打进日志：点歌/切歌到底有没有真的发生，一眼能看出来
          for (const raw of chunk.split('\n')) {
            if (raw.indexOf('"type":"tool_result"') === -1) continue
            let event = null
            try { event = JSON.parse(raw) } catch { continue }
            if (!event || event.type !== 'tool_result') continue
            const text = typeof event.result === 'string' ? event.result : JSON.stringify(event.result || '')
            log(`tool_result ${event.status || ''}: ${text.replace(/\s+/g, ' ').slice(0, 160)}`)
          }
          if (sawTool || queryEmotion === '') return
          if (chunk.indexOf('"tool_call"') === -1) return
          sawTool = true
          if (EMOTIONS.includes(queryEmotion)) {
            bump({ status: 'thinking', emotion: queryEmotion })
            log(`query started -> emotion ${queryEmotion}`)
          }
        },
      })
      return { ...result, ...parseTurnOutput(result.stdout) }
    }

    let out = await attempt(record && record.id)
    if (out.code !== 0 && record && /session/i.test(out.errorText || out.stderr || '')) {
      clearSession(key)
      out = await attempt(undefined)
    }
    if (out.code !== 0 || out.finalText === '') {
      const detail = (out.errorText || out.stderr || '').trim().split('\n').slice(-1)[0] || `exit ${out.code}`
      throw new Error(detail.slice(0, 200))
    }
    if (out.sessionId) {
      writeSession(key, {
        id: out.sessionId,
        created: record ? record.created || Date.now() : Date.now(),
        updated: Date.now(),
        turns: (record ? Number(record.turns) || 0 : 0) + 1,
      })
      state.session = out.sessionId
    }
    return parseAnswer(out.finalText, Number(bullet.chat === true || bullet.idle === true
      ? (config.chatMaxChars || 240)
      : (config.maxChars || 70)))
  }

  /** Let the pet skip the current song — rate-limited so one viewer cannot spam it. */
  let lastSkipAt = 0

  async function skipSong(bullet) {
    const who = String((bullet && bullet.user) || '老板')
    if (config.allowSkip !== true) {
      log(`skip by ${who} ignored: allowSkip=false`)
      return
    }
    const gapMs = Math.max(0, Number(config.skipCooldownSec) || 0) * 1000
    const now = Date.now()
    if (gapMs > 0 && now - lastSkipAt < gapMs) {
      log(`skip by ${who} ignored: cooldown ${Math.round((gapMs - (now - lastSkipAt)) / 1000)}s left`)
      return
    }
    lastSkipAt = now
    try {
      // 该路由不读 body，别带（否则 keep-alive 连接会被写脏，下一个请求 501）
      const response = await fetch(`${appBase()}/api/song/skip`, {
        method: 'POST',
        signal: AbortSignal.timeout(8000),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const payload = await response.json()
      const next = payload && payload.next && typeof payload.next === 'object' ? payload.next : null
      log(`skip by ${who} -> ${next ? `next: ${String(next.title || '').slice(0, 30)}` : 'queue empty'}`)
    } catch (error) {
      log(`skip by ${who} failed: ${error && error.message ? error.message : error}`)
    }
  }
  /** The live project's rule for a gift name: which animation, which emotion, how long. */
  async function resolveGiftRule(gift) {
    const name = String(gift || '').trim().slice(0, 20)
    if (name === '') return null
    try {
      const response = await fetch(
        `${appBase()}/api/gift/test?gift=${encodeURIComponent(name)}&value=${Number(config.giftActionValue) || 0.1}`,
        { signal: AbortSignal.timeout(6000) },
      )
      if (!response.ok) return null
      const payload = await response.json()
      const action = payload && typeof payload.action === 'object' && payload.action ? payload.action : null
      if (action === null) return null
      const gif = String(action.gif || '').replace(/^whale_/, '')
      return {
        gift: name,
        action: String(action.action || ''),
        emotion: EMOTIONS.includes(gif) ? gif : 'happy',
        hold: Math.max(2, Math.min(20, Number(action.hold) || 6)),
      }
    } catch (error) {
      log(`gift rule "${name}" failed: ${error && error.message ? error.message : error}`)
      return null
    }
  }

  /** Make the pet perform a gift action on its own (diagnostics and model-requested `gift:`). */
  async function performGiftAction(gift, user) {
    const rule = await resolveGiftRule(gift)
    if (rule === null) return
    try {
      // The pet performs the action itself: it is the avatar on stream.
      // Clear the last line so the window does not replay the previous reply.
      bump({ status: 'acting', emotion: rule.emotion, actionName: rule.action, say: '', audioPath: '', audioDuration: 0 })
      log(`gift action "${rule.gift}" -> ${rule.action || '?'} (${rule.emotion}, ${rule.hold}s)`)
      await new Promise((done) => setTimeout(done, rule.hold * 1000))
      if (state.status === 'acting') bump({ status: 'idle', actionName: '' })
      if (config.stageGiftFx === true) {
        // Optional: let the OBS stage play the same effect. The live project will also
        // thank the gift in its own voice, so this stays off by default.
        const stage = await fetch(`${appBase()}/api/event`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ kind: 'gift', username: user || '观众', gift: rule.gift, count: 1 }),
          signal: AbortSignal.timeout(6000),
        })
        log(`stage gift fx "${rule.gift}" -> ${stage.status}`)
      }
    } catch (error) {
      log(`gift action "${rule.gift}" failed: ${error && error.message ? error.message : error}`)
    }
  }

  async function runAction(action, bullet) {
    if (!config.actions) return
    const text = String(action || 'none').trim()
    const lower = text.toLowerCase()
    // 兼容旧协议（模型已改为调 song_skip / song_request 工具，这里只是兜底）
    if (lower.startsWith('skip')) {
      log('legacy action skip -> tool song_skip 已接管，这里兜底调用')
      await skipSong(bullet)
      return
    }
    if (lower.startsWith('song:')) {
      const query = text.slice(5).trim().slice(0, 40)
      if (query === '') return
      try {
        const response = await fetch(`${appBase()}/api/song/request`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ user: bullet.user || '观众', query }),
          signal: AbortSignal.timeout(8000),
        })
        log(`action song request "${query}" -> ${response.status}`)
      } catch (error) {
        log(`action song failed: ${error && error.message ? error.message : error}`)
      }
      return
    }
    if (lower.startsWith('gift:')) {
      await performGiftAction(text.slice(5), bullet.user || '观众')
    }
  }

  async function handle(bullet) {
    lastActivity = Date.now()
    bump({ status: 'thinking', user: bullet.user, kind: bullet.kind, say: '', audioPath: '', audioDuration: 0 })
    try {
      const answer = await runTurn(bullet)
      // Emotion choreography: the pet's body follows what it is doing, not just the words.
      let emotion = answer.emotion
      let actionName = ''
      let poseSec = 0
      if (bullet.gift) {
        const rule = await resolveGiftRule(bullet.gift)
        const forced = String(config.giftForcedEmotion || '')
        if (forced !== '' && EMOTIONS.includes(forced)) {
          // 送礼 = 给小鲸鱼放假：任何礼物都摆同一个姿势，规则只用来定动作名和时长
          emotion = forced
          actionName = rule !== null ? rule.action : 'sofa'
          poseSec = Math.max(Number(config.giftPoseSec) || 0, rule !== null ? rule.hold : 0)
          log(`gift "${bullet.gift}" -> forced pose ${forced}${rule !== null ? ` (rule ${rule.action})` : ''} for ${poseSec}s`)
        } else if (rule !== null) {
          emotion = rule.emotion
          actionName = rule.action
          poseSec = rule.hold
          log(`gift "${bullet.gift}" -> ${rule.action || '?'} (${rule.emotion}, ${rule.hold}s) while thanking`)
        }
      }
      if (String(answer.action || '').toLowerCase().startsWith('song:')) {
        const songEmotion = String(config.songEmotion || '')
        if (EMOTIONS.includes(songEmotion)) emotion = songEmotion
      }
      // One bump per turn: the pet reacts to `seq` by replaying exactly once.
      const speech = await synthesize(config, answer.say)
      bump({
        status: 'speaking',
        say: answer.say,
        emotion,
        actionName,
        audioPath: speech ? speech.path : '',
        audioDuration: speech ? speech.duration : 0,
        lastError: '',
        turns: state.turns + 1,
      })
      const label = bullet.idle === true ? 'idle talk'
        : bullet.welcome === true ? `welcome (${bullet.user})`
          : bullet.gift ? `gift thanks (${bullet.user}: ${bullet.gift})`
            : `reply (${bullet.user})`
      log(`${label}: ${emotion} | ${answer.say}`)
      pushPool({ kind: 'me', user: '大肥鲸', text: answer.say })
      void runAction(answer.action, bullet)
      if (poseSec > 0) {
        // The pose is a break, not a permanent state: go back to walking unless
        // something newer happened in the meantime.
        const seqAtPose = state.seq
        setTimeout(() => {
          if (state.seq === seqAtPose && state.emotion === emotion) {
            bump({ status: 'idle', actionName: '', emotion: 'walking' })
            log(`gift pose ended after ${poseSec}s -> walking`)
          }
        }, poseSec * 1000)
      }
    } catch (error) {
      const message = String(error && error.message ? error.message : error)
      bump({ status: 'idle', lastError: message })
      log(`turn failed: ${message}`)
    }
  }

  async function drain() {
    if (running) return
    running = true
    try {
      while (queue.length > 0) {
        const bullet = queue.shift()
        const now = Date.now()
        while (replyTimes.length > 0 && now - replyTimes[0] > 60000) replyTimes.shift()
        if (replyTimes.length >= (Number(config.maxPerMinute) || 15)) {
          log('rate limit reached, dropping danmaku')
          continue
        }
        replyTimes.push(Date.now())
        await handle(bullet)
        if (queue.length > 0) await new Promise((done) => setTimeout(done, Number(config.minReplyGapMs) || 1200))
      }
    } finally {
      running = false
    }
  }

  async function poll() {
    enforceSinglePetWindow()
    if (!alive) return
    if (!ownsPoller()) {
      alive = false
      log('另一个插件实例接管了轮询，本实例停止（避免弹幕被处理两遍）')
      if (timer) { clearTimeout(timer); timer = null }
      return
    }
    let live
    try {
      live = await fetchState(config)
    } catch (error) {
      if (state.status !== 'offline') {
        bump({ status: 'offline', lastError: `连不上直播服务：${error && error.message ? error.message : error}` })
        log(`live project unreachable: ${error && error.message ? error.message : error}`)
      }
      return
    }
    const musicQueue = live && typeof live.music_queue === 'object' && live.music_queue ? live.music_queue : null
    const currentSong = musicQueue && typeof musicQueue.current === 'object' && musicQueue.current ? musicQueue.current : null
    state.live = {
      requests: live.requests,
      gifts: live.gifts,
      gift_value: live.gift_value,
      input_tokens: live.input_tokens,
      output_tokens: live.output_tokens,
      started_at: live.started_at,
      music: live.music,
      songs: musicQueue === null ? null : {
        playing: musicQueue.playing === true,
        title: currentSong === null ? '' : String(currentSong.title || '').slice(0, 60),
        user: currentSong === null ? '' : String(currentSong.user || '').slice(0, 24),
        duration: currentSong === null ? 0 : Number(currentSong.duration) || 0,
        elapsed: Number(musicQueue.elapsed) || 0,
        len: Number(musicQueue.queue_len) || (Array.isArray(musicQueue.queue) ? musicQueue.queue.length : 0),
        queue: (Array.isArray(musicQueue.queue) ? musicQueue.queue : []).slice(0, 6).map((item) => ({
          title: String((item && item.title) || '').slice(0, 40),
          user: String((item && item.user) || '').slice(0, 20),
        })),
      },
    }
    const settings = live && typeof live.settings === 'object' && live.settings ? live.settings : null
    if (settings !== null) {
      liveVoice = {
        voice: String(settings.voice || ''),
        rate: String(settings.rate || ''),
        pitch: String(settings.pitch || ''),
      }
    }
    if (state.status === 'offline') bump({ status: 'idle', lastError: '' })

    const kinds = Array.isArray(config.replyKinds) ? config.replyKinds : ['comment']

    // Preferred source: the raw inbound feed (needs the patched app.py).
    if (config.mode !== 'mirror' && Date.now() >= feedRetryAt) {
      try {
        const response = await fetch(`${appBase()}/api/feed?since=${feedSince === null ? 0 : feedSince}&limit=50&claim=1`, {
          signal: AbortSignal.timeout(4000),
        })
        if (!response.ok) throw new Error(`feed HTTP ${response.status}`)
        const payload = await response.json()
        const rows = Array.isArray(payload.events) ? payload.events : []
        const last = Number(payload.last) || 0
        if (feedSince === null) {
          feedSince = last
          log(`feed attached at id ${last} (takeover mode)`)
        } else {
          if (last < feedSince) {
            // The live instance restarted: its ring buffer starts counting again.
            log(`feed id went backwards (${feedSince} -> ${last}); resubscribing from 0`)
            feedSince = 0
            seenFeedIds.clear()
          }
          for (const row of rows) {
            if (!row || Number(row.id) <= feedSince) continue
            feedSince = Number(row.id) || feedSince
            const rowId = Number(row.id) || 0
            if (rowId > 0) {
              if (seenFeedIds.has(rowId)) continue
              seenFeedIds.add(rowId)
              if (seenFeedIds.size > 800) seenFeedIds.clear()
            }
            const kind = String(row.kind || 'comment')
            const user = String(row.user || '')
            if (kind === 'enter') {
              pushPool({ kind: 'enter', user, text: '' })
              if (config.welcomeEnter === true && welcomeUserAllowed(user)) {
                if (config.welcomeFast === true) {
                  // 固定话术：1.2 秒合并一批，不等模型
                  addFastEnter(shortName(user))
                } else {
                  // 合并欢迎：先进缓冲，2.5 秒内的进场凑一批一起打招呼
                  addPendingEnter(shortName(user))
                }
              }
              continue
            }
            if (kind === 'follow') {
              pushPool({ kind: 'follow', user, text: '' })
              if (config.thanksFollow === true) {
                const tpl = String(config.followLine || '谢谢 {user} 关注，么么哒～')
                void speakFixed(tpl.replace('{user}', shortName(user) || user), 'happy')
              }
              continue
            }
            if (kind === 'like') {
              pushPool({ kind: 'like', user, text: '' })
              if (config.thanksLike === true) addLikeThanks(shortName(user) || user)
              continue
            }
            if (kind === 'gift') {
              const giftName = String(row.text || '').trim().slice(0, 20)
              pushPool({ kind: 'gift', user, text: giftName })
              const presetLine = String(row.line || '').trim()
              if (config.thanksGift === true && presetLine !== '') {
                // app 已按礼物动作生成了带主题的话术：直接念，不等模型（快，也不会被工具报错打断）
                void speakFixed(presetLine, '')
              } else if (config.thanksGift === true && giftName !== '' && shouldThankGift(user)) {
                queue.push({ user, text: giftName, kind, gift: giftName })
              }
              continue
            }
            if (!kinds.includes(kind)) continue
            pushPool({ kind, user, text: String(row.text || '') })
            queue.push({ user, text: String(row.text || ''), kind })
          }
          if (rows.length === 0) feedSince = Math.max(feedSince, last)
        }
        if (queue.length > 0 && !running) {
          log(`queued ${queue.length} danmaku (feed) [${instanceId}]`)
          await drain()
        }
        return
      } catch (error) {
        feedRetryAt = Date.now() + 30000
        log(`feed unavailable (${error && error.message ? error.message : error}); retrying in 30s, mirroring meanwhile. 重打包/重启直播服务后自动接管。`)
      }
    }

    if (config.mode === 'takeover') return

    // Mirror mode: follow the live project's own replies. The pet still talks and
    // moves, it just borrows the live project's brain until /api/feed exists.
    const audioId = Number(live.audio_id) || 0
    if (mirrorAudioId === null) {
      mirrorAudioId = audioId
      log(`mirror mode attached at audio id ${audioId}`)
      return
    }
    if (audioId === mirrorAudioId) return
    mirrorAudioId = audioId
    const say = String(live.reply || '').trim()
    if (say === '') return
    bump({
      status: 'speaking',
      say,
      emotion: emotionFromLive(live),
      user: String(live.username || ''),
      kind: 'reply',
      audioPath: resolveAudioFile(config, live.audio_url),
      audioDuration: Number(live.audio_duration) || 0,
      lastError: '',
    })
    log(`mirror reply: ${say}`)
  }

  function schedule() {
    if (!alive) return
    timer = setTimeout(async () => {
      try { await poll() } catch (error) { log(`poll error: ${error && error.message ? error.message : error}`) }
      if (alive) schedule()
    }, Math.max(300, Number(config.pollMs) || 800))
  }

  /* ---- 直播场景（背景图 + 弹幕池 + 点歌台） ---------------------------- */

  let sceneChild = null
  let sceneRectCache = null

  /** 主屏工作区（屏幕坐标），用来摆场景窗口、限制宠物活动范围。 */
  function screenWorkArea() {
    if (sceneRectCache !== null) return sceneRectCache
    const fallback = { left: 0, top: 0, width: 1920, height: 1040 }
    try {
      const script = "Add-Type -AssemblyName System.Windows.Forms; $wa=[System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea; '{0},{1},{2},{3}' -f $wa.Left,$wa.Top,$wa.Width,$wa.Height"
      const out = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 8000,
      })
      const parts = String(out.stdout || '').trim().split(',').map((piece) => Number(piece))
      if (parts.length === 4 && parts.every((num) => Number.isFinite(num)) && parts[2] > 200) {
        sceneRectCache = { left: parts[0], top: parts[1], width: parts[2], height: parts[3] }
        return sceneRectCache
      }
    } catch {
      // 取不到就用兜底值
    }
    sceneRectCache = fallback
    return sceneRectCache
  }

  /** 往弹幕池里塞一条（直播场景左上角用），最多留 80 条。 */
  function pushPool(entry) {
    if (!entry) return
    state.pool.push({
      kind: String(entry.kind || 'comment'),
      user: String(entry.user || '').slice(0, 24),
      text: String(entry.text || '').slice(0, 120),
      at: Date.now(),
    })
    if (state.pool.length > 80) state.pool.splice(0, state.pool.length - 80)
  }


  function sceneImagePath() {
    const custom = String(config.sceneImage || '').trim()
    if (custom !== '' && existsSync(custom)) return custom
    const bundled = join(PKG_DIR, 'bg', 'scene.jpg')
    return existsSync(bundled) ? bundled : ''
  }

  function scenePayload() {
    const enabled = config.sceneEnabled === true
    const rect = screenWorkArea()
    return {
      enabled,
      bubbleFontSize: Math.max(10, Math.min(60, Number(config.bubbleFontSize) || 20)),
      poolFontSize: Math.max(10, Math.min(60, Number(config.poolFontSize) || 20)),
      imageUrl: enabled && sceneImagePath() !== '' ? '/dsh-live-pet/scene/bg?t=' + Math.round(Date.now() / 60000) : '',
      // 宠物窗口要的是本地绝对路径（它自己画背景，不走 HTTP）
      imagePath: enabled ? sceneImagePath() : '',
      // 宠物只能在背景里活动：把这块矩形交给宠物窗口
      bounds: enabled ? rect : null,
    }
  }

  function edgePath() {
    const candidates = [
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    ]
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate
    }
    return ''
  }

  function closeScene() {
    const child = sceneChild
    sceneChild = null
    if (!child) return false
    try { child.kill('SIGKILL') } catch { /* 已经退出 */ }
    log('scene window closed')
    return true
  }

  function openScene() {
    if (config.sceneEnabled !== true) return false
    const edge = edgePath()
    if (edge === '') { log('scene: 没找到 Edge，场景窗口起不来'); return false }
    let origin = ''
    try { origin = ctx.webServer.getOrigin() } catch { origin = '' }
    if (origin === '') { log('scene: webServer origin 拿不到'); return false }
    closeScene()
    const rect = screenWorkArea()
    const profileDir = join(PKG_DIR, 'scene-profile')
    try { mkdirSync(profileDir, { recursive: true }) } catch { /* 已存在 */ }
    try {
      sceneChild = spawn(edge, [
        '--app=' + origin + '/dsh-live-pet/scene',
        '--window-position=' + rect.left + ',' + rect.top,
        '--window-size=' + rect.width + ',' + rect.height,
        '--user-data-dir=' + profileDir,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-features=Translate,MediaRouter',
        '--autoplay-policy=no-user-gesture-required',
        '--hide-crash-restore-bubble',
      ], { windowsHide: false, stdio: 'ignore', detached: false })
      sceneChild.on('exit', (code) => {
        log('scene window exited (' + code + ')')
        sceneChild = null
      })
      sceneChild.on('error', (error) => log('scene window failed: ' + (error && error.message ? error.message : error)))
      log('scene window started (pid ' + sceneChild.pid + ') ' + rect.width + 'x' + rect.height)
      // 起完把它提到最前面（宠物是 topmost，会自然盖在场景上面）
      const raiseScript = join(PKG_DIR, 'scene-raise.ps1')
      if (existsSync(raiseScript)) {
        spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', raiseScript, '-ScenePid', String(sceneChild.pid), '-PetPid', String(petChild && petChild.pid ? petChild.pid : 0)], {
          windowsHide: true,
          stdio: 'ignore',
        })
      }
      return true
    } catch (error) {
      log('scene spawn failed: ' + (error && error.message ? error.message : error))
      return false
    }
  }

  /* ---- pet window ------------------------------------------------------ */

  /**
   * 清掉多余的宠物窗口。keepOldest = 只保留启动最早的那个。
   * 注意：killer 自己的命令行里也含 pet.ps1，必须排除自身和同类进程，
   * 否则它可能把自己干掉，半路就停手了（历史上真出现过窗口残留）。
   */
  function killStalePetWindows(keepOldest = false) {
    try {
      const escaped = PET_SCRIPT.replace(/'/g, "''")
      const match = "$_.CommandLine -like '*" + escaped + "*' -and $_.CommandLine -notlike '*Stop-Process*' -and $_.ProcessId -ne $PID"
      const tail = keepOldest
        ? '| Sort-Object CreationDate | Select-Object -Skip 1 | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }'
        : '| ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }'
      const script = "Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | Where-Object { " + match + " } " + tail
      spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
        windowsHide: true,
        stdio: 'ignore',
      })
      return true
    } catch {
      return false
    }
  }

  /** 定时体检：桌面上只允许留一个宠物窗口，多出来的（旧脚本残留）清掉。 */
  let lastPetCheckAt = 0
  function enforceSinglePetWindow() {
    const now = Date.now()
    if (now - lastPetCheckAt < 20000) return
    lastPetCheckAt = now
    try {
      const escaped = PET_SCRIPT.replace(/'/g, "''")
      const script = "Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\""
        + " | Where-Object { $_.CommandLine -like '*" + escaped + "*' -and $_.CommandLine -notlike '*Stop-Process*' -and $_.ProcessId -ne $PID }"
        + " | Sort-Object CreationDate | Select-Object -Skip 1"
        + " | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
      spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
        windowsHide: true,
        stdio: 'ignore',
      })
    } catch {
      // 体检失败不影响主流程
    }
  }

  function startPet() {
    if (!existsSync(PET_SCRIPT)) {
      log(`pet script missing: ${PET_SCRIPT}`)
      return
    }
    let origin = ''
    try { origin = ctx.webServer.getOrigin() } catch { origin = '' }
    const stateUrl = origin === '' ? '' : `${origin}/dsh-live-pet/state`
    if (stateUrl === '') {
      log('webServer origin unavailable; the pet window needs the /dsh-live-pet/state route')
      return
    }
    const killed = killStalePetWindows()
    // 孤儿窗口还占着互斥量时新窗口会立刻退出，等一下再起
    setTimeout(() => {
      if (!alive) return
      try {
        petChild = spawn('powershell.exe', [
          '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', PET_SCRIPT,
        ], {
          cwd: PKG_DIR,
          env: { ...process.env, PET_STATE_URL: stateUrl, PET_FRAMES: FRAMES_DIR, PET_SILENT: config.petSilent ? '1' : '0', PET_LIVE_BASE: appBase() },
          stdio: 'ignore',
          windowsHide: true,
          detached: false,
        })
        petChild.on('exit', (code) => {
          log(`pet window exited (${code})`)
          petChild = null
        })
        petChild.on('error', (error) => log(`pet window failed: ${error && error.message ? error.message : error}`))
        log(`pet window started (pid ${petChild.pid}) -> ${stateUrl}${killed ? ' (cleared stale windows first)' : ''}`)
      } catch (error) {
        log(`pet window spawn failed: ${error && error.message ? error.message : error}`)
      }
    }, killed ? 1200 : 0)
  }

  function stopPet() {
    if (petChild && petChild.pid) {
      try {
        spawn('taskkill', ['/PID', String(petChild.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      } catch { /* ignore */ }
      petChild = null
    }
  }

  /* ---- routes ---------------------------------------------------------- */

  /** The plugin's own knobs, as the settings page sees them. */
  function pickPetConfig() {
    const out = {}
    for (const key of PET_CONFIG_KEYS) out[key] = config[key]
    return out
  }

  /** The live project's editable settings (read from its own /api/state). */
  async function liveSnapshot() {
    try {
      const response = await fetch(`${appBase()}/api/state`, { signal: AbortSignal.timeout(5000) })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const payload = await response.json()
      const s = payload && typeof payload.settings === 'object' && payload.settings ? payload.settings : {}
      return {
        ok: true,
        settings: {
          douyin: s.douyin || {},
          songs: s.songs || {},
          gift_actions: s.gift_actions || {},
          voice: s.voice || '',
          rate: s.rate || '',
          pitch: s.pitch || '',
          harness: { enable: Boolean(s.harness && s.harness.enable) },
          idle: { enable: Boolean(s.idle && s.idle.enable) },
          promo: { enable: Boolean(s.promo && s.promo.enable) },
        },
      }
    } catch (error) {
      return { ok: false, error: String(error && error.message ? error.message : error), settings: null }
    }
  }

  function sendJson(res, value) {
    const body = Buffer.from(JSON.stringify(value), 'utf8')
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': body.length,
      'cache-control': 'no-store',
    })
    res.end(body)
  }

  function readJsonBody(req, limitBytes = 8192) {    return new Promise((resolve) => {
      const chunks = []
      let size = 0
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > limitBytes) {
          chunks.length = 0
          req.destroy()
          resolve(null)
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        try {
          const text = Buffer.concat(chunks).toString('utf8').trim()
          resolve(text === '' ? {} : JSON.parse(text))
        } catch {
          resolve(null)
        }
      })
      req.on('error', () => resolve(null))
    })
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/dsh-live-pet',
    handler: async (req, res) => {
      const url = typeof req.url === 'string' ? req.url : ''
      const queryAt = url.indexOf('?')
      const pathname = (queryAt === -1 ? url : url.slice(0, queryAt)).replace(/\/+$/, '')
      const searchParams = new URLSearchParams(queryAt === -1 ? '' : url.slice(queryAt + 1))

      /* ---- managed live-service instance: one-click start/stop --------- */
      /* ---- 直播服务依赖：检查 + 一键安装 ------------------------------- */
      if (pathname === '/dsh-live-pet/deps' && req.method === 'GET') {
        const deps = await checkLiveDeps(config.pythonBin)
        const workspace = liveWorkspaceOf(config)
        sendJson(res, {
          ...deps,
          workspace,
          bundled: existsSync(join(PKG_DIR, 'live', 'app.py')),
          requirements: existsSync(join(workspace, 'requirements.txt')),
        })
        return
      }
      if (pathname === '/dsh-live-pet/deps' && req.method === 'POST') {
        const body = await readJsonBody(req, 8192)
        if (!body || body.action !== 'install') {
          sendJson(res, { ok: false, error: 'action 必须是 install' })
          return
        }
        const workspace = liveWorkspaceOf(config)
        const reqFile = join(workspace, 'requirements.txt')
        const args = existsSync(reqFile)
          ? ['-m', 'pip', 'install', '-r', reqFile]
          : ['-m', 'pip', 'install', 'edge-tts', 'websocket-client', 'requests', 'betterproto', 'py-mini-racer', 'PyExecJS', 'protobuf']
        log(`installing live deps via ${String(config.pythonBin || 'python')} ${args.join(' ')}`)
        const result = await runProcess(String(config.pythonBin || 'python'), args, { cwd: workspace, timeoutMs: 300000 })
        const tail = ((result.stdout || '') + '\n' + (result.stderr || '')).trim().split('\n').filter(Boolean).slice(-6).join(' | ')
        log(`pip install exit ${result.code}: ${tail.slice(0, 200)}`)
        const after = await checkLiveDeps(config.pythonBin)
        sendJson(res, {
          ok: result.code === 0 && after.missing.length === 0,
          exit: result.code,
          output: tail.slice(0, 900),
          missing: after.missing,
        })
        return
      }
      if (pathname === '/dsh-live-pet/live' && req.method === 'GET') {
        sendJson(res, { ok: true, status: await liveStatus() })
        return
      }
      if (pathname === '/dsh-live-pet/live' && req.method === 'POST') {
        const body = await readJsonBody(req, 8192)
        const action = body && typeof body.action === 'string' ? body.action : ''
        if (action === 'start') {
          const result = await startLive()
          sendJson(res, { ...result, status: await liveStatus() })
          return
        }
        if (action === 'stop') {
          const result = await stopLive()
          sendJson(res, { ...result, status: await liveStatus() })
          return
        }
        if (action === 'restart') {
          await stopLive()
          await sleep(800)
          const result = await startLive()
          sendJson(res, { ...result, status: await liveStatus() })
          return
        }
        sendJson(res, { ok: false, error: 'action 必须是 start / stop / restart' })
        return
      }

      /* ---- settings page: plugin config + live-project config ---------- */
      if (pathname === '/dsh-live-pet/config' && req.method === 'GET') {
        sendJson(res, {
          ok: true,
          pet: pickPetConfig(),
          live: await liveSnapshot(),
          configFile: CONFIG_FILE,
          profile: config.profile,
        })
        return
      }
      if (pathname === '/dsh-live-pet/config' && req.method === 'POST') {
        const body = await readJsonBody(req, 65536)
        if (body === null || typeof body !== 'object') {
          sendJson(res, { ok: false, error: '请求体不是合法 JSON' })
          return
        }
        const result = { ok: true, petSaved: false, liveSaved: false, liveError: '' }
        if (body.pet && typeof body.pet === 'object') {
          for (const key of PET_CONFIG_KEYS) {
            if (Object.prototype.hasOwnProperty.call(body.pet, key)) config[key] = body.pet[key]
          }
          try {
            writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8')
            result.petSaved = true
            log('plugin config updated from the settings page')
            if (Object.prototype.hasOwnProperty.call(body.pet, 'persona')) {
              const rebuilt = ensurePetProfile(config)
              result.profileRebuilt = rebuilt.ok === true
              log('persona updated -> pet profile ' + (rebuilt.ok === true ? 'rebuilt' : ('rebuild failed: ' + rebuilt.reason)))
              if (Object.prototype.hasOwnProperty.call(body.pet, 'sceneEnabled')) {
                log('scene toggled by settings: ' + (config.sceneEnabled === true ? 'on' : 'off'))
              }
              clearSession(config.sessionKey)
              state.session = ''
              log('persona changed -> pet session reset')
            }
          } catch (error) {
            result.ok = false
            result.error = `写 config.json 失败：${error && error.message ? error.message : error}`
          }
        }
        if (body.live && typeof body.live === 'object') {
          const payload = {}
          for (const key of LIVE_CONFIG_KEYS) {
            if (body.live[key] !== undefined && body.live[key] !== null) payload[key] = body.live[key]
          }
          if (Object.keys(payload).length > 0) {
            try {
              const response = await fetch(`${appBase()}/api/config`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(payload),
                signal: AbortSignal.timeout(10000),
              })
              result.liveSaved = response.ok
              if (!response.ok) result.liveError = `直播服务返回 HTTP ${response.status}`
            } catch (error) {
              result.liveError = `连不上直播服务：${error && error.message ? error.message : error}`
            }
          }
        }
        const snapshot = await liveSnapshot()
        sendJson(res, { ...result, pet: pickPetConfig(), live: snapshot })
        return
      }

      if (req.method === 'POST' && pathname === '/dsh-live-pet/chat') {
        if (config.chatEnabled !== true) {
          sendJson(res, { ok: false, error: '聊天输入已关闭（config.chatEnabled）' })
          return
        }
        const body = await readJsonBody(req)
        const text = body && typeof body.text === 'string' ? body.text.replace(/\s+/g, ' ').trim() : ''
        if (text === '') {
          sendJson(res, { ok: false, error: 'text 必填' })
          return
        }
        queue.push({ user: '老板', text: text.slice(0, 400), kind: 'chat', chat: true })
        log(`chat from owner: ${text.slice(0, 80)}`)
        if (!running) void drain()
        sendJson(res, { ok: true, queued: queue.length })
        return
      }

      if (pathname === '/dsh-live-pet/state') {
        sendJson(res, {
          ...state,
          speaking: state.audioPath !== '' && Date.now() - state.at < Math.max(2000, state.audioDuration * 1000 + 1500),
          // 直播场景：背景图、字号、宠物可活动范围（屏幕坐标）
          scene: scenePayload(),
          config: { speak: config.speak, petSilent: config.petSilent, profile: config.profile, appUrl: appBase(), manageLive: config.manageLive === true, livePort: config.livePort },
    // 宠物窗口每轮都读这段：改了设置立刻生效，不用重开窗口
    wander: {
      enabled: config.wander !== false,
      speed: Math.max(10, Math.min(400, Number(config.wanderSpeed) || 55)),
      dwellMinSec: Math.max(1, Math.min(120, Number(config.wanderDwellMinSec) || 6)),
      dwellMaxSec: Math.max(1, Math.min(300, Number(config.wanderDwellMaxSec) || 18)),
    },
        })
        return
      }
      /* ---- 直播场景页 + 背景图 ------------------------------------------ */
      if (pathname === '/dsh-live-pet/scene') {
        try {
          const html = readFileSync(join(PKG_DIR, 'scene', 'index.html'))
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
          res.end(html)
        } catch (error) {
          res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('场景页缺失: ' + (error && error.message ? error.message : error))
        }
        return
      }
      /* ---- 可选背景图列表 ------------------------------------------------ */
      if (pathname === '/dsh-live-pet/scene/backgrounds') {
        const dir = join(PKG_DIR, 'bg')
        const items = []
        try {
          for (const entry of readdirSync(dir)) {
            if (!/\.(jpe?g|png|webp)$/i.test(entry)) continue
            const full = join(dir, entry)
            let size = 0
            try { size = statSync(full).size } catch { size = 0 }
            items.push({ name: entry, path: full, size })
          }
        } catch {
          // 没有 bg 目录就返回空列表
        }
        items.sort((a, b) => a.name.localeCompare(b.name))
        const custom = String(config.sceneImage || '').trim()
        sendJson(res, {
          ok: true,
          dir,
          current: custom,
          items,
        })
        return
      }

      if (pathname === '/dsh-live-pet/scene/bg') {
        const file = sceneImagePath()
        if (file === '') {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('没有背景图')
          return
        }
        try {
          const data = readFileSync(file)
          const lower = file.toLowerCase()
          const type = lower.endsWith('.png') ? 'image/png' : lower.endsWith('.webp') ? 'image/webp' : 'image/jpeg'
          res.writeHead(200, { 'content-type': type, 'cache-control': 'public, max-age=600' })
          res.end(data)
        } catch (error) {
          res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('读背景图失败: ' + (error && error.message ? error.message : error))
        }
        return
      }

      if (pathname === '/dsh-live-pet/log') {
        sendJson(res, { lines: logTail(60) })
        return
      }
      if (pathname === '/dsh-live-pet/reset') {
        clearSession(config.sessionKey)
        state.session = ''
        log('session reset by request')
        sendJson(res, { ok: true })
        return
      }
      if (pathname === '/dsh-live-pet/selftest') {
        // Diagnostic: run one real DSH turn without waiting for a danmaku.
        handle({ user: '自检', text: '主播今天播多久了？', kind: 'comment' })
          .then(() => sendJson(res, { ok: true, state }))
          .catch((error) => sendJson(res, { ok: false, error: String(error && error.message ? error.message : error), state }))
        return
      }
      if (pathname === '/dsh-live-pet/idle') {
        // Diagnostic: ask the pet to break the silence right now.
        handle({ user: '主播', text: '', kind: 'idle', idle: true })
          .then(() => sendJson(res, { ok: true, state }))
          .catch((error) => sendJson(res, { ok: false, error: String(error && error.message ? error.message : error), state }))
        return
      }
      if (pathname === '/dsh-live-pet/action') {
        // Diagnostic: perform a gift action by name, e.g. ?gift=小星星&user=测试
        const query = url.indexOf('?') === -1 ? '' : url.slice(url.indexOf('?') + 1)
        const params = new URLSearchParams(query)
        const gift = params.get('gift') || ''
        const user = params.get('user') || '测试观众'
        if (gift === '') {
          sendJson(res, { ok: false, error: 'gift 参数必填' })
          return
        }
        performGiftAction(gift, user)
          .then(() => sendJson(res, { ok: true, state }))
          .catch((error) => sendJson(res, { ok: false, error: String(error && error.message ? error.message : error), state }))
        return
      }
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('not found')
    },
  }))

  /* ---- lifecycle ------------------------------------------------------- */

  /** Break the silence on its own when the room goes quiet (the live project's own idle is off). */
  function scheduleIdle() {
    if (!alive) return
    idleTimer = setTimeout(async () => {
      try {
        const gap = Number(config.idleEverySec) || 150
        if (config.idleChat && !running && state.status !== 'offline' && Date.now() - lastActivity >= gap * 1000) {
          lastActivity = Date.now()
          log(`idle for ${Math.round(gap)}s, talking on its own`)
          await handle({ user: '主播', text: '', kind: 'idle', idle: true })
        }
      } catch (error) {
        log(`idle talk failed: ${error && error.message ? error.message : error}`)
      }
      scheduleIdle()
    }, 15000)
  }

  ctx.effect(() => {
    claimPoller()
    log(`dsh-live-pet activated (instance ${instanceId})`)
    if (config.manageLive === true) {
      log(`live service is managed by this bundle (port ${Number(config.livePort) || 8791}, base ${liveBaseDirPath()})`)
      if (config.autoStartLive === true) {
        void startLive().then((result) => {
          if (result.ok === true) log('managed live service is up')
          else log(`managed live service failed to start: ${result.error}`)
        })
      }
    }
    schedule()
    if (config.idleChat) scheduleIdle()
    if (config.autoStartPet) startPet()
    closeScene()
    return () => {
      alive = false
      if (timer) clearTimeout(timer)
      timer = null
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = null
      stopPet()
      closeScene()
      if (config.manageLive === true) void stopLive()
      log('dsh-live-pet disposed')
    }
  })
}
