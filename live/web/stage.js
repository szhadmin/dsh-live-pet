// 大肥鲸直播舞台 v3：左弹幕池（大字） + 鲸鱼 + 大字气泡 + 点歌台
const $ = (id) => document.getElementById(id);
const PREVIEW = new URLSearchParams(location.search).has('preview');
if (PREVIEW) document.body.classList.add('preview');

const WEBP_BASE = '/gifs/stage/';
const GIF_BASE = '/gifs/';
const EMOTION_FILE = {
  happy: 'whale_happy',
  mischievous: 'whale_mischievous',
  eating: 'whale_eating',
  calm: 'whale_walking',
  walking: 'whale_walking',
  // 礼物动作
  cry: 'whale_crying',
  cook: 'whale_cooking',
  code: 'whale_coding',
  sad: 'whale_unhappy',
  sofa: 'whale_tv',
};

// 缺图回退链：万一某个动图被删了，按这个顺序找替代（不会出现破图）
const GIF_FALLBACK = {
  whale_crying: 'whale_mischievous',
  whale_cooking: 'whale_eating',
  whale_coding: 'whale_happy',
  whale_tv: 'whale_walking',
  whale_unhappy: 'whale_mischievous',
};

let useWebp = true;
let currentGif = 'whale_walking';
let frontIsA = true;
let prevAudioId = 0;
let blocked = false;
let giftTimer = null;
let lastGift = '';
let uptimeBase = 0;
let uptimeStamp = 0;

const audio = $('voiceAudio');
const gate = $('soundGate');
const music = $('musicAudio');
let musicId = 0;
let musicBase = 0.55;
let musicPlaying = false;

// ---------- 动图素材：优先透明底 WebP，失败回退 GIF ----------
const probe = new Image();
probe.onerror = () => {
  useWebp = false;
  applyGif(currentGif, true);
};
probe.src = WEBP_BASE + 'whale_walking.webp';

function srcFor(name) {
  return (useWebp ? WEBP_BASE + name + '.webp' : GIF_BASE + name + '.gif');
}

function applyGif(name, force = false) {
  name = EMOTION_FILE[name] || name;
  if (!force && name === currentGif) return;
  currentGif = name;
  const front = frontIsA ? $('whaleA') : $('whaleB');
  const back = frontIsA ? $('whaleB') : $('whaleA');
  // 三级兜底：webp → 同名 gif（用户自己放的图没跑过 prepare_gifs）→ 预设回退图
  let triedGif = false;
  back.onerror = () => {
    if (useWebp && !triedGif) {
      triedGif = true;
      back.src = GIF_BASE + name + '.gif';
      return;
    }
    back.onerror = null;
    const alt = GIF_FALLBACK[name];
    if (alt && alt !== name) back.src = srcFor(alt);
  };
  back.src = srcFor(name);
  back.classList.remove('fade');
  front.classList.add('fade');
  frontIsA = !frontIsA;
}

// ---------- 装饰：气泡 / 浮游生物 / 星点 ----------
(function bubbles() {
  const host = $('bubbles');
  if (!host) return;
  for (let i = 0; i < 18; i++) {
    const b = document.createElement('i');
    const size = 1 + Math.random() * 3.4;
    b.style.width = size + 'vw';
    b.style.height = size + 'vw';
    b.style.left = Math.random() * 96 + '%';
    b.style.animationDuration = 9 + Math.random() * 12 + 's';
    b.style.animationDelay = -Math.random() * 18 + 's';
    host.appendChild(b);
  }
})();

(function plankton() {
  const host = $('plankton');
  if (!host) return;
  for (let i = 0; i < 30; i++) {
    const d = document.createElement('i');
    const s = 0.22 + Math.random() * 0.5;
    d.style.width = s + 'vw';
    d.style.height = s + 'vw';
    d.style.left = Math.random() * 100 + '%';
    d.style.top = Math.random() * 100 + '%';
    d.style.animationDelay = -Math.random() * 4 + 's';
    d.style.animationDuration = 2.6 + Math.random() * 3.4 + 's';
    host.appendChild(d);
  }
})();

(function sparkles() {
  const host = $('sparkles');
  if (!host) return;
  for (let i = 0; i < 18; i++) {
    const a = (i / 18) * Math.PI * 2 + Math.random() * 0.35;
    const r = 0.17 + Math.random() * 0.13;
    const d = document.createElement('i');
    d.style.left = (50 + Math.cos(a) * r * 100) + '%';
    d.style.top = (52 + Math.sin(a) * r * 118) + '%';
    d.style.animationDelay = -Math.random() * 3 + 's';
    host.appendChild(d);
  }
})();

// ---------- 声音 ----------
function setTalking(on) {
  const stack = $('whaleStack');
  if (stack) stack.classList.toggle('talking', !!on);
}

function tryPlay() {
  if (PREVIEW) return;
  if (musicPlaying) {
    music.play().then(() => { music.volume = musicBase; }).catch(() => {});
  }
  if (!audio.src) return;
  audio.play().then(() => {
    blocked = false;
    gate.hidden = true;
    setTalking(true);
  }).catch(() => {
    blocked = true;
    gate.hidden = false;
  });
}

audio.addEventListener('ended', () => setTalking(false));
audio.addEventListener('pause', () => setTalking(false));
audio.addEventListener('play', () => { gate.hidden = true; setTalking(true); });
audio.addEventListener('error', () => { if (!PREVIEW) { blocked = true; gate.hidden = false; } });
gate.addEventListener('click', (e) => { e.stopPropagation(); tryPlay(); });
document.addEventListener('click', () => { if (blocked) tryPlay(); });

// ---------- 点歌音乐 ----------
function duckMusic(speaking) {
  if (!musicPlaying) return;
  music.volume = speaking ? Math.min(0.18, musicBase) : musicBase;
}

function playMusic(m) {
  if (!m || !m.url) return;
  musicBase = Number(m.volume || 0.55);
  musicId = m.id;
  music.src = m.url;
  music.volume = musicBase;
  musicPlaying = true;
  if (PREVIEW) return;
  music.play().catch(() => { blocked = true; gate.hidden = false; });
}

function stopMusic() {
  musicPlaying = false;
  try { music.pause(); } catch (e) { /* ignore */ }
}

music.addEventListener('ended', () => {
  const id = musicId;
  stopMusic();
  if (!PREVIEW) {
    fetch('/api/song/finished', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    }).catch(() => {});
  }
});
music.addEventListener('error', () => {
  if (!musicPlaying) return;
  const id = musicId;
  // 在线歌的直链会过期/被防盗链，让后端换成缓存文件或重新取一次
  fetch('/api/song/retry', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  }).then((r) => r.json()).then((d) => {
    if (d && d.ok && d.url && d.changed) {
      music.src = d.url;
      music.volume = musicBase;
      music.play().catch(() => {});
    } else {
      stopMusic();
    }
  }).catch(() => stopMusic());
});

// ---------- 渲染：弹幕池 ----------
const POOL_KINDS = new Set(['comment', 'gift', 'enter', 'follow', 'like']);
const POOL_ICON = { comment: '💬', gift: '🎁', enter: '🐟', follow: '⭐', like: '❤' };
let lastPoolKey = '';

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderPool(events) {
  const list = (events || []).filter((e) => POOL_KINDS.has(e.kind)).slice(0, 13);
  const key = list.map((e) => e.time + (e.text || '') + (e.kind || '')).join('|');
  if (key === lastPoolKey) return;
  lastPoolKey = key;
  $('danmuCount').textContent = list.length;
  const host = $('danmuList');
  if (!list.length) {
    host.innerHTML = '<li class="empty">等一条弹幕…</li>';
    return;
  }
  host.innerHTML = list.map((e) => {
    let text = e.text || '';
    const prefix = (e.user || '') + '：';
    if (text.startsWith(prefix)) text = text.slice(prefix.length);
    const who = e.user ? `<b>${escapeHtml(e.user)}</b> ` : '';
    return `<li class="${e.kind}"><span class="ico">${POOL_ICON[e.kind] || ''}</span>${who}${escapeHtml(text)}</li>`;
  }).join('');
}

// ---------- 渲染：点歌台 ----------
let lastSongKey = '';

function renderJukebox(mq) {
  mq = mq || {};
  const cur = mq.current || (mq.playing && mq.title ? mq : null);
  const queue = mq.queue || [];
  const key = JSON.stringify([cur && cur.title, cur && cur.user, queue.map((q) => (q.title || '') + (q.user || ''))]);
  if (key !== lastSongKey) {
    lastSongKey = key;
    $('songCount').textContent = mq.queue_len || queue.length || 0;
    const np = $('nowPlaying');
    if (cur && cur.title) {
      np.innerHTML = `<div class="np-title">♪ ${escapeHtml(cur.title)}</div>
        <div class="np-user">${cur.user ? escapeHtml(cur.user) + ' 点的' : '正在播放'}</div>
        <div class="np-bar"><i id="npBar"></i></div>`;
    } else {
      np.innerHTML = '<div class="np-empty">还没有人点歌 · 送礼点歌</div>';
    }
    const rows = queue.slice(0, 6).map((q, i) =>
      `<li><em>${i + 1}</em><span>${escapeHtml(q.title || '歌曲')}${q.user ? ' · ' + escapeHtml(q.user) : ''}</span></li>`);
    $('songQueue').innerHTML = rows.join('') || '<li class="empty"><em>—</em><span>队列空着</span></li>';
  }
  const bar = document.getElementById('npBar');
  if (bar) {
    const dur = (cur && cur.duration) || mq.duration || 0;
    bar.style.width = dur ? Math.min(100, ((mq.elapsed || 0) / dur) * 100) + '%' : '0%';
  }
}

// ---------- 渲染：礼物横幅 / 大字气泡 ----------
function showGift(text) {
  if (!text) return;
  const el = $('giftBanner');
  el.textContent = '🎁 ' + text;
  el.classList.add('show');
  clearTimeout(giftTimer);
  giftTimer = setTimeout(() => el.classList.remove('show'), 4200);
}

let lastReply = '';
let lastWho = '';
let actionTipTimer = null;

function fmtNum(n) {
  n = Number(n) || 0;
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(Math.round(n));
}

function fmtMoney(v) {
  v = Number(v) || 0;
  if (v >= 10000) return '¥' + (v / 10000).toFixed(1) + 'w';
  if (v >= 100) return '¥' + v.toFixed(0);
  return '¥' + v.toFixed(v >= 1 ? 1 : 2).replace(/\.0+$/, '');
}

// ---------- 刷礼菜单：让观众知道刷什么能触发什么动作 ----------
let lastMenuSig = '';

function renderGiftMenu(rows) {
  const panel = $('giftMenuPanel');
  const list = $('giftMenuList');
  if (!panel || !list) return;
  if (!rows || !rows.length) { panel.hidden = true; return; }
  const sig = rows.map((r) => r.name + '|' + r.action + '|' + r.icon).join(',');
  if (sig === lastMenuSig) return;      // 没变就别重绘（600ms 一次轮询）
  lastMenuSig = sig;
  panel.hidden = false;
  list.innerHTML = rows.map((r) => `
    <li class="gm-row">
      ${r.icon
        ? `<img src="${esc(r.icon)}" alt="${esc(r.name)}" loading="lazy">`
        : '<span class="gm-ico">🎁</span>'}
      <div class="gm-mid">
        <span class="gm-name">${esc(r.name)}</span>
        <span class="gm-price">${r.diamond ? r.diamond + '抖币' : ''}${r.cny ? ' ¥' + (r.cny >= 100 ? Math.round(r.cny) : r.cny.toFixed(1)) : ''}</span>
      </div>
      <span class="gm-act">${esc(r.action_label || '谢谢')}</span>
    </li>`).join('');
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- 礼物动作：送礼物 → 鲸鱼做动作 + 全屏特效 ----------
const FX_GLYPH = {
  stars: '★', hearts: '♥', food: '🍜', sparkle: '✦', confetti: '▮',
  bubbles: '○', notes: '♪', fireworks: '✹',
};
const ACTION_CLASS = {
  dance: 'act-dance', spin: 'act-spin', eat: 'act-eat', bow: 'act-bow',
  cheer: 'act-cheer', heart: 'act-heart', sing: 'act-sing',
  fireworks: 'act-cheer', sleep: 'act-sleep', hello: 'act-hello',
  cry: 'act-cry', cook: 'act-cook', code: 'act-code', sofa: 'act-sofa',
  sad: 'act-sad',
};
let lastActionId = 0;
let actionGifTimer = null;    // 动作动图停留计时（到期后交回后端算好的 gif）

function burst(fx) {
  const host = $('fxLayer');
  if (!host || !fx) return;
  const n = fx === 'confetti' ? 26 : 18;
  for (let i = 0; i < n; i++) {
    const el = document.createElement('i');
    el.className = 'fx fx-' + fx;
    el.textContent = FX_GLYPH[fx] || '✦';
    el.style.left = 8 + Math.random() * 84 + '%';
    el.style.setProperty('--dx', Math.random() * 170 - 85 + 'px');
    el.style.setProperty('--dur', 1.5 + Math.random() * 1.4 + 's');
    el.style.setProperty('--size', 14 + Math.random() * 24 + 'px');
    el.style.animationDelay = Math.random() * 0.35 + 's';
    host.appendChild(el);
    setTimeout(() => el.remove(), 3400);
  }
}

function playAction(a) {
  if (!a || !a.id || a.id === lastActionId) return;
  lastActionId = a.id;
  if (a.fx) burst(a.fx);

  // 动作可以指定自己的动图（后端 gift_actions.actions 配置），没写就用情绪图
  const holdMs = Math.max(1000, Math.min(60000, Number(a.hold || 6) * 1000));
  if (a.gif) {
    applyGif(a.gif, true);
    clearTimeout(actionGifTimer);
    // 停留期间不要被轮询的情绪图顶掉；到点后放开，由后端算好的 gif 接管
    actionGifTimer = setTimeout(() => {
      actionGifTimer = null;
    }, holdMs);
  }

  const stack = $('whaleStack');
  const cls = ACTION_CLASS[a.name];
  if (stack && cls) {
    Object.values(ACTION_CLASS).forEach((c) => stack.classList.remove(c));
    void stack.offsetWidth;
    stack.classList.add(cls);
    setTimeout(() => stack.classList.remove(cls), Math.min(holdMs, 4000));
  }
  const tip = $('actionTip');
  if (tip) {
    tip.textContent = a.text || ('动作 · ' + (a.name || ''));
    tip.classList.add('show');
    clearTimeout(actionTipTimer);
    actionTipTimer = setTimeout(() => tip.classList.remove('show'), Math.max(holdMs, 3000));
  }
  if (a.gift) {
    showGift((a.user ? a.user + ' · ' : '') + a.gift + (a.count > 1 ? ' ×' + a.count : ''));
  }
}

function renderBubble(s) {
  const who = s.username || '观众';
  if (who !== lastWho) {
    lastWho = who;
    $('bubbleWho').textContent = who === '大肥鲸' ? '大肥鲸' : who;
  }
  $('bubbleTag').textContent = PREVIEW ? '预览' : s.status === 'speaking' ? '正在说' : s.status === 'thinking' ? '想想…' : '待机';
  if (s.reply && s.reply !== lastReply) {
    lastReply = s.reply;
    const el = $('bubbleText');
    el.textContent = s.reply;
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
  }
}

// ---------- 时钟 ----------
function fmtClock(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = String(Math.floor(sec / 3600)).padStart(2, '0');
  const m = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
  const s = String(sec % 60).padStart(2, '0');
  return h + ':' + m + ':' + s;
}

setInterval(() => {
  if (!uptimeStamp) return;
  const sec = uptimeBase + (Date.now() - uptimeStamp) / 1000;
  $('clock').textContent = fmtClock(sec);
}, 1000);

// ---------- 主轮询 ----------
async function poll() {
  try {
    const s = await (await fetch('/api/state', { cache: 'no-store' })).json();
    $('hostName').textContent = (s.settings && s.settings.host && s.settings.host.name) || '大肥鲸';
    const tagEl = $('brandTag');
    const hostCfg = (s.settings && s.settings.host) || {};
    if (tagEl) {
      tagEl.textContent = 'FAT WHALE LIVE · ' + (hostCfg.tagline || hostCfg.title || '深海工位');
    }
    $('requests').textContent = s.requests;
    $('gifts').textContent = s.gifts;
    $('facts').textContent = (s.memory_stats && s.memory_stats.facts) || 0;
    const income = Number(s.gift_value || 0);
    const tokens = (Number(s.input_tokens) || 0) + (Number(s.output_tokens) || 0);
    const incomeEl = $('income');
    if (incomeEl) {
      incomeEl.textContent = fmtMoney(income);
      incomeEl.title = '礼物收入 ¥' + income.toFixed(1);
    }
    const tokenEl = $('tokens');
    if (tokenEl) {
      tokenEl.textContent = fmtNum(tokens);
      tokenEl.title = `输入 ${s.input_tokens || 0} / 输出 ${s.output_tokens || 0}`;
    }
    uptimeBase = s.uptime || 0;
    uptimeStamp = Date.now();

    renderBubble(s);
    // 动作动图还在停留期内就别被轮询的情绪图顶掉
    if (!actionGifTimer) applyGif(s.gif || 'whale_walking');

    if (s.settings && s.settings.gif_theme === 'gif' && useWebp) {
      useWebp = false;
      applyGif(currentGif, true);
    }

    if (PREVIEW) {
      setTalking(s.status === 'speaking');
    } else if (s.status === 'speaking' && s.audio_id && s.audio_id !== prevAudioId) {
      prevAudioId = s.audio_id;
      audio.src = s.audio_url;
      tryPlay();
    } else if (s.status !== 'speaking' && !audio.paused) {
      setTalking(false);
    }

    if (s.last_gift && s.last_gift !== lastGift) {
      lastGift = s.last_gift;
      showGift(s.last_gift);
    }

    if (s.action) playAction(s.action);

    const mu = s.music || {};
    if (mu.playing && mu.id && mu.id !== musicId) {
      playMusic(mu);
    } else if (!mu.playing && musicPlaying) {
      stopMusic();
    }
    duckMusic(s.status === 'speaking');

    renderPool(s.events);
    renderJukebox(s.music_queue);
    renderGiftMenu(s.gift_menu);
  } catch (e) {
    $('bubbleTag').textContent = '连接中…';
  }
}

setInterval(poll, 600);
poll();
