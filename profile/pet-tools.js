/**
 * dsh-live-pet 的只读工具 —— 宠物 profile 专用。
 *
 * 为什么不用 pwsh：shell 工具的沙箱升级由模型自己申请（`sandbox_permissions`），
 * 在无人值守的子进程里没有审批应答者，升级请求会被直接放行 —— 等于没锁。
 * 这里用 Node 自己读系统信息：没有写路径，只读是代码保证的，不依赖沙箱。
 */
import { statfsSync, readFileSync, readdirSync, writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import os from 'node:os'

export const name = 'pet-tools'

export const inject = ['tools']

const text = (value) => [{ type: 'text', text: String(value) }]

/** Search helper: reuse the live project's keyless 360/Bing search through python. */
const SEARCH_SNIPPET = [
  'import json,sys',
  'from core import tools',
  'print(json.dumps(tools.search(sys.argv[1]), ensure_ascii=False))',
].join('\n')

function runPython(python, cwd, args, timeoutMs = 25000) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(python, args, {
        cwd,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      resolve({ code: -1, out: '', err: String(error && error.message ? error.message : error) })
      return
    }
    let out = ''
    let err = ''
    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* already gone */ }
      done({ code: -1, out, err: err + ' timeout' })
    }, timeoutMs)
    child.stdout.on('data', (chunk) => { out += chunk.toString('utf8') })
    child.stderr.on('data', (chunk) => { err += chunk.toString('utf8') })
    child.on('error', (error) => {
      clearTimeout(timer)
      done({ code: -1, out, err: String(error && error.message ? error.message : error) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      done({ code: code === null ? -1 : code, out, err })
    })
  })
}

function cpuSample() {
  const first = os.cpus()
  let idle0 = 0
  let total0 = 0
  for (const cpu of first) {
    for (const value of Object.values(cpu.times)) total0 += value
    idle0 += cpu.times.idle
  }
  return new Promise((resolve) => {
    setTimeout(() => {
      const second = os.cpus()
      let idle1 = 0
      let total1 = 0
      for (const cpu of second) {
        for (const value of Object.values(cpu.times)) total1 += value
        idle1 += cpu.times.idle
      }
      const totalDelta = total1 - total0
      const idleDelta = idle1 - idle0
      const usage = totalDelta > 0 ? Math.round((1 - idleDelta / totalDelta) * 100) : 0
      resolve({ usage, model: (second[0] && second[0].model) ? second[0].model.trim() : 'unknown', cores: second.length })
    }, 250)
  })
}

function diskLines() {
  const lines = []
  for (const letter of ['C', 'D', 'E', 'F', 'G', 'H']) {
    const root = `${letter}:\\`
    try {
      const info = statfsSync(root)
      const totalBytes = Number(info.blocks) * Number(info.bsize)
      const freeBytes = Number(info.bavail) * Number(info.bsize)
      if (totalBytes <= 0) continue
      const usedPct = Math.round((1 - freeBytes / totalBytes) * 100)
      lines.push(`${letter}: 共 ${(totalBytes / 1024 ** 3).toFixed(0)}G，已用 ${usedPct}%，剩余 ${(freeBytes / 1024 ** 3).toFixed(0)}G`)
    } catch { /* drive absent */ }
  }
  return lines
}

function uptimeText() {
  const minutes = Math.round(os.uptime() / 60)
  const hours = Math.floor(minutes / 60)
  return hours > 0 ? `${hours} 小时 ${minutes % 60} 分钟` : `${minutes} 分钟`
}

export function apply(ctx, config = {}) {
  const workspace = String(config.workspace || 'F:/douyinlive')
  const python = String(config.pythonBin || 'python')
  /** Live service base URL (baked in when the profile is generated). */
  const apiBase = String(config.apiBase || 'http://127.0.0.1:8790').replace(/\/+$/, '')
  /** DSH 插件自身的 HTTP 基址（开电视要用它定位、起 Edge） */
  const skipCooldownSec = Number(config.skipCooldownSec)
  // 每轮弹幕都是一个新的 dsh 子进程，冷却时间只能靠文件记住
  const stateDir = String(config.stateDir || '.')
  const skipFile = join(stateDir, '.last-skip')

  function readLastSkip() {
    try { return Number(readFileSync(skipFile, 'utf8').trim()) || 0 } catch { return 0 }
  }

  function writeLastSkip(at) {
    try { writeFileSync(skipFile, String(at), 'utf8') } catch { /* 冷却失效也比崩了好 */ }
  }
  ctx.effect(() => ctx.tools.register({
    name: 'system_status',
    description: '读取这台电脑的实时状态（只读）：CPU 占用与型号、内存占用、各磁盘剩余、系统已运行时长、进程数。用来回答「电脑现在什么状态」「卡不卡」「内存够不够」。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] },
      render: (args, value) => text(value && typeof value.summary === 'string' ? value.summary : ''),
    },
    async execute() {
      const cpu = await cpuSample()
      const totalMem = os.totalmem()
      const freeMem = os.freemem()
      const memUsedPct = Math.round((1 - freeMem / totalMem) * 100)
      const lines = [
        `CPU：${cpu.usage}% 占用（${cpu.cores} 核 · ${cpu.model}）`,
        `内存：已用 ${memUsedPct}%，剩余 ${(freeMem / 1024 ** 3).toFixed(1)}G / 共 ${(totalMem / 1024 ** 3).toFixed(0)}G`,
        ...diskLines(),
        `系统已运行：${uptimeText()}`,
        `主机：${os.hostname()} · ${os.platform()} ${os.release()}`,
      ]
      return { summary: lines.join('\n') }
    },
  }))

  ctx.effect(() => ctx.tools.register({
    name: 'read_text_file',
    description: '读取一个文本文件的内容（只读，最多 64KB、最多 400 行）。看日志、配置文件、代码都可以用。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件的绝对路径' },
        offset: { type: 'integer', description: '从第几行开始读（1 起，默认 1）' },
        limit: { type: 'integer', description: '最多读多少行（默认 200）' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' }, truncated: { type: 'boolean' } },
        required: ['path', 'content'],
      },
      render: (args, value) => text(`${value.path}\n\n${value.content}`),
    },
    async execute(args) {
      const path = String((args && args.path) || '')
      const offset = Math.max(1, Number(args && args.offset) || 1)
      const limit = Math.max(1, Math.min(400, Number(args && args.limit) || 200))
      if (path === '') throw new Error('path 必填')
      const info = statSync(path)
      if (!info.isFile()) throw new Error('不是文件')
      const cap = 64 * 1024
      const buffer = readFileSync(path)
      const truncatedByBytes = buffer.length > cap
      const body = buffer.subarray(0, cap).toString('utf8')
      const lines = body.split(/\r?\n/)
      const slice = lines.slice(offset - 1, offset - 1 + limit)
      return {
        path,
        content: slice.join('\n'),
        truncated: truncatedByBytes || lines.length > offset - 1 + limit,
      }
    },
  }))

  ctx.effect(() => ctx.tools.register({
    name: 'web_search_cn',
    description: '中文网页搜索（360 主、Bing 备，不需要任何 API key）。查新闻、查资料、查实时信息、查某个东西是什么都用这个。'
      + '注意：另一个叫 web_search 的工具依赖未配置的 API key，不可用，请一律使用本工具。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要搜的关键词，越具体越好（最多 80 字）' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, summary: { type: 'string' } },
        required: ['summary'],
      },
      render: (args, value) => text(value && value.summary ? value.summary : ''),
    },
    async execute(args) {
      const query = String((args && args.query) || '').trim().slice(0, 80)
      if (query === '') throw new Error('query 必填')
      const result = await runPython(python, workspace, ['-c', SEARCH_SNIPPET, query])
      if (result.code !== 0) {
        const detail = (result.err || '').trim().split('\n').slice(-1)[0] || `exit ${result.code}`
        throw new Error(`搜索失败：${detail}`)
      }
      const line = (result.out || '').trim().split('\n').filter(Boolean).pop() || ''
      let parsed
      try {
        parsed = JSON.parse(line)
      } catch {
        throw new Error('搜索结果无法解析')
      }
      if (parsed.ok !== true) throw new Error(String(parsed.text || '没有搜到结果'))
      const items = Array.isArray(parsed.items) ? parsed.items : []
      const body = items
        .map((item, index) => `${index + 1}. ${item.title}${item.snippet ? '\n   ' + item.snippet : ''}`)
        .join('\n')
      return {
        ok: true,
        summary: items.length === 0 ? `搜索「${query}」没找到结果` : `搜索「${query}」结果：\n${body}`,
      }
    },
  }))

  ctx.effect(() => ctx.tools.register({
    name: 'web_fetch',
    description: '抓取一个网页并返回正文纯文本（默认前 4000 字）。只支持 http/https 公开页面。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '完整网址，必须以 http:// 或 https:// 开头' },
        maxChars: { type: 'integer', description: '最多返回多少字，默认 4000，最大 20000' },
      },
      required: ['url'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { url: { type: 'string' }, title: { type: 'string' }, text: { type: 'string' } },
        required: ['url', 'text'],
      },
      render: (args, value) => text(`${value && value.title ? value.title + '\n' : ''}${value && value.text ? value.text : ''}`),
    },
    async execute(args) {
      const url = String((args && args.url) || '').trim()
      if (!/^https?:\/\//i.test(url)) throw new Error('url 必须以 http:// 或 https:// 开头')
      const cap = Math.max(500, Math.min(20000, Number(args && args.maxChars) || 4000))
      const response = await fetch(url, {
        signal: AbortSignal.timeout(15000),
        headers: {
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36',
          'accept-language': 'zh-CN,zh;q=0.9',
        },
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const html = await response.text()
      const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
      const body = html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/\s+/g, ' ')
        .trim()
      return {
        url,
        title: titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim().slice(0, 120) : '',
        text: body.slice(0, cap),
      }
    },
  }))

  /* ---- 点歌台：让 agent 自己判断意图，然后直接调直播服务的接口 ---- */
  let lastSkipAt = 0

  /** 同一轮对话里，同一个人的同一首歌只排一次（模型有时会重复调工具）。 */
  const recentRequests = new Map()

  async function livePost(path, payload, timeoutMs = 15000) {
    const response = await fetch(`${apiBase}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload || {}),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await response.text()
    let parsed = null
    try { parsed = JSON.parse(text) } catch { parsed = null }
    if (!response.ok) {
      const detail = parsed && (parsed.reason || parsed.error || parsed.text) ? String(parsed.reason || parsed.error || parsed.text) : text.slice(0, 120)
      throw new Error(`HTTP ${response.status}${detail ? '：' + detail : ''}`)
    }
    return parsed
  }

  ctx.effect(() => ctx.tools.register({
    name: 'song_request',
    description: '给直播间点歌，排进点歌台队列（真的会放）。'
      + '只在有人明确想点歌时才调用，例如「点歌 夜曲」「能放首周杰伦吗」「我想听晴天」。'
      + '如果只是评价歌曲、聊音乐、或者在问「现在放的是什么歌」，不要调用。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '歌名，可以带歌手，例如「夜曲 周杰伦」' },
        user: { type: 'string', description: '点歌人的昵称；不知道就留空' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, message: { type: 'string' } },
        required: ['message'],
      },
      render: (args, value) => text(value && value.message ? value.message : ''),
    },
    async execute(args) {
      const query = String((args && args.query) || '').trim().slice(0, 40)
      const user = String((args && args.user) || '').trim().slice(0, 24) || '观众'
      if (query === '') throw new Error('query 必填')
      const dedupeKey = `${user}|${query}`
      const now = Date.now()
      const seen = recentRequests.get(dedupeKey)
      if (seen && now - seen < 60000) {
        return { ok: true, message: `《${query}》刚刚已经排上了，不用重复点` }
      }
      recentRequests.set(dedupeKey, now)
      const payload = await livePost('/api/song/request', { user, query })
      const song = payload && payload.song && typeof payload.song === 'object' ? payload.song : null
      if (song === null) {
        return { ok: false, message: `没找到「${query}」，换个说法或歌名再试` }
      }
      return {
        ok: true,
        message: `已排队：《${String(song.title || query)}》${song.artist ? ' - ' + song.artist : ''}`
          + (Number(payload.position) > 0 ? `（第 ${payload.position} 位）` : ''),
      }
    },
  }))

  ctx.effect(() => ctx.tools.register({
    name: 'song_skip',
    description: '跳过直播间正在放的歌，放下一首。'
      + '只在有人明确要求切歌/换一首/这首不好听时才调用；自己也觉得该换、且已放了大半时也可以。'
      + '短时间只能切一次，被拒就照实告诉对方。',
    parameters: {
      type: 'object',
      properties: {
        user: { type: 'string', description: '要求切歌的人；不知道就留空' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, message: { type: 'string' } },
        required: ['message'],
      },
      render: (args, value) => text(value && value.message ? value.message : ''),
    },
    async execute(args) {
      const user = String((args && args.user) || '').trim().slice(0, 24) || '老板'
      const gapMs = Math.max(0, Number(skipCooldownSec) || 0) * 1000
      const now = Date.now()
      const last = readLastSkip()
      if (gapMs > 0 && now - last < gapMs) {
        const left = Math.ceil((gapMs - (now - last)) / 1000)
        return { ok: false, message: `刚切过，${left} 秒后再切` }
      }
      writeLastSkip(now)
      // /api/song/skip 不读 body：带 body 会把 keep-alive 连接写脏（下一个请求会 501）
      const response = await fetch(`${apiBase}/api/song/skip`, { method: 'POST', signal: AbortSignal.timeout(15000) })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const payload = await response.json()
      const next = payload && payload.next && typeof payload.next === 'object' ? payload.next : null
      return { ok: true, message: next ? `已切到《${String(next.title || '')}》` : '已切歌，队列空了' }
    },
  }))

  /* ---- 看一眼 DSH 自己：home / profiles / 会话记录（全部只读） ---------- */

  const dshHome = process.env.DSH_HOME && String(process.env.DSH_HOME).trim() !== ''
    ? String(process.env.DSH_HOME).trim()
    : join(os.homedir(), '.dsh')

  function listDir(path) {
    try {
      return readdirSync(path)
    } catch {
      return []
    }
  }

  /** 会话文件是按帧追加的 zstd，多帧拼接；按魔数切开逐帧解压。 */
  let zstdDecode = null
  async function decodeSessionFile(file) {
    if (zstdDecode === null) {
      try {
        const zlib = await import('node:zlib')
        zstdDecode = typeof zlib.zstdDecompressSync === 'function' ? zlib.zstdDecompressSync : false
      } catch {
        zstdDecode = false
      }
    }
    if (zstdDecode === false) return ''
    const buffer = readFileSync(file)
    const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
    const starts = []
    let at = 0
    while (starts.length < 4096) {
      const found = buffer.indexOf(magic, at)
      if (found < 0) break
      starts.push(found)
      at = found + 4
    }
    if (starts.length === 0) return ''
    let out = ''
    for (let index = 0; index < starts.length; index += 1) {
      const start = starts[index]
      const end = index + 1 < starts.length ? starts[index + 1] : buffer.length
      try {
        out += zstdDecode(buffer.subarray(start, end)).toString('utf8')
      } catch {
        // 魔数撞进压缩数据里了：这一帧跳过，不影响别的帧
      }
    }
    return out
  }

  function readJsonLines(raw) {
    const events = []
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      try {
        events.push(JSON.parse(trimmed))
      } catch {
        // 半截行（正在写）忽略
      }
    }
    return events
  }

  /** 从事件里抠出人话：user / assistant 的消息文本。 */
  function eventText(event) {
    const message = event && event.data && event.data.message ? event.data.message : null
    if (!message) return null
    const role = String(message.role || '')
    if (role !== 'user' && role !== 'assistant') return null
    const parts = Array.isArray(message.content) ? message.content : []
    const body = parts
      .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (body === '') return null
    return { role, text: body }
  }

  ctx.effect(() => ctx.tools.register({
    name: 'dsh_info',
    description: '看一眼这台电脑上的 DeepSeek Harness（DSH）本身：安装位置、有哪些 profile 及各自的组合包、'
      + '会话记录有多少、配置文件在哪。老板问「DSH 现在什么情况」「我有哪些 profile」「你跑在哪个 DSH 上」时用这个。'
      + '全部只读。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: {
        type: 'object',
        properties: { summary: { type: 'string' } },
        required: ['summary'],
      },
      render: (args, value) => text(value && value.summary ? value.summary : ''),
    },
    async execute() {
      const lines = []
      const exists = (() => { try { return statSync(dshHome).isDirectory() } catch { return false } })()
      lines.push(`DSH_HOME: ${dshHome}${exists ? '' : '（不存在/读不到）'}`)
      if (!exists) return { summary: lines.join('\n') }

      const profilesDir = join(dshHome, 'profiles')
      const profiles = listDir(profilesDir)
      lines.push(`profiles（${profiles.length}）: ${profiles.join('、') || '(无)'}`)
      for (const name of profiles.slice(0, 8)) {
        let bundles = '(读不到 package.json)'
        try {
          const pkg = JSON.parse(readFileSync(join(profilesDir, name, 'package.json'), 'utf8').replace(/^\uFEFF/, ''))
          const list = pkg && pkg.dsh && pkg.dsh.profile && Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : []
          bundles = list.length > 0 ? list.join(' + ') : '(空)'
        } catch { /* 保持提示文案 */ }
        const patched = (() => { try { return statSync(join(profilesDir, name, 'cordis.patch.yml')).size } catch { return 0 } })()
        lines.push(`  · ${name}: bundles=[${bundles}] patch=${patched}B`)
      }

      const sessionsDir = join(dshHome, 'sessions')
      const workspaces = listDir(sessionsDir)
      let total = 0
      const rows = []
      for (const workspace of workspaces) {
        const dir = join(sessionsDir, workspace)
        const ids = listDir(dir).filter((entry) => entry.startsWith('session-'))
        total += ids.length
        if (ids.length > 0) rows.push(`  · ${workspace.slice(0, 70)}: ${ids.length} 个会话`)
      }
      lines.push(`会话记录: 共 ${total} 个（工作区分组）`)
      lines.push(...rows.slice(0, 6))

      const configFiles = ['.env', 'prompt-inject.md', '.credentials.yaml', 'profiles'].filter((name) => {
        try { statSync(join(dshHome, name)); return true } catch { return false }
      })
      lines.push(`DSH_HOME 下的东西: ${configFiles.join('、')}`)
      let envKeys = []
      try {
        envKeys = readFileSync(join(dshHome, '.env'), 'utf8')
          .split(/\r?\n/)
          .map((line) => line.split('=')[0].trim())
          .filter((key) => key !== '' && !key.startsWith('#'))
      } catch { /* 没有 .env */ }
      if (envKeys.length > 0) lines.push(`.env 里的键（只有名字，值我不会读）: ${envKeys.join('、')}`)
      lines.push('要细看某个文件就用 read_text_file 读绝对路径；想看具体会话就调 dsh_session_read。')
      return { summary: lines.join('\n') }
    },
  }))

  ctx.effect(() => ctx.tools.register({
    name: 'dsh_sessions',
    description: '列出最近的 DSH 会话记录（按最后修改时间倒序）：属于哪个工作区、会话 id、多大、什么时候更新的。'
      + '想看某条会话里聊了什么，再拿 id 调 dsh_session_read。',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: '列几条，默认 10，最多 30' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { summary: { type: 'string' } },
        required: ['summary'],
      },
      render: (args, value) => text(value && value.summary ? value.summary : ''),
    },
    async execute(args) {
      const limit = Math.max(1, Math.min(30, Number(args && args.limit) || 10))
      const sessionsDir = join(dshHome, 'sessions')
      const found = []
      for (const workspace of listDir(sessionsDir)) {
        const dir = join(sessionsDir, workspace)
        for (const id of listDir(dir)) {
          if (!id.startsWith('session-')) continue
          const file = join(dir, id, 'session.v4.jsonl.zstd')
          try {
            const info = statSync(file)
            found.push({ workspace, id, size: info.size, mtime: info.mtimeMs })
          } catch {
            found.push({ workspace, id, size: 0, mtime: 0 })
          }
        }
      }
      found.sort((a, b) => b.mtime - a.mtime)
      const rows = found.slice(0, limit).map((row) => {
        const when = row.mtime > 0 ? new Date(row.mtime).toLocaleString('zh-CN') : '(未知时间)'
        return `· ${when}  ${row.id}\n  工作区 ${row.workspace.slice(0, 80)}  ${(row.size / 1024).toFixed(0)}KB`
      })
      return {
        summary: found.length === 0
          ? '没有找到会话记录。'
          : `最近 ${rows.length} 个会话（共 ${found.length} 个）：\n${rows.join('\n')}`,
      }
    },
  }))

  ctx.effect(() => ctx.tools.register({
    name: 'dsh_session_read',
    description: '读一条 DSH 会话记录里的人和 AI 说的话（只读，压缩存档也能解）。'
      + '老板问「你刚才那轮都说了什么」「上次那个会话聊了啥」时用。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '会话 id，例如 session-xxxx（dsh_sessions 里能拿到）' },
        limit: { type: 'integer', description: '取最后多少条消息，默认 12，最多 40' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { summary: { type: 'string' } },
        required: ['summary'],
      },
      render: (args, value) => text(value && value.summary ? value.summary : ''),
    },
    async execute(args) {
      const id = String((args && args.id) || '').trim()
      const limit = Math.max(1, Math.min(40, Number(args && args.limit) || 12))
      if (id === '') throw new Error('id 必填')
      const sessionsDir = join(dshHome, 'sessions')
      let file = ''
      let workspace = ''
      for (const name of listDir(sessionsDir)) {
        const candidate = join(sessionsDir, name, id, 'session.v4.jsonl.zstd')
        try {
          statSync(candidate)
          file = candidate
          workspace = name
          break
        } catch { /* 下一个工作区 */ }
      }
      if (file === '') throw new Error(`找不到会话 ${id}（先用 dsh_sessions 看看有哪些）`)
      const events = readJsonLines(await decodeSessionFile(file))
      if (events.length === 0) return { summary: '这个会话文件解不开或还是空的。' }
      let title = ''
      const messages = []
      for (const event of events) {
        if (event && event.type === 'session/title') {
          const data = event.data || {}
          title = String(data.title || data.text || '').slice(0, 80)
          continue
        }
        const line = eventText(event)
        if (line !== null) messages.push(line)
      }
      const tail = messages.slice(-limit)
      if (tail.length === 0) return { summary: `会话 ${id} 里没有可读的对话（只有系统事件）。` }
      const body = tail.map((item) => `${item.role === 'user' ? '老板/观众' : 'AI'}: ${item.text.slice(0, 300)}`)
      return {
        summary: [
          `会话 ${id}${title !== '' ? `《${title}》` : ''}（工作区 ${workspace.slice(0, 60)}）`,
          `最后 ${tail.length} 条：`,
          ...body,
        ].join('\n'),
      }
    },
  }))
}

export default { name, inject, apply }