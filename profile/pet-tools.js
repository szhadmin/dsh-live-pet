/**
 * dsh-live-pet 的只读工具 —— 宠物 profile 专用。
 *
 * 为什么不用 pwsh：shell 工具的沙箱升级由模型自己申请（`sandbox_permissions`），
 * 在无人值守的子进程里没有审批应答者，升级请求会被直接放行 —— 等于没锁。
 * 这里用 Node 自己读系统信息：没有写路径，只读是代码保证的，不依赖沙箱。
 */
import { statfsSync, readFileSync, writeFileSync, statSync } from 'node:fs'
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
}

export default { name, inject, apply }