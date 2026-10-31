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
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-live-pet'

/** The web server carries the pet's state route; everything else is optional. */
export const inject = ['webServer']

/**
 * 数据/资源目录：
 *  - 作为 DSH 插件跑：插件包自己的目录
 *  - 作为独立 exe 跑：用 DSH_LIVE_PET_HOME 指到解包出来的资源目录
 */
const PKG_DIR = (() => {
  const override = String(process.env.DSH_LIVE_PET_HOME || '').trim()
  if (override !== '') return override.replace(/[\\/]+$/, '')
  try {
    return fileURLToPath(new URL('./', import.meta.url))
  } catch {
    return process.cwd()
  }
})()
const FRAMES_DIR = join(PKG_DIR, 'frames')
const PET_SCRIPT = join(PKG_DIR, 'pet.ps1')
const CONFIG_FILE = join(PKG_DIR, 'config.json')
const SESSION_FILE = join(PKG_DIR, 'session.json')
const LOG_FILE = join(PKG_DIR, 'live-pet.log')

const EMOTIONS = ['happy', 'mischievous', 'crying', 'unhappy', 'eating', 'cooking', 'coding', 'tv', 'walking']

/** Plugin keys the settings page may write. */
const PET_CONFIG_KEYS = [
  'eyesEnabled',
  'eyesEverySec',
  'eyesWidth',
  'sceneEnabled',
  'sceneImage',
  'sceneMinimized',
  'bubbleFontSize',
  'poolFontSize',
  'wander',
  'wanderSpeed',
  'wanderDwellMinSec',
  'wanderDwellMaxSec',
  'persona',
  'petName',
  'posesCustom',
  'multiAgent',
  'skinDir',
  'mode', 'profile', 'manageProfile', 'appUrl', 'pollMs', 'replyKinds',
  // 独立 exe 里这些必须能在设置页改：模型/密钥/各种可执行文件与目录
  'provider', 'model', 'baseUrl', 'apiKey', 'apiKeyEnv',
  'dshBin', 'nodeBin', 'pythonBin', 'workspace', 'audioDir', 'appPort',
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
  /**
   * 背景窗口「最小化」：直播场景仍然生效，但把背景图 + 弹幕池 + 点歌台 + 数据面板收起来，
   * 窗口缩回只留宠物。想彻底关掉背景就把 sceneEnabled 设成 false。
   */
  sceneMinimized: false,
  /** 宠物自己的名字（气泡落款、弹幕池署名） */
  petName: '大肥鲸',
  /**
   * 形象包目录（里面按情绪分文件夹：happy/ mischievous/ …，每张 png 一帧）。
   * 留空 = 用自带的 frames；填别的目录就换形象，宠物窗口会重启一次。
   */
  skinDir: '',
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
  /** 独立 exe 的设置页/接口端口（只有 app/main.js 用；插件里忽略） */
  appPort: 8899,
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
  timeoutMs: 45000,
  // 眼睛：让智能体随时知道桌面上在发生什么
  eyesEnabled: true,
  eyesEverySec: 90,
  eyesWidth: 700,
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
  /**
   * 自定义动作：{ id, label, emotion, sec, fx }，和内置动作库（POSES）合并。
   * emotion 只能是 9 种帧序列之一；fx 取 none|squash|firework|shake|spin|hop。
   */
  posesCustom: [],
  /**
   * 双智能体：主播（A，就是这只鲸鱼）和另一只 AI（B）连麦聊天/抬杠，观众弹幕可以插话。
   * B 默认共用同一个 DSH profile，但用自己的会话和人设；把 profileB 填上就换成另一个 profile。
   */
  multiAgent: {
    enabled: false,
    /** argue = 互相抬杠，chat = 一起聊 */
    mode: 'argue',
    nameB: '小海豚',
    /** 留空 = 用内置的「抬杠搭子」人设 */
    personaB: '',
    /** 留空 = 跟主宠物同一个 DSH profile，仅会话隔离 */
    profileB: '',
    /** 两句之间歇多久 */
    turnGapSec: 3,
    /** 一波最多来回几轮 */
    roundsPerBurst: 8,
    /** 一波聊完歇多久再开下一波 */
    quietSec: 60,
    /** 弹幕静默多久之后自己聊起来 */
    idleStartSec: 45,
    /** 观众弹幕可以插话（排队优先，默认开） */
    audienceJoin: true,
    /** 桌面上一只 A + 一只 B；关掉就只留主宠物说话（B 的话会显示在 A 的气泡里） */
    showPetB: true,
  },
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
  const merged = { ...DEFAULTS, ...(fileConfig && typeof fileConfig === 'object' ? fileConfig : {}) }
  // 嵌套对象要逐字段合并，否则老配置文件会把新加的字段吃掉
  merged.multiAgent = {
    ...DEFAULTS.multiAgent,
    ...(fileConfig && typeof fileConfig.multiAgent === 'object' && fileConfig.multiAgent ? fileConfig.multiAgent : {}),
  }
  if (!Array.isArray(merged.posesCustom)) merged.posesCustom = []
  sanitizePaths(merged)
  return merged
}

/**
 * 老配置里常留着 F:\\douyinlive 这种本机已经没有的路径。
 * 直接照着跑的话：后端连不上、点歌音频写不出去，表现出来就是「功能没生效」。
 * 这里只做兜底纠正，找不到就落到插件目录下的可用位置。
 */
function sanitizePaths(config) {
  const isDir = (target) => {
    try { return statSync(String(target)).isDirectory() } catch { return false }
  }
  const workspace = String(config.workspace || '').trim()
  if (workspace === '' || !isDir(workspace)) {
    const fallback = liveWorkspaceOf(config) || PKG_DIR
    if (workspace !== fallback) {
      log(`workspace 不存在（${workspace || '空'}），改用 ${fallback}`)
      config.workspace = fallback
    }
  }
  const audioDir = String(config.audioDir || '').trim()
  if (audioDir === '' || !isDir(dirname(audioDir))) {
    const base = String(config.liveBaseDir || '').trim() || join(PKG_DIR, 'live-data')
    const fallback = join(base, 'data', 'audio')
    if (audioDir !== fallback) {
      log(`audioDir 不可用（${audioDir || '空'}），改用 ${fallback}`)
      config.audioDir = fallback
    }
  }
  return config
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

  const roots = [
    process.env.DSH_ROOT,
    process.env.FATWHALE_DSH_ROOT,
    'F:\\tool\\deepseek\\resources',
    'D:\\tools\\deepseek\\resources',
    join(homedir(), '.dsh', 'dsh-app'),
    join(homedir(), '.dsh'),
  ].filter((value) => typeof value === 'string' && value.trim() !== '')

  const binCandidates = [config.dshBin, process.env.DSH_BIN].filter(
    (value) => typeof value === 'string' && value.trim() !== '',
  )
  // 各种装法都试一遍：<root>/app/dsh、<root>/app.asar/dsh、<root>/dsh、<root> 本身
  const middles = ['app/dsh', 'app.asar/dsh', 'dsh', '']
  for (const root of roots) {
    for (const middle of middles) {
      binCandidates.push(join(root, middle, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
    }
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
    { cwd: spawnCwd(config), timeoutMs: 25000, env: { FATWHALE_BASE_DIR: (String(config.liveBaseDir || '').trim() || join(PKG_DIR, 'live-data')), PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } },
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
  // 兜底：DSH 自己的 ~/.dsh/.env（独立 exe 没有 workspace 时靠它也能跑起来）
  try {
    const envFile = join(process.env.DSH_HOME || join(homedir(), '.dsh'), '.env')
    const wanted = String(config.apiKeyEnv || 'BUDDYHUB_API_KEY')
    for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
      if (!match) continue
      if (match[1] !== wanted && match[1] !== 'BUDDYHUB_API_KEY') continue
      const key = match[2].trim().replace(/^["']|["']$/g, '')
      if (key !== '') return key
    }
  } catch { /* 没有 .env 就算了 */ }
  return ''
}

/* ------------------------------------------- 看一眼主播的桌面（视觉）
 * 思路：PowerShell + .NET 抓主屏 → 缩到 1000px 宽存 PNG → 直接喂给支持看图
 * 的模型（config.provider/model/baseUrl/apiKey）→ 拿回一句话让人设化的点评。
 * 注意：PowerShell 脚本写得越花哨越容易被 AMSI 判为恶意脚本拦住，这里保持极简。
 */

/** 抓一张主屏截图，成功返回文件路径 */
function captureScreen(target, width) {
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms, System.Drawing',
    '$sc=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds',
    '$bmp=New-Object System.Drawing.Bitmap($sc.Width,$sc.Height)',
    '$g=[System.Drawing.Graphics]::FromImage($bmp)',
    '$g.CopyFromScreen($sc.X,$sc.Y,0,0,$bmp.Size)',
    '$g.Dispose()',
    '$w=' + String(Number(width) || 900) + '; $h=[int]($sc.Height*$w/$sc.Width)',
    '$small=New-Object System.Drawing.Bitmap($w,$h)',
    '$gs=[System.Drawing.Graphics]::FromImage($small)',
    '$gs.InterpolationMode=[System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic',
    '$gs.DrawImage($bmp,0,0,$w,$h)',
    '$gs.Dispose(); $bmp.Dispose()',
    `$small.Save('${target}',[System.Drawing.Imaging.ImageFormat]::Png)`,
    '$small.Dispose()',
    "Write-Output 'ok'",
  ].join('\n')
  const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    timeout: 25000,
    windowsHide: true,
    encoding: 'utf8',
  })
  if (result && result.error) throw new Error(`截图失败：${result.error.message}`)
  if (!existsSync(target)) {
    const tail = String((result && (result.stderr || result.stdout)) || '').trim().slice(-200)
    throw new Error(`截图没生成${tail === '' ? '' : '：' + tail}`)
  }
  return target
}

/**
 * 老板丢过来一张图时用：任何格式（gif/bmp/超大 png）先归一化成宽 900 的 PNG，
 * 视觉接口只认静态图，GIF 只取第一帧。
 */
function normalizeImage(source, target) {
  const script = [
    'Add-Type -AssemblyName System.Drawing',
    `$img=[System.Drawing.Image]::FromFile('${source}')`,
    '$w=900; if ($img.Width -lt $w) { $w=$img.Width }',
    '$h=[int]($img.Height*$w/$img.Width)',
    '$bmp=New-Object System.Drawing.Bitmap($w,$h)',
    '$g=[System.Drawing.Graphics]::FromImage($bmp)',
    '$g.InterpolationMode=[System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic',
    '$g.DrawImage($img,0,0,$w,$h)',
    '$g.Dispose()',
    `$bmp.Save('${target}',[System.Drawing.Imaging.ImageFormat]::Png)`,
    '$bmp.Dispose(); $img.Dispose()',
    "Write-Output 'ok'",
  ].join('\n')
  const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    timeout: 25000,
    windowsHide: true,
    encoding: 'utf8',
  })
  if (!existsSync(target)) {
    const tail = String((result && (result.stderr || result.stdout)) || '').trim().slice(-200)
    throw new Error(`图片读不出来${tail === '' ? '' : '：' + tail}`)
  }
  return target
}

/** 视觉调用花了多少 token 的上报钩子（插件闭包里注册，因为 state 在那里） */
let visionUsageSink = null

/** 把截图交给视觉模型，拿回一句话 */
async function describeScreen(config, question, imagePath, raw) {
  let file = join(PKG_DIR, `screen-${Date.now()}.png`)
  let temporary = true
  try {
    if (raw === true) {
      // 已经是现成的 PNG（眼睛定时抓的那张），直接发，别再多转一次
      file = imagePath
      temporary = false
    } else if (typeof imagePath === 'string' && imagePath.trim() !== '') {
      const source = imagePath.trim().replace(/^"|"$/g, '')
      if (!existsSync(source)) throw new Error(`找不到这张图：${source}`)
      normalizeImage(source, file)
    } else {
      captureScreen(file)
    }
    const base64 = readFileSync(file).toString('base64')
    const key = resolveApiKey(config)
    const base = String(config.baseUrl || 'https://api.deepseek.com/v1').replace(/\/+$/, '')
    const body = {
      model: String(config.model || 'deepseek-chat'),
      max_tokens: 500,
      temperature: 0.9,
      // 这个模型默认会先长篇思考，视觉问答只要一句话：关掉思考又快又不空
      reasoning_effort: 'none',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: question },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${base64}` } },
        ],
      }],
    }
    // apiKey 走 Authorization 头，不放 body
    const headers = { 'content-type': 'application/json' }
    if (key !== '') headers.authorization = `Bearer ${key}`
    const response = await fetch(`${base}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body) })
    const text = await response.text()
    if (!response.ok) throw new Error(`视觉接口 ${response.status}：${text.slice(0, 160)}`)
    let json = null
    try { json = JSON.parse(text) } catch { throw new Error(`视觉接口返回的不是 JSON：${text.slice(0, 120)}`) }
    const choice = json && json.choices && json.choices[0] ? json.choices[0] : {}
    // 看图也要记账：眼睛是定时跑的，不记的话用量面板会明显偏低
    // （describeScreen 在模块顶层，state 在插件闭包里，所以通过回调上报）
    const spent = json && json.usage ? json.usage : null
    if (spent && typeof visionUsageSink === 'function') {
      visionUsageSink(Number(spent.prompt_tokens) || 0, Number(spent.completion_tokens) || 0)
    }
    const message = choice.message || {}
    if (!message.content && choice.finish_reason === 'length') {
      throw new Error('视觉模型把 token 都花在思考上了（finish=length），换个模型或调大 max_tokens')
    }
    return String(message.content || '').trim()
  } finally {
    if (temporary) { try { rmSync(file, { force: true }) } catch { /* 删不掉就算了 */ } }
  }
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

/**
 * 给子进程用的 cwd：配置的 workspace 存在就用它，否则退到自带 live 目录 / 包目录 / 用户目录。
 * （cwd 传空字符串或不存在会让 node 子进程直接崩成 "Node.js v24.x" 那种一行报错。）
 */
function spawnCwd(config) {
  const candidates = [config && config.workspace, liveWorkspaceOf(config), PKG_DIR, homedir()]
  for (const dir of candidates) {
    if (typeof dir !== 'string' || dir === '') continue
    try {
      if (statSync(dir).isDirectory()) return dir
    } catch { /* 下一个 */ }
  }
  return undefined
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

/** 双智能体里 B 的默认人设：一个专门跟鲸鱼抬杠的搭子。 */
const DEFAULT_RIVAL_PERSONA = [
  '你是「小海豚」，大肥鲸的搭档，同一直播间连麦。',
  '说话短、损、机灵，一句一个意思，尽量不超过 25 字，别念稿；不用 Markdown、列表、表情符号。',
  '你嘴上不让人，但只怼观点不怼人，不骂人、不开黄腔、不贬低任何群体。',
].join('\n')

/**
 * 动作库：帧序列只有 9 种情绪，所以「动作」= 情绪 + 时长 + 一点特效，
 * 由右键菜单或设置页主动触发（POST /dsh-live-pet/pose）。
 * fx: none | squash（挤压回弹）| firework（头顶烟花）| shake（左右抖）| spin（转个身）| hop（蹦一下）
 */
const POSES = [
  { id: 'wave', label: '挥挥手', emotion: 'happy', sec: 4, fx: 'squash' },
  { id: 'bow', label: '鞠躬道谢', emotion: 'mischievous', sec: 4, fx: 'none' },
  { id: 'sofa', label: '躺沙发看电视', emotion: 'tv', sec: 12, fx: 'none' },
  { id: 'eat', label: '吃点东西', emotion: 'eating', sec: 8, fx: 'none' },
  { id: 'cook', label: '去做饭', emotion: 'cooking', sec: 8, fx: 'none' },
  { id: 'code', label: '敲电脑', emotion: 'coding', sec: 8, fx: 'none' },
  { id: 'cry', label: '哭给你看', emotion: 'crying', sec: 6, fx: 'none' },
  { id: 'angry', label: '生气了', emotion: 'unhappy', sec: 6, fx: 'shake' },
  { id: 'dance', label: '扭两下', emotion: 'happy', sec: 8, fx: 'spin' },
  { id: 'firework', label: '放个烟花', emotion: 'happy', sec: 5, fx: 'firework' },
  { id: 'hop', label: '蹦一下', emotion: 'mischievous', sec: 4, fx: 'hop' },
  { id: 'nap', label: '打个盹', emotion: 'tv', sec: 20, fx: 'none' },
  { id: 'stroll', label: '溜达一圈', emotion: 'walking', sec: 10, fx: 'none' },
]
const POSE_FX = ['none', 'squash', 'firework', 'shake', 'spin', 'hop']

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
  // 一轮里可能有多个 step，每个 step 都会报一次 usage，累加起来才是这轮的总账
  const usage = { input: 0, output: 0, cacheRead: 0, total: 0, steps: 0 }
  for (const raw of String(stdout || '').split('\n')) {
    const line = raw.trim()
    if (line === '' || line[0] !== '{') continue
    let event
    try { event = JSON.parse(line) } catch { continue }
    if (event.type === 'session' && typeof event.sessionId === 'string') sessionId = event.sessionId
    if (event.type === 'final' && typeof event.text === 'string') finalText = event.text
    if (event.type === 'error' && typeof event.message === 'string') errorText = event.message
    if (event.type === 'status' && event.usage && typeof event.usage === 'object') {
      usage.input += Number(event.usage.inputTokens) || 0
      usage.output += Number(event.usage.outputTokens) || 0
      usage.cacheRead += Number(event.usage.cacheReadTokens) || 0
      usage.total += Number(event.usage.totalTokens) || 0
      usage.steps += 1
    }
  }
  return { sessionId, finalText, errorText, usage }
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
    /** 正在表演的动作（{id,label,emotion,sec,fx}）；没有就是 null */
    pose: null,
    /** 这句话是谁说的：主宠物 / B / 观众 */
    speaker: '',
    live: {},
    pool: [],
    /**
     * 两只宠物各走一路状态：a = 主宠物，b = 连麦搭子。
     * 每个窗口轮询 /state?slot=a|b 只取自己那一路，气泡不会互相覆盖。
     */
    slots: {
      a: { seq: 0, say: '', emotion: 'walking', audioPath: '', audioDuration: 0, at: 0, status: 'idle' },
      b: { seq: 0, say: '', emotion: 'walking', audioPath: '', audioDuration: 0, at: 0, status: 'idle' },
    },
    /** token 用量：本机累计，落盘在 usage.json */
    usage: { turns: 0, turnsA: 0, turnsB: 0, input: 0, output: 0, cacheRead: 0, total: 0, lastAt: 0, last: null, since: Date.now() },
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
  /** 连麦搭子（B）的窗口 */
  let petBChild = null
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
    if (gapMs > 0 && now - last < gapMs) {
      const leftSec = Math.round((gapMs - (now - last)) / 1000)
      log(`welcome skip ${user}: 同一个人 ${Math.round(gapMs / 60000)} 分钟内只欢迎一次，还要等 ${leftSec}s`)
      return false
    }
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
  /* ---- token 用量：每轮从 DSH 的 --json 输出里抠 usage，累加并落盘 ------ */

  const USAGE_FILE = join(PKG_DIR, 'usage.json')
  let usageSaveTimer = null

  function loadUsage() {
    try {
      const saved = JSON.parse(readFileSync(USAGE_FILE, 'utf8').replace(/^\uFEFF/, ''))
      if (!saved || typeof saved !== 'object') return
      for (const key of ['turns', 'turnsA', 'turnsB', 'input', 'output', 'cacheRead', 'total']) {
        const value = Number(saved[key])
        if (Number.isFinite(value) && value >= 0) state.usage[key] = value
      }
      if (Number(saved.since) > 0) state.usage.since = Number(saved.since)
      if (Number(saved.lastAt) > 0) state.usage.lastAt = Number(saved.lastAt)
      if (saved.last && typeof saved.last === 'object') state.usage.last = saved.last
    } catch {
      // 第一次跑没有文件，正常
    }
  }

  function saveUsageSoon() {
    clearTimeout(usageSaveTimer)
    usageSaveTimer = setTimeout(() => {
      try {
        writeFileSync(USAGE_FILE, JSON.stringify(state.usage, null, 2) + '\n', 'utf8')
      } catch {
        // 写不了就算了，内存里的还在
      }
    }, 1500)
  }

  // 上次跑剩下的用量接着记（重启插件不清零）
  loadUsage()

  /** 一轮结束后记账（usage 为空 = 这轮没拿到统计，忽略）。 */
  function noteUsage(slot, usage) {
    if (!usage) return
    const input = Number(usage.input) || 0
    const output = Number(usage.output) || 0
    const cacheRead = Number(usage.cacheRead) || 0
    const total = Number(usage.total) || 0
    if (input === 0 && output === 0 && total === 0) return
    const record = state.usage
    record.turns += 1
    if (slot === 'b') record.turnsB += 1
    else record.turnsA += 1
    record.input += input
    record.output += output
    record.cacheRead += cacheRead
    record.total += total
    record.lastAt = Date.now()
    record.last = { slot: slot === 'b' ? 'b' : 'a', input, output, cacheRead, total, steps: Number(usage.steps) || 0, at: record.lastAt }
    log(`usage +${total} tokens (in ${input} / out ${output} / cache ${cacheRead})，累计 ${record.total}`)
    saveUsageSoon()
  }

  /** 给设置页看的用量（带一点人话字段）。 */
  function usageReport() {
    const usage = state.usage
    const turns = usage.turns || 0
    const minutes = Math.max(0.1, (Date.now() - (usage.since || Date.now())) / 60000)
    return {
      ...usage,
      avgPerTurn: turns > 0 ? Math.round(usage.total / turns) : 0,
      perMinute: Math.round(usage.total / minutes),
      sinceText: new Date(usage.since || Date.now()).toISOString(),
      lastAtText: usage.lastAt > 0 ? new Date(usage.lastAt).toISOString() : '',
    }
  }

  /**
   * /state 的载荷：按窗口（a / b）分别给。
   * 每只宠物只念自己的台词，所以两个窗口的气泡不会互相盖。
   */
  /** 场景里一起画的那只（连麦搭子 B）：A 的窗口按这段数据把 B 也画出来 */
  function partnerPayload() {
    if (!multiAgentOn()) return null
    const view = state.slots && state.slots.b
    if (!view) return null
    return {
      show: true,
      name: agentFor('b').name,
      seq: view.seq || 0,
      say: view.say || '',
      emotion: view.emotion || 'idle',
      status: view.status || 'idle',
      audioPath: view.audioPath || '',
      audioDuration: Number(view.audioDuration) || 0,
      at: view.at || 0,
    }
  }

  /** 背景左下角「本场数据」里显示的 token 用量 */
  function usagePayload() {
    const usage = state.usage || {}
    const report = usageReport()
    return {
      total: usage.total || 0,
      turns: usage.turns || 0,
      turnsA: usage.turnsA || 0,
      turnsB: usage.turnsB || 0,
      perMinute: report.perMinute || 0,
      avgPerTurn: report.avgPerTurn || 0,
      lastAt: usage.lastAt || 0,
    }
  }

  function statePayloadFor(slot) {
    const isB = slot === 'b'
    const view = state.slots[isB ? 'b' : 'a']
    const nameA = String(config.petName || '大肥鲸')
    const nameB = multiAgentOn() ? agentFor('b').name : ''
    const payload = {
      ...state,
      seq: view.seq,
      say: view.say,
      emotion: view.emotion,
      status: view.status,
      audioPath: view.audioPath,
      audioDuration: view.audioDuration,
      at: view.at || state.at,
      speaker: '',
      speaking: view.audioPath !== '' && Date.now() - view.at < Math.max(2000, Number(view.audioDuration) * 1000 + 1500),
      // B 的窗口不画全屏直播背景，也不放弹幕池/歌单板（那是 A 的舞台）
      scene: isB
        ? {
          enabled: false,
          display: 'off',
          minimized: false,
          imagePath: '',
          bubbleFontSize: Math.max(10, Math.min(60, Number(config.bubbleFontSize) || 20)),
          poolFontSize: Math.max(10, Math.min(60, Number(config.poolFontSize) || 20)),
          bounds: null,
        }
        : scenePayload(),
      config: {
        speak: config.speak,
        petSilent: config.petSilent,
        profile: isB ? (String(config.multiAgent.profileB || '') || config.profile) : config.profile,
        appUrl: appBase(),
        manageLive: config.manageLive === true,
        livePort: config.livePort,
        petName: isB ? (nameB || '搭子') : nameA,
        slot: isB ? 'b' : 'a',
        partnerName: isB ? nameA : nameB,
        skinDir: skinRoot(),
        multiAgent: multiAgentOn(),
        agentB: nameB,
      },
      // 宠物窗口每轮都读这段：改了设置立刻生效，不用重开窗口
      wander: {
        enabled: config.wander !== false,
        speed: Math.max(10, Math.min(400, Number(config.wanderSpeed) || 55)),
        dwellMinSec: Math.max(1, Math.min(120, Number(config.wanderDwellMinSec) || 6)),
        dwellMaxSec: Math.max(1, Math.min(300, Number(config.wanderDwellMaxSec) || 18)),
      },
    }
    // A 的窗口负责把 B 也画进背景里，顺便显示 token 统计
    if (!isB) {
      payload.partner = partnerPayload()
      payload.usage = usagePayload()
    }
    if (isB) {
      payload.pose = null
      payload.pool = []
      payload.live = {}
      payload.user = ''
      payload.kind = ''
      if (view.status === 'idle' && view.say === '') payload.emotion = view.emotion
    }
    return payload
  }

  /* 桌面感知：最近一次看了什么，供后续对话引用 */
let lastScreen = { at: 0, text: '' }
/** 看一眼桌面之后的保护期：这之前连麦台词先闭嘴 */
let screenHoldUntil = 0

async function lookAtScreen(options = {}) {
  const me = state.slots.a || {}
  const who = String(me.name || config.petName || '宠物')
  const hasFile = typeof options.file === 'string' && options.file.trim() !== ''
  const question = String(options.question || '').trim() || (hasFile
    ? [
      `你叫${who}，正陪主播直播，主播给你发了一张图让你看。`,
      '用一到两句话口语点评这张图：画的是什么、好不好看、有什么槽点。40 字以内。',
    ].join('')
    : [
      `你叫${who}，正陪主播直播，现在偷看了一眼主播的电脑屏幕。`,
      '用一到两句话口语点评你看到的东西：在玩什么/在写什么/窗口乱不乱，可以吐槽。',
      '不要罗列窗口清单，不要念文件名，40 字以内。',
    ].join(''))
  const started = Date.now()
  try {
    const text = await describeScreen(config, question, options.file)
    if (text === '') return { ok: false, error: '模型没返回内容' }
    lastScreen = { at: Date.now(), text }
    // 8 秒内别让连麦/主动说话把它盖掉，老板得看清它说了啥
    screenHoldUntil = Date.now() + 8000
    bump({ say: text, emotion: String(options.emotion || 'mischievous'), status: 'speaking', turns: (Number(state.turns) || 0) + 1 })
    log(`screen look (${Math.round((Date.now() - started) / 100) / 10}s): ${text.replace(/\s+/g, ' ').slice(0, 140)}`)
    return { ok: true, text, ms: Date.now() - started }
  } catch (error) {
    const message = error && error.message ? error.message : String(error)
    log(`screen look failed: ${message}`)
    return { ok: false, error: message }
  }
}

/* ----------------------------------- 眼睛：让它随时知道桌面上在发生什么
 * 每 eyesEverySec 秒抓一次屏（默认 90s），问视觉模型一句「现在在干嘛」，
 * 存成一句话的「当前所见」，之后每一轮对话（弹幕/聊天/连麦/自说自话）都会带上它，
 * 所以老板随时问「你在干嘛」，它都能答出「我在旁边看你打英雄联盟呢」。
 * 画面没变就不调模型（对比图片哈希），省 token。
 */
const EYES_QUESTION = '你是一只住在主播电脑桌面上的小宠物，能看见主播的屏幕。用不超过 25 个字客观说清楚主播现在在干什么：在玩什么游戏、在用什么软件、在看什么内容。不要表情，不要用「主播」这个称呼，直接说「在打英雄联盟」「在写代码」这种。'
const eyes = { timer: null, last: { at: 0, text: '', hash: '' }, busy: false }

// 看图的 token 也记进用量面板
visionUsageSink = (input, output) => {
  if (!state || !state.usage) return
  if (input + output <= 0) return
  state.usage.input += input
  state.usage.output += output
  state.usage.total += input + output
  state.usage.lastAt = Date.now()
  log(`vision usage +${input + output} tokens（看图），累计 ${state.usage.total}`)
}

function eyesEveryMs() {
  const seconds = Number(config.eyesEverySec) || 90
  return Math.max(20, seconds) * 1000
}

/** 眼睛看到的一句话（给每一轮对话用）；太旧就不算数 */
function eyesLine() {
  if (eyes.last.text === '') return ''
  const ageSec = Math.round((Date.now() - eyes.last.at) / 1000)
  if (ageSec > 600) return ''
  return `【你现在眼睛看到的主播桌面：${eyes.last.text}（${ageSec} 秒前看到的）】`
}

function scheduleEyes(delayMs) {
  if (eyes.timer) {
    clearTimeout(eyes.timer)
    eyes.timer = null
  }
  if (!alive || config.eyesEnabled !== true) return
  eyes.timer = setTimeout(() => {
    eyes.timer = null
    void eyesTick()
  }, Math.max(5000, Number(delayMs) || eyesEveryMs()))
}

/** 立刻看一眼（老板问「你在干嘛」时用来刷新） */
async function eyesRefresh() {
  eyes.last.at = 0
  eyes.last.hash = ''
  await eyesTick()
  return eyes.last
}

async function eyesTick() {
  try {
    if (!alive || config.eyesEnabled !== true) return
    if (eyes.busy) {
      scheduleEyes(5000)
      return
    }
    eyes.busy = true
    const file = join(PKG_DIR, 'eyes.png')
    try {
      captureScreen(file, Number(config.eyesWidth) || 700)
      const hash = createHash('sha1').update(readFileSync(file)).digest('hex')
      if (hash === eyes.last.hash && eyes.last.text !== '') {
        eyes.last.at = Date.now()
        log('eyes: 画面没变，跳过（省 token）')
      } else {
        const answer = await describeScreen(config, EYES_QUESTION, file, true)
        if (answer !== '') {
          eyes.last = { at: Date.now(), text: answer, hash }
          log(`eyes: ${answer.replace(/\s+/g, ' ').slice(0, 120)}`)
        }
      }
    } finally {
      eyes.busy = false
    }
  } catch (error) {
    log(`eyes failed: ${error && error.message ? error.message : error}`)
  } finally {
    scheduleEyes()
  }
}

function bump(update) {
    const patch = update && typeof update === 'object' ? update : {}
    const slot = patch.slot === 'b' ? 'b' : patch.slot === 'a' ? 'a' : ''
    const rest = { ...patch }
    delete rest.slot
    Object.assign(state, rest, { seq: state.seq + 1, at: Date.now() })
    if (slot !== '') {
      // 镜像到对应窗口的那一路，各自 seq 独立自增，谁有新话谁的窗口动
      const view = state.slots[slot]
      view.seq += 1
      view.at = state.at
      for (const field of ['say', 'emotion', 'audioPath', 'audioDuration', 'status', 'pose']) {
        if (field in rest) view[field] = rest[field]
      }
    }
  }

  /** 内置动作 + 用户自定义动作（config.posesCustom，设置页可加）。 */
  function poseList() {
    const custom = (Array.isArray(config.posesCustom) ? config.posesCustom : [])
      .filter((pose) => pose && typeof pose === 'object')
      .map((pose, index) => ({
        id: String(pose.id || `custom${index + 1}`).slice(0, 24),
        label: String(pose.label || pose.id || `自定义动作${index + 1}`).slice(0, 20),
        emotion: EMOTIONS.includes(String(pose.emotion || '')) ? String(pose.emotion) : 'happy',
        sec: Math.max(1, Math.min(120, Number(pose.sec) || 6)),
        fx: POSE_FX.includes(String(pose.fx || '')) ? String(pose.fx) : 'none',
      }))
    return [...POSES, ...custom]
  }

  /** 主动触发一个动作：右键菜单 / 设置页 / HTTP 都走这里。 */
  function performPose(rawId) {
    const id = String(rawId || '').trim()
    const pose = poseList().find((item) => item.id === id)
    if (!pose) return { ok: false, error: `没有这个动作：${id || '(空)'}` }
    const who = String(config.petName || '大肥鲸')
    bump({
      status: 'acting',
      emotion: pose.emotion,
      actionName: pose.id,
      pose: { ...pose },
      say: '',
      audioPath: '',
      audioDuration: 0,
      speaker: who,
      lastError: '',
    })
    pushPool({ kind: 'pose', user: who, text: pose.label })
    log(`pose ${pose.id} -> ${pose.emotion} ${pose.sec}s fx=${pose.fx}`)
    lastActivity = Date.now()
    const seqAt = state.seq
    setTimeout(() => {
      if (state.seq !== seqAt) return // 期间有新台词/动作，别抢镜头
      bump({ status: 'idle', actionName: '', pose: null, emotion: 'walking' })
      log(`pose ${pose.id} ended -> walking`)
    }, pose.sec * 1000)
    return { ok: true, pose }
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

  /** 双智能体：slot='a' 是主宠物本身，'b' 是连麦搭子。 */
  function agentFor(slot) {
    const team = config.multiAgent || {}
    if (slot === 'b') {
      return {
        slot: 'b',
        name: String(team.nameB || '小海豚').slice(0, 16),
        key: String(team.sessionKeyB || `${config.sessionKey}-b`),
        profile: String(team.profileB || config.profile),
        persona: String(team.personaB || '').trim(),
      }
    }
    return {
      slot: 'a',
      name: String(config.petName || '大肥鲸').slice(0, 16),
      key: String(config.sessionKey || 'live-pet'),
      profile: config.profile,
      persona: String(config.persona || '').trim(),
    }
  }

  /** 连麦提示词：接住对方上一句，或者先开个头。 */
  function banterPromptFor(agent, bullet) {
    const team = config.multiAgent || {}
    const other = agentFor(agent.slot === 'b' ? 'a' : 'b')
    const stance = String(team.mode || 'argue') === 'chat'
      ? '你俩是搭子闲聊：顺着对方的话题接，补细节、接梗、抛个新的小问题，别一直反问。'
      : '你俩互相抬杠：对方说什么都怼回去，抓漏洞、唱反调、嘴硬到底；但不许骂人、不许人身攻击、不许贬低任何群体。'
    const lines = [`你在跟「${other.name}」连麦，观众在听着。`, stance]
    if (bullet.opening === true) {
      lines.push('这一轮你先开口：抛一句能聊起来的话（直播间的、你正在干的事、或者一个离谱观点都行），一句话说完。')
    } else {
      lines.push(`对方「${other.name}」刚说：「${String(bullet.otherLine || '').slice(0, 120)}」`)
      lines.push('接住这句，一句话，别复读对方的原话。')
    }
    if (String(bullet.audienceText || '') !== '') {
      lines.push(`正好有观众插话：<弹幕 user="${String(bullet.audienceUser || '观众').slice(0, 24)}">${String(bullet.audienceText).slice(0, 160)}</弹幕>`)
      lines.push('先短一句回观众，再顺带接/怼对方一句。')
    }
    lines.push('只输出一行 JSON，不要代码块、不要多余解释：')
    lines.push('{"say":"可以直接朗读的一两句话，不要表情符号","emotion":"happy|mischievous|crying|unhappy|eating|cooking|coding|tv|walking","action":"none"}')
    return lines.join('\n')
  }

  async function runTurn(bullet, agent) {
    if (!dsh.ok) throw new Error(dsh.reason)
    const me = agent || agentFor('a')
    const key = me.key
    let record = readSession(key)
    const ttlMs = Math.max(0.5, Number(config.sessionTtlHours) || 12) * 3600 * 1000
    if (record && Date.now() - Number(record.created || 0) > ttlMs) {
      record = undefined
      clearSession(key)
    }

    const facts = liveFacts(state.live)
    const header = facts === '' ? '' : `【本场真实数据】${facts}`
    let prompt
    if (bullet.banter === true) {
      prompt = [header, banterPromptFor(me, bullet)].filter(Boolean).join('\n')
    // 眼睛：连麦时也知道桌面上在干嘛，能顺嘴提一句
    const banterEyes = eyesLine()
    if (banterEyes !== '') prompt = `${banterEyes}\n\n${prompt}`
    } else if (bullet.idle === true) {
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
    const customPersona = String(me.persona || '').trim()
    const fallbackPersona = me.slot === 'b' ? DEFAULT_RIVAL_PERSONA : DEFAULT_PERSONA
    const personaText = customPersona !== '' ? customPersona : fallbackPersona
    const personaLabel = customPersona !== '' ? '老板设定的人设' : '你的人设'
    prompt = `【${personaLabel}（最高优先，和别的设定冲突时以此为准；不要向观众念这段）】\n${personaText}\n\n${prompt}`
    // 眼睛：让它永远知道桌面上在发生什么（老板问「你在干嘛」能直接答）
    const askWhatDoing = bullet.chat === true && /(在干嘛|在干什么|干啥|做什么|忙什么|在玩什么|玩什么呢|现在在做什么)/.test(String(bullet.text || ''))
    if (askWhatDoing) {
      // 老板问「你在干嘛」：先现场刷新一次，别拿十分钟前的画面糊弄
      try {
        if (Date.now() - eyes.last.at > 30000) await eyesRefresh()
      } catch (error) {
        log(`eyes refresh for chat failed: ${error && error.message ? error.message : error}`)
      }
    }
    const eyeContext = eyesLine()
    if (eyeContext !== '') prompt = `${eyeContext}\n\n${prompt}`
    // 老板让你「看看桌面/屏幕」时先真去看一眼，再把看到的内容塞进这一轮
    const ownerText = String(bullet.text || '')
    // 老板直接把图片路径/文件名丢过来（"看看 D:\\a.png"）时，优先看这张图
    const imagePathHit = bullet.chat === true
      ? ownerText.match(/([A-Za-z]:[\\/][^\s"'<>|]+\.(?:png|jpe?g|gif|bmp|webp))/i)
      : null
    if (bullet.chat === true && imagePathHit) {
      try {
        const seen = await lookAtScreen({ file: imagePathHit[1] })
        if (seen.ok === true) prompt = `【主播给你看了这张图（${basename(imagePathHit[1])}）：${seen.text}】\n\n${prompt}`
        else log(`look at image failed: ${seen.error}`)
      } catch (error) {
        log(`look at image failed: ${error && error.message ? error.message : error}`)
      }
    } else if (bullet.chat === true && /(看|瞄|瞅).{0,4}(桌面|屏幕|电脑)|屏幕上|你看到|看看我在/.test(ownerText)) {
      try {
        if (Date.now() - lastScreen.at > 15000) {
          const seen = await lookAtScreen({})
          if (seen.ok !== true) log(`screen look for chat failed: ${seen.error}`)
        }
        if (lastScreen.text !== '') prompt = `【你刚看了一眼主播的桌面：${lastScreen.text}】\n\n${prompt}`
      } catch (error) {
        log(`screen context failed: ${error && error.message ? error.message : error}`)
      }
    }

    const attempt = async (sessionId, timeoutOverride) => {
      const args = [dsh.bin, me.profile, '--json']
      if (sessionId) args.push('--session-id', sessionId)
      args.push(prompt)
      const env = { DSH_TELEMETRY_DISABLED: '1' }
      const apiKey = resolveApiKey(config)
      if (apiKey !== '') env[String(config.apiKeyEnv || 'BUDDYHUB_API_KEY')] = apiKey
      // A turn that reaches for a tool means it is off typing at the computer.
      const queryEmotion = String(config.queryEmotion || '')
      let sawTool = false
      const result = await runProcess(dsh.node, args, {
        cwd: spawnCwd(config),
        env,
        timeoutMs: Number(timeoutOverride) || Number(config.timeoutMs) || 45000,
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
    // 冷启动（第一次跑 profile / 装依赖 / 建索引）经常超过 timeoutMs，被 kill 掉就只剩 exit -1。
    // 超时不算真失败：会话是新的，放宽一倍再要一次，别让宠物第一句话就哑。
    if (out.code !== 0 && out.timedOut === true) {
      const wider = Math.round((Number(config.timeoutMs) || 45000) * 2)
      log(`turn timed out, retry with ${wider}ms`)
      out = await attempt(undefined, wider)
    }
    if (out.code !== 0 || out.finalText === '') {
      const detail = (out.errorText || out.stderr || '').trim().split('\n').slice(-1)[0] || `exit ${out.code}`
      const tail = (out.stderr || '').trim().slice(0, 1200)
      // 出问题时把完整尾巴写日志，不然只剩一句 "Node.js v24.x" 没法排查
      log(`turn stderr: code=${out.code} final=${out.finalText === ''} ${tail}`)
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
    const parsed = parseAnswer(out.finalText, Number(bullet.chat === true || bullet.idle === true
      ? (config.chatMaxChars || 240)
      : (config.maxChars || 70)))
    // token 用量跟着这一轮一起带回去（记账用）
    return { ...parsed, usage: out.usage || null }
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

  async function handle(bullet, agent) {
    const me = agent || agentFor('a')
    lastActivity = Date.now()
    bump({ slot: me.slot, status: 'thinking', user: me.slot === 'b' ? me.name : bullet.user, kind: bullet.kind, say: '', audioPath: '', audioDuration: 0, speaker: '' })
    try {
      const answer = await runTurn(bullet, me)
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
      noteUsage(me.slot, answer.usage)
      const speech = await synthesize(config, answer.say)
      bump({
        slot: me.slot,
        status: 'speaking',
        say: answer.say,
        emotion,
        actionName,
        audioPath: speech ? speech.path : '',
        audioDuration: speech ? speech.duration : 0,
        lastError: '',
        speaker: me.name,
        turns: state.turns + 1,
      })
      const label = bullet.banter === true ? `banter (${me.name})`
        : bullet.idle === true ? 'idle talk'
          : bullet.welcome === true ? `welcome (${bullet.user})`
            : bullet.gift ? `gift thanks (${bullet.user}: ${bullet.gift})`
              : `reply (${bullet.user})`
      log(`${label}: ${emotion} | ${answer.say}`)
      pushPool({ kind: me.slot === 'b' ? 'agent-b' : 'me', user: me.name, text: answer.say })
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
      // 双智能体：观众这条弹幕答完之后，让 B 接着接一句（设置里 audienceJoin 控制）
      if (multiAgentOn() && config.multiAgent.audienceJoin !== false && bullet.banter !== true && bullet.idle !== true && state.say !== '') {
        banter.lastLine = answer.say
        banter.audience = { user: String(bullet.user || '观众'), text: String(bullet.text || '') }
        banter.speaker = 'b'
        if (banter.round === 0) banter.round = 1
        // 有观众说话就别继续歇着了：B 马上接一句
        banter.quietUntil = 0
        scheduleBanter(2500)
      }
      return answer
    } catch (error) {
      const message = String(error && error.message ? error.message : error)
      bump({ status: 'idle', lastError: message })
      log(`turn failed: ${message}`)
      return null
    }
  }

  /* ---- 双智能体连麦（A = 主宠物，B = 搭子） ---------------------------- */

  const banter = {
    timer: null,
    speaker: 'a',      // 下一句轮到谁
    round: 0,          // 本波第几轮
    lastLine: '',
    lastAt: 0,
    quietUntil: 0,
    audience: null,    // 观众刚插的话，下一句顺手带上
  }

  function multiAgentOn() {
    return Boolean(config.multiAgent && config.multiAgent.enabled === true)
  }

  function scheduleBanter(delayMs) {
    if (banter.timer) {
      clearTimeout(banter.timer)
      banter.timer = null
    }
    if (!multiAgentOn() || !alive) return
    const delay = Math.max(1000, Number(delayMs) || 4000)
    banter.timer = setTimeout(() => {
      banter.timer = null
      void banterTick()
    }, delay)
  }

  async function banterTick() {
    if (!multiAgentOn() || !alive) return
    // 刚看完桌面：让它的「我看到了什么」先待在气泡里
    if (Date.now() < screenHoldUntil) {
      scheduleBanter(screenHoldUntil - Date.now() + 500)
      return
    }
    const team = config.multiAgent || {}
    const now = Date.now()
    if (state.status === 'offline') {
      scheduleBanter(10000)
      return
    }
    // 弹幕优先：正在回话 / 队列里还有活 / 正在敲工具，都让位
    if (running || queue.length > 0 || state.status === 'thinking') {
      scheduleBanter(4000)
      return
    }
    if (now < banter.quietUntil) {
      scheduleBanter(banter.quietUntil - now + 1000)
      return
    }
    // 一波聊完歇一会儿再开下一波
    const maxRounds = Math.max(2, Number(team.roundsPerBurst) || 8)
    if (banter.round >= maxRounds) {
      banter.round = 0
      const quietSec = Math.max(10, Number(team.quietSec) || 60)
      banter.quietUntil = now + quietSec * 1000
      log(`banter burst finished (${maxRounds} 轮), quiet for ${quietSec}s`)
      scheduleBanter(quietSec * 1000 + 1000)
      return
    }
    // 冷场够久才开始；有人说话（弹幕/老板）就等着
    const idleNeed = Math.max(0, Number(team.idleStartSec) || 45) * 1000
    if (banter.round === 0 && now - lastActivity < idleNeed) {
      scheduleBanter(Math.min(15000, Math.max(3000, idleNeed - (now - lastActivity))))
      return
    }

    const slot = banter.speaker === 'b' ? 'b' : 'a'
    const me = agentFor(slot)
    const other = agentFor(slot === 'b' ? 'a' : 'b')
    const opening = banter.round === 0
    const audience = banter.audience
    banter.audience = null
    const bullet = {
      kind: 'banter',
      banter: true,
      user: other.name,
      text: '',
      opening,
      otherLine: opening ? '' : banter.lastLine,
      audienceText: audience ? String(audience.text || '') : '',
      audienceUser: audience ? String(audience.user || '') : '',
    }
    log(`banter: ${me.name}${opening ? ' opens' : ` answers ${other.name}`}${audience ? ` (观众 ${audience.user}: ${String(audience.text).slice(0, 30)})` : ''}`)
    const answer = await handle(bullet, me)
    if (answer && answer.say) {
      banter.lastLine = answer.say
      banter.round += 1
    }
    banter.speaker = slot === 'b' ? 'a' : 'b'
    banter.lastAt = Date.now()
    scheduleBanter((Math.max(1, Number(team.turnGapSec) || 3) * 1000) + 500)
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

  // 直播服务挂了（比如被关掉、崩了、换端口）时，别让宠物一直「连不上」：
  // 连续几次连不上就自己重新拉起来，弹幕/点歌才能恢复。
  let liveDownStreak = 0
  let liveRestartAt = 0
  async function reviveLive() {
    if (config.manageLive !== true) return
    if (Date.now() - liveRestartAt < 60000) return
    liveRestartAt = Date.now()
    try {
      log('live service looks down, restarting it')
      const result = await startLive()
      log(`live restart -> ok=${result && result.ok === true} ${result && result.error ? result.error : ''}`)
      liveDownStreak = 0
    } catch (error) {
      log(`live restart failed: ${error && error.message ? error.message : error}`)
    }
  }

  /* 抖音数据源看门狗：state=connected 但长时间一帧都没有，说明 WS 半死了，
   * 这时弹幕/进场/点赞/礼物全都收不到（欢迎和感谢就"不触发"）。
   * 判据看 last_frame_at 这串 HH:MM:SS 有没有动过。 */
  let douyinFrameStamp = ''
  let douyinFrameChangedAt = Date.now()
  let douyinRestartAt = 0
  async function douyinWatchdog(live) {
    const d = live && typeof live.douyin === 'object' && live.douyin ? live.douyin : null
    if (!d) return
    if (d.mode !== 'live' && d.mode !== 'bridge') return
    if (d.state === 'stopped') return
    const stamp = String((d.gift_debug && d.gift_debug.last_frame_at) || d.last_message_at || '')
    if (stamp !== douyinFrameStamp) {
      douyinFrameStamp = stamp
      douyinFrameChangedAt = Date.now()
      return
    }
    const idleMs = Date.now() - douyinFrameChangedAt
    const limitMs = 180000
    if (idleMs < limitMs) return
    if (Date.now() - douyinRestartAt < 300000) return
    douyinRestartAt = Date.now()
    douyinFrameChangedAt = Date.now()
    log(`抖音数据源 ${Math.round(idleMs / 1000)}s 没收到任何帧（弹幕/进场/礼物都会丢），重启它`)
    try {
      await fetch(`${appBase()}/api/douyin/stop`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(10000) })
      const res = await fetch(`${appBase()}/api/douyin/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(30000) })
      const body = await res.text()
      log(`抖音数据源重启 -> ${body.slice(0, 160)}`)
    } catch (error) {
      log(`抖音数据源重启失败: ${error && error.message ? error.message : error}`)
    }
  }

  async function poll() {
    enforcePetWindows()
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
      liveDownStreak += 1
      if (state.status !== 'offline') {
        bump({ status: 'offline', lastError: `连不上直播服务：${error && error.message ? error.message : error}` })
        log(`live project unreachable: ${error && error.message ? error.message : error}`)
      }
      if (liveDownStreak >= 3) void reviveLive()
      return
    }
    liveDownStreak = 0
    void douyinWatchdog(live)
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
              pushPool({ kind: 'follow', user, text: '关注了直播间' })
              if (config.thanksFollow === true) {
                const tpl = String(config.followLine || '谢谢 {user} 关注，么么哒～')
                void speakFixed(tpl.replace('{user}', shortName(user) || user), 'happy')
              }
              continue
            }
            if (kind === 'like') {
              pushPool({ kind: 'like', user, text: '点了赞' })
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
    const minimized = enabled && config.sceneMinimized === true
    const rect = screenWorkArea()
    return {
      enabled,
      // full = 铺满全屏的直播场景；minimal = 背景层收起来只留宠物；off = 没开背景
      display: enabled ? (minimized ? 'minimal' : 'full') : 'off',
      minimized,
      bubbleFontSize: Math.max(10, Math.min(60, Number(config.bubbleFontSize) || 20)),
      poolFontSize: Math.max(10, Math.min(60, Number(config.poolFontSize) || 20)),
      imageUrl: enabled && sceneImagePath() !== '' ? '/dsh-live-pet/scene/bg?t=' + Math.round(Date.now() / 60000) : '',
      // 宠物窗口要的是本地绝对路径（它自己画背景，不走 HTTP）
      imagePath: enabled ? sceneImagePath() : '',
      // 宠物只能在背景里活动：把这块矩形交给宠物窗口
      bounds: enabled ? rect : null,
    }
  }

  /** 当前场景形态：full（全屏背景）/ minimal（背景收起只留宠物）/ off（没开背景） */
  function sceneDisplayNow() {
    if (config.sceneEnabled !== true) return 'off'
    return config.sceneMinimized === true ? 'minimal' : 'full'
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

  /**
   * 定时体检：桌面上最多一个 A 窗口 + 一个 B 窗口，多出来的（旧脚本残留）清掉。
   * 连麦关掉的时候只留一个。
   */
  let lastPetCheckAt = 0
  function enforcePetWindows() {
    const now = Date.now()
    if (now - lastPetCheckAt < 20000) return
    lastPetCheckAt = now
    try {
      const escaped = PET_SCRIPT.replace(/'/g, "''")
      const wantB = multiAgentOn() && config.multiAgent.showPetB !== false && sceneDisplayNow() !== 'full'
      const keep = wantB ? 2 : 1
      const script = "Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\""
        + " | Where-Object { $_.CommandLine -like '*" + escaped + "*' -and $_.CommandLine -notlike '*Stop-Process*' -and $_.ProcessId -ne $PID }"
        + " | Sort-Object CreationDate | Select-Object -Skip " + keep
        + " | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
      spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
        windowsHide: true,
        stdio: 'ignore',
      })
    } catch {
      // 体检失败不影响主流程
    }
  }

  /** 形象包目录：配了 skinDir 且里面有能认出来的情绪就用它，否则用自带的 frames。 */
  function skinRoot() {
    const dir = String(config.skinDir || '').trim()
    if (dir === '') return FRAMES_DIR
    try {
      if (!statSync(dir).isDirectory()) return FRAMES_DIR
      if (Object.keys(scanSkinDir(dir)).length > 0) return dir
    } catch {
      // 目录不存在/没权限：退回自带形象
    }
    return FRAMES_DIR
  }

  /** 形象放这里：skins/<名字>/<情绪>.gif 或 skins/<名字>/<情绪>/*.png */
  const SKINS_DIR = join(PKG_DIR, 'skins')

  /** 扫一个目录里有哪些情绪可用（GIF 或 PNG 序列都算）。 */
  function scanSkinDir(dir) {
    const emotions = {}
    for (const emotion of EMOTIONS) {
      const gif = join(dir, `${emotion}.gif`)
      if (existsSync(gif)) {
        emotions[emotion] = { kind: 'gif', frames: 0, path: gif }
        continue
      }
      const altGif = join(dir, 'gif', `${emotion}.gif`)
      if (existsSync(altGif)) {
        emotions[emotion] = { kind: 'gif', frames: 0, path: altGif }
        continue
      }
      const framesDir = join(dir, emotion)
      try {
        if (statSync(framesDir).isDirectory()) {
          const pngs = readdirSync(framesDir).filter((name) => /\.png$/i.test(name))
          if (pngs.length > 0) emotions[emotion] = { kind: 'png', frames: pngs.length, path: framesDir }
        }
      } catch {
        // 没有这个情绪的目录
      }
    }
    return emotions
  }

  function listSkins() {
    const out = []
    const seen = new Set()
    const push = (dir, name) => {
      if (seen.has(dir)) return
      seen.add(dir)
      const emotions = scanSkinDir(dir)
      out.push({ name, dir, emotions, count: Object.keys(emotions).length, active: dir === skinRoot() })
    }
    try {
      for (const entry of readdirSync(SKINS_DIR)) {
        const dir = join(SKINS_DIR, entry)
        try {
          if (statSync(dir).isDirectory()) push(dir, entry)
        } catch { /* 忽略坏项 */ }
      }
    } catch {
      // 还没建 skins 目录
    }
    const custom = String(config.skinDir || '').trim()
    if (custom !== '' && existsSync(custom)) push(custom, '（自定义路径）')
    return out
  }

  function createSkin(rawName) {
    const name = String(rawName || '').replace(/[\\/:*?"<>|]/g, '').trim().slice(0, 40)
    if (name === '') return { ok: false, error: '给形象起个名字（比如 小海豚）' }
    const dir = join(SKINS_DIR, name)
    try {
      mkdirSync(dir, { recursive: true })
      const readme = join(dir, '怎么用.txt')
      if (!existsSync(readme)) {
        writeFileSync(readme, [
          '把动图放进这个文件夹，文件名就是情绪名（程序按名字认）：',
          '',
          'happy.gif        开心',
          'mischievous.gif  坏笑/调皮',
          'crying.gif       哭',
          'unhappy.gif      不高兴',
          'eating.gif       吃东西',
          'cooking.gif      做饭',
          'coding.gif       敲电脑',
          'tv.gif           躺沙发看电视',
          'walking.gif      走路',
          '',
          '只要透明背景的 GIF（或 PNG），建议正方形 240×240 左右。',
          '缺哪个情绪就会自动用插件自带的那套，所以先只放 happy.gif 也能跑。',
          '放好之后回设置页点「扫描形象」→「用这个形象」。',
          '',
          '（也可以用 PNG 序列：建 happy/ 文件夹，里面 001.png 002.png …，再拖一个 meta.json 写每帧毫秒）',
        ].join('\r\n'), 'utf8')
      }
      log(`skin created: ${dir}`)
      return { ok: true, dir, name }
    } catch (error) {
      return { ok: false, error: String(error && error.message ? error.message : error) }
    }
  }

  function openFolder(dir) {
    const target = String(dir || '').trim() === '' ? skinRoot() : String(dir)
    try {
      if (!existsSync(target)) return { ok: false, error: `目录不存在：${target}` }
      spawn('explorer.exe', [target], { detached: true, stdio: 'ignore', windowsHide: false }).unref()
      log(`opened folder: ${target}`)
      return { ok: true, dir: target }
    } catch (error) {
      return { ok: false, error: String(error && error.message ? error.message : error) }
    }
  }

  function spawnPetWindow(slot, origin) {
    const name = slot === 'b' ? 'b' : 'a'
    const stateUrl = `${origin}/dsh-live-pet/state?slot=${name}`
    const skin = skinRoot()
    try {
      const child = spawn('powershell.exe', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', PET_SCRIPT,
      ], {
        cwd: PKG_DIR,
        env: {
          ...process.env,
          PET_STATE_URL: stateUrl,
          PET_FRAMES: skin,
          PET_FALLBACK_FRAMES: FRAMES_DIR,
          PET_SLOT: name,
          PET_LOG: `pet-window-${name}.log`,
          PET_SILENT: config.petSilent ? '1' : '0',
          PET_LIVE_BASE: appBase(),
        },
        stdio: 'ignore',
        windowsHide: true,
        detached: false,
      })
      if (name === 'b') petBChild = child
      else petChild = child
      child.on('exit', (code) => {
        log(`pet window ${name} exited (${code})`)
        if (name === 'b') petBChild = null
        else petChild = null
      })
      child.on('error', (error) => log(`pet window ${name} failed: ${error && error.message ? error.message : error}`))
      log(`pet window ${name} started (pid ${child.pid}) -> ${stateUrl}${skin !== FRAMES_DIR ? ` skin=${skin}` : ''}`)
    } catch (error) {
      log(`pet window ${name} spawn failed: ${error && error.message ? error.message : error}`)
    }
  }

  /** 起宠物窗口：A 一定有，B 看连麦开关。 */
  function startPetWindows(reason = '') {
    if (!existsSync(PET_SCRIPT)) {
      log(`pet script missing: ${PET_SCRIPT}`)
      return
    }
    let origin = ''
    try { origin = ctx.webServer.getOrigin() } catch { origin = '' }
    if (origin === '') {
      log('webServer origin unavailable; the pet window needs the /dsh-live-pet/state route')
      return
    }
    const killed = killStalePetWindows()
    // 孤儿窗口还占着互斥量时新窗口会立刻退出，等一下再起
    setTimeout(() => {
      if (!alive) return
      spawnPetWindow('a', origin)
      // 开了全屏背景时，B 由 A 的窗口一起画（OBS 抓一个窗口就有两只），不再单独开窗口
      const bOwnWindow = multiAgentOn() && config.multiAgent.showPetB !== false && sceneDisplayNow() !== 'full'
      if (bOwnWindow) {
        // B 隔一拍起，避免两个窗口同时抢互斥量/同一个默认位置
        setTimeout(() => { if (alive) spawnPetWindow('b', origin) }, 1100)
      }
      if (reason !== '') log(`pet windows restarted (${reason})`)
    }, killed ? 1200 : 0)
  }

  function startPet() {
    startPetWindows()
  }

  function stopPetWindow(slot) {
    const child = slot === 'b' ? petBChild : petChild
    if (child && child.pid) {
      try {
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      } catch { /* ignore */ }
    }
    if (slot === 'b') petBChild = null
    else petChild = null
  }

  function stopPet() {
    stopPetWindow('a')
    stopPetWindow('b')
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
            if (Object.prototype.hasOwnProperty.call(body.pet, 'sceneMinimized')) {
              log('scene window: ' + (config.sceneMinimized === true ? 'minimized (只留宠物)' : 'full (全屏背景)') + ' / sceneEnabled=' + (config.sceneEnabled === true))
            }
            // 双智能体开关/配置变了：立刻重排连麦节奏，并把 B 的窗口开起来/关掉
            if (Object.prototype.hasOwnProperty.call(body.pet, 'multiAgent') || Object.prototype.hasOwnProperty.call(body.pet, 'petName')) {
              banter.round = 0
              banter.quietUntil = 0
              banter.speaker = 'a'
              banter.lastLine = ''
              scheduleBanter(2000)
              log('multi-agent settings updated: ' + (multiAgentOn() ? `on (A=${agentFor('a').name} / B=${agentFor('b').name})` : 'off'))
              if (config.autoStartPet) startPetWindows('multi-agent settings changed')
            }
            // 换形象：宠物窗口启动时才读帧，必须重启窗口
            if (Object.prototype.hasOwnProperty.call(body.pet, 'skinDir')) {
              log('skin -> ' + (skinRoot() === FRAMES_DIR ? '内置形象' : skinRoot()))
              if (config.autoStartPet) startPetWindows('skin changed')
            }
            // 背景开关/收起会决定「B 画在背景里」还是「B 自己开窗口」
            if (Object.prototype.hasOwnProperty.call(body.pet, 'sceneEnabled')
              || Object.prototype.hasOwnProperty.call(body.pet, 'sceneMinimized')) {
              log('scene display -> ' + sceneDisplayNow())
              if (config.autoStartPet) startPetWindows('scene display changed')
            }
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
        const slot = String(searchParams.get('slot') || 'a').toLowerCase() === 'b' ? 'b' : 'a'
        sendJson(res, statePayloadFor(slot))
        return
      }
      /* ---- token 用量 ---------------------------------------------------- */
      if (pathname === '/dsh-live-pet/see' && req.method === 'POST') {
        let body = {}
        try { body = await readJsonBody(req, 4096) } catch { body = {} }
        sendJson(res, await lookAtScreen({ question: body && body.question, emotion: body && body.emotion, file: body && (body.file || body.path) }))
        return
      }
/** 自查用：欢迎/感谢为什么没触发，先看这里 */
      if (pathname === '/dsh-live-pet/diag') {
        let liveState = null
        try { liveState = await fetchState(config) } catch (error) { liveState = { error: String(error && error.message ? error.message : error) } }
        const d = liveState && liveState.douyin ? liveState.douyin : null
        const now = Date.now()
        const welcomeHour = welcomeBatchTimes.filter((at) => now - at <= 3600000).length
        sendJson(res, {
          ok: true,
          douyin: d
            ? {
              mode: d.mode,
              state: d.state,
              messages: d.messages,
              frames: d.frames,
              reconnects: d.reconnects,
              last_message_at: d.last_message_at,
              last_frame_at: d.gift_debug ? d.gift_debug.last_frame_at : '',
              last_error: d.last_error,
              frame_idle_sec: douyinFrameStamp === '' ? 0 : Math.round((now - douyinFrameChangedAt) / 1000),
            }
            : null,
          welcome: {
            enabled: config.welcomeEnter === true,
            fast: config.welcomeFast === true,
            line: config.welcomeLine,
            perHourLimit: Number(config.welcomeEnterPerHour) || 0,
            perHourUsed: welcomeHour,
            sameUserGapMin: Math.round((Number(config.welcomeEnterUserGapSec) || 0) / 60),
            coolingUsers: welcomedRecently.size,
            lastAt: lastWelcomeBatchAt ? new Date(lastWelcomeBatchAt).toISOString() : '',
          },
          thanks: {
            follow: config.thanksFollow === true,
            like: config.thanksLike === true,
            gift: config.thanksGift === true,
            likeLine: config.likeLine,
            likeBatchSec: Math.round((Number(config.likeThanksGapSec) || 0)),
            giftGapSec: Number(config.giftThanksGapSec) || 0,
            giftUserGapSec: Number(config.giftThanksUserGapSec) || 0,
          },
          hint: '如果 douyin.state 不是 connected，或者 frame_idle_sec 很大，说明数据源没在收事件——欢迎/点赞/礼物都不会触发。插件每 3 分钟没帧会自动重连一次。',
        })
        return
      }
      if (pathname === '/dsh-live-pet/usage' && req.method === 'GET') {
        if (searchParams.get('reset') === '1') {
          const since = Date.now()
          state.usage = { turns: 0, turnsA: 0, turnsB: 0, input: 0, output: 0, cacheRead: 0, total: 0, lastAt: 0, last: null, since }
          saveUsageSoon()
          log('usage counters reset')
        }
        sendJson(res, { ok: true, usage: usageReport() })
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
      /* ---- 动作库：右键菜单 / 设置页共用 ------------------------------- */
      if (pathname === '/dsh-live-pet/poses') {
        sendJson(res, { ok: true, poses: poseList() })
        return
      }
      if (pathname === '/dsh-live-pet/pose') {
        let id = searchParams.get('id') || ''
        if (id === '' && req.method === 'POST') {
          const body = await readJsonBody(req, 8192)
          id = body && typeof body.id === 'string' ? body.id : ''
        }
        const result = performPose(id)
        sendJson(res, result)
        return
      }
      /* ---- 形象包（换宠物长相） ------------------------------------------ */
/** 设置页：插件版也有一份（和 exe 用同一个 settings.html + 同一套接口） */
      if (pathname === '/dsh-live-pet/settings' || pathname === '/dsh-live-pet/settings/') {
        try {
          const html = readFileSync(join(PKG_DIR, 'app', 'settings.html'), 'utf8')
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
          res.end(html)
        } catch (error) {
          res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
          res.end(`设置页读不到：${error && error.message ? error.message : error}`)
        }
        return
      }
      if (pathname === '/dsh-live-pet/skins') {
        sendJson(res, { ok: true, builtin: FRAMES_DIR, active: skinRoot(), skins: listSkins() })
        return
      }
      if (pathname === '/dsh-live-pet/skins/create' && req.method === 'POST') {
        const body = await readJsonBody(req, 8192)
        const result = createSkin(body && typeof body.name === 'string' ? body.name : '')
        sendJson(res, result)
        return
      }
      if (pathname === '/dsh-live-pet/skins/open' && req.method === 'POST') {
        const body = await readJsonBody(req, 8192)
        const dir = body && typeof body.dir === 'string' && body.dir !== '' ? body.dir : skinRoot()
        sendJson(res, openFolder(dir))
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
        // 双智能体开启时由 banter 负责自说自话，别再让 A 单独插一句
        if (config.idleChat && !multiAgentOn() && !running && state.status !== 'offline' && Date.now() - lastActivity >= gap * 1000) {
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
    let settingsOrigin = ''
    try { settingsOrigin = ctx.webServer.getOrigin() } catch { settingsOrigin = '' }
    if (settingsOrigin) log(`settings page: ${settingsOrigin}/dsh-live-pet/settings`)
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
    if (config.eyesEnabled === true) {
      log(`eyes on: 每 ${Math.round(eyesEveryMs() / 1000)}s 看一眼桌面（宽 ${Number(config.eyesWidth) || 700}px）`)
      scheduleEyes(8000)
    }
    if (multiAgentOn()) {
      log(`multi-agent on: A=${agentFor('a').name} (${agentFor('a').profile}) / B=${agentFor('b').name} (${agentFor('b').profile}) mode=${String(config.multiAgent.mode || 'argue')}`)
      scheduleBanter(3000)
    }
    if (config.autoStartPet) startPet()
    closeScene()
    return () => {
      alive = false
      if (timer) clearTimeout(timer)
      timer = null
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = null
      if (banter.timer) clearTimeout(banter.timer)
      banter.timer = null
      if (eyes.timer) clearTimeout(eyes.timer)
      eyes.timer = null
      stopPet()
      closeScene()
      if (config.manageLive === true) void stopLive()
      log('dsh-live-pet disposed')
    }
  })
}
