// 大肥鲸直播控制台
const $ = (id) => document.getElementById(id);
const api = async (path, data) => {
  const opt = data === undefined ? {} : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  };
  const r = await fetch(path, opt);
  return r.json();
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const TAGS = {
  comment: '弹幕', gift: '礼物', reply: '鲸宝', follow: '关注', enter: '进场',
  like: '点赞', system: '系统', error: '错误', douyin: '抖音', skip: '限流',
  idle: '自主', tool: '工具', music: '点歌', action: '动作',
};
let cfgReady = false;
let activeMemUser = '';

// ---------------- Tabs ----------------
$('tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (!btn) return;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === btn));
  document.querySelectorAll('.tab-body').forEach((b) =>
    b.classList.toggle('active', b.dataset.body === btn.dataset.tab));
  if (btn.dataset.tab === 'memory') loadMemory();
  if (btn.dataset.tab === 'songs') loadSongs();
  if (btn.dataset.tab === 'gifts') loadGift();
  if (btn.dataset.tab === 'giftbook') loadGiftBook();
  if (btn.dataset.tab === 'douyin') renderDouyin();
});

// ---------------- 轮询 ----------------
let lastEvents = '';

async function poll() {
  try {
    const s = await api('/api/state');
    $('sRequests').textContent = s.requests;
    $('sIn').textContent = s.input_tokens.toLocaleString();
    $('sOut').textContent = s.output_tokens.toLocaleString();
    $('sGifts').textContent = s.gifts;
    $('sGiftValue').textContent = '¥' + Number(s.gift_value).toFixed(1);
    $('sQueue').textContent = s.queue;
    $('sUsers').textContent = s.memory_stats.users;
    $('sFacts').textContent = s.memory_stats.facts;
    $('sTurns').textContent = s.memory_stats.turns;
    $('dbPath').textContent = s.memory_stats.db_path.split('\\').slice(-2).join('/');

    $('runState').innerHTML = '<i></i>' + (s.settings.has_key ? '大模型在线' : '本地话术在线');
    const dy = s.douyin || {};
    $('douyinPill').textContent = '抖音：' + ({
      off: '未接入', stopped: '已停止', connecting: '连接中', connected: '已连接', error: '异常',
    }[dy.state] || dy.state) + (dy.mode && dy.mode !== 'off' ? ' · ' + dy.mode : '');

    if (!cfgReady) fillConfig(s.settings);
    renderDouyin(dy);
    renderToolList(s.tool_catalog);
    if (s.harness) { window.__agentState = s.agent || null; renderHarness(s.harness); }
    if (document.querySelector('.tab.active')?.dataset.tab === 'songs' && s.music_queue) {
      renderSongStatus(s.music_queue);
    }
    if (s.idle && document.querySelector('.tab.active')?.dataset.tab === 'interact') {
      const idle = s.idle;
      const wait = Math.max(0, Math.ceil((idle.gap || 0) - (idle.silent || 0)));
      $('idleTip').textContent = idle.enable
        ? (idle.busy ? '鲸宝正在自己找话题…'
          : `静默 ${Math.round(idle.silent || 0)} 秒 / 触发阈值 ${Math.round(idle.gap || 0)} 秒`
            + (wait > 0 ? `，还有 ${wait} 秒开口` : '，马上就开口')
            + `（本小时自主发言 ${idle.count || 0} 次）`)
        : '冷场发言已关闭';
    }
    renderLiveAction(s.action);
    renderEvents(s.events);
  } catch (e) { /* 忽略瞬时错误 */ }
}

// 人设提示：留空时后端会用自己的内置默认（打工大肥鲸）
let personaDefaultText = '';
function renderPersonaHint(st) {
  const el = $('personaHint');
  if (!el) return;
  personaDefaultText = (st && st.persona_default) || personaDefaultText;
  const custom = !!(st && st.persona && st.persona.trim());
  const n = ((st && st.persona) || '').trim().length;
  el.innerHTML = custom
    ? `当前使用<b>自定义人设</b>（${n} 字）。清空内容保存即可回到内置默认。`
    : '当前使用<b>内置默认人设「打工大肥鲸」</b>：不装、敢冲、嘴贫但靠谱，短句为主、giao 当标点。'
      + '在上面填内容即可覆盖它。';
}


function fillConfig(st) {
  cfgReady = true;
  $('baseUrl').value = st.base_url;
  $('model').value = st.model;
  $('voice').value = st.voice;
  $('rate').value = st.rate;
  $('pitch').value = st.pitch;
  $('gifTheme').value = st.gif_theme;
  $('persona').value = st.persona || '';
  renderPersonaHint(st);
  $('dyUrl').value = st.douyin.bridge_url;
  const liveUrl = st.douyin.live_url || '';
  const roomLike = /douyin\.com\/|^\d{6,}$/.test(st.douyin.room_id || '') ? st.douyin.room_id : '';
  $('dyLive').value = liveUrl || roomLike;
  $('dyMode').value = st.douyin.mode;
  $('dyRoom').value = st.douyin.room_id || '';
  $('dyCookie').value = '';
  $('dyCookie').placeholder = st.douyin.has_cookie
    ? '已保存登录 Cookie（留空=保持不变；要换就整段覆盖粘贴）'
    : '留空 = 匿名连接（部分房间只推 进场/点赞/弹幕，不推礼物）';
  const tcfg = st.tools || {};
  $('toolEnable').value = tcfg.enable === false ? '0' : '1';
  $('toolCity').value = tcfg.default_city || '北京';
  const icfg = st.idle || {};
  $('idleEnable').value = icfg.enable === false ? '0' : '1';
  $('idleSeconds').value = icfg.seconds || 30;
  const pcfg = st.promo || {};
  if ($('promoEnable')) $('promoEnable').value = pcfg.enable === false ? '0' : '1';
  if ($('promoSeconds')) $('promoSeconds').value = pcfg.seconds || 240;
  const h = st.harness || {};
  $('hxEnable').value = h.enable === false ? '0' : '1';
  $('hxQuestionOnly').value = h.question_only ? '1' : '0';
  $('hxTimeout').value = h.timeout || 20;
  $('hxMaxChars').value = h.max_chars || 70;
  $('hxSession').value = h.session === false ? '0' : '1';
  $('hxDeep').value = h.deep ? '1' : '0';
  $('hxModel').value = h.model || '';
  $('hxBaseUrl').value = h.base_url || '';
  $('hxKeyEnv').value = h.api_key_env || 'BUDDYHUB_API_KEY';
  $('hxBin').value = h.dsh_bin || '';
  if ($('hxStyle')) $('hxStyle').value = String(h.style ?? 2);
  if ($('hxGiftAgent')) $('hxGiftAgent').value = h.gift_thanks_agent === false ? '0' : '1';
  if ($('hxQuirks')) $('hxQuirks').value = (h.quirks || []).join('，');
  if ($('hxSuffix')) $('hxSuffix').value = h.persona_suffix || '';
  syncDyMode();
  $('keyHint').textContent = st.has_key
    ? '已保存密钥 ' + st.key_hint + '；留空保存可保留原密钥'
    : '只保存在本机 settings.json；不填就用本地话术大脑';
}

function renderEvents(events) {
  if (!events) return;
  const key = events.length + '|' + (events[0] ? events[0].time + events[0].text : '');
  $('evCount').textContent = events.length;
  if (key === lastEvents) return;
  lastEvents = key;
  $('events').innerHTML = events.map((e) => `
    <div class="event">
      <time>${esc(e.time)}</time>
      <span class="tag ${esc(e.kind)}">${TAGS[e.kind] || esc(e.kind)}</span>
      <p>${esc(e.text)}</p>
    </div>`).join('') || '<p class="muted">等待互动事件…</p>';
}

// ---------------- 互动 ----------------
$('sendBtn').onclick = async () => {
  const text = $('textInput').value.trim();
  if (!text) return;
  $('sendBtn').disabled = true;
  await api('/api/event', { kind: 'comment', username: $('userInput').value || '测试观众', text });
  setTimeout(() => { $('sendBtn').disabled = false; poll(); }, 700);
};
$('idleSave').onclick = async () => {
  const enable = $('idleEnable').value === '1';
  const seconds = Math.max(5, Math.min(600, parseInt($('idleSeconds').value, 10) || 30));
  await api('/api/config', { idle: { enable, seconds } });
  $('idleTip').textContent = enable
    ? `已开启：静默 ${seconds} 秒后鲸宝自己找话题（没人理它时逐步拉长到 150 秒）`
    : '已关闭：没人说话时鲸宝只安静待着';
  poll();
};

$('promoSave').onclick = async () => {
  const enable = $('promoEnable').value === '1';
  const seconds = Math.max(60, Math.min(1800, parseInt($('promoSeconds').value, 10) || 240));
  await api('/api/config', { promo: { enable, seconds } });
  $('promoTip').textContent = enable
    ? `已开启：每 ${seconds} 秒插一句（点点赞、点点关注、点点小心心），有弹幕/礼物时自动让位`
    : '已关闭：不再定时口播';
  poll();
};

$('giftBtn').onclick = async () => {
  await api('/api/event', { kind: 'gift', username: $('userInput').value || '测试观众', gift: $('giftSelect').value, count: 1 });
  setTimeout(poll, 700);
};
// 选了礼物就先告诉用户「这一下鲸鱼会做什么」，不用等真送
function previewGiftAction() { return giftPreviewHint(); }
function actionLabel(key) {
  const hit = (actionCatalog || []).find((a) => a.action === key);
  return hit ? (hit.label || key) : key;
}
if ($('giftSelect')) {
  $('giftSelect').addEventListener('change', previewGiftAction);
  setTimeout(previewGiftAction, 800);
}
document.querySelectorAll('[data-q]').forEach((b) => {
  b.onclick = () => { $('textInput').value = b.dataset.q; $('sendBtn').click(); };
});
$('sayBtn').onclick = async () => { await api('/api/say', {}); setTimeout(poll, 800); };
$('soundBtn').onclick = async () => {
  const d = await api('/api/tts/test-live', {
    voice: $('voice').value, rate: $('rate').value, pitch: $('pitch').value,
  });
  flash(d.ok ? '✓ 已发送到 OBS 舞台，检查舞台页面是否出声' : '失败：' + d.error, d.ok);
};

// ---------------- 记忆 ----------------
async function loadMemory() {
  const d = await api('/api/memory/users?limit=40');
  if (!d.ok) return;
  $('memList').innerHTML = d.users.map((u) => `
    <button class="mem-item ${u.name === activeMemUser ? 'active' : ''}" data-user="${esc(u.name)}">
      <b>${esc(u.name)}</b>
      <span>${u.msg_count} 条 · ${u.fact_count} 条记忆</span>
    </button>`).join('') || '<p class="muted">还没有观众说话，先发一条测试弹幕。</p>';
  $('memList').querySelectorAll('.mem-item').forEach((b) => {
    b.onclick = () => showUser(b.dataset.user);
  });
  if (activeMemUser) showUser(activeMemUser, true);
}

// 舞台上鲸鱼此刻在做什么（礼物动作 → 中文名 + 动图 + 特效）
function renderLiveAction(a) {
  const el = $('sAction');
  if (!el) return;
  const fresh = a && a.id && a.name && a.at && (Date.now() / 1000 - a.at < 12);
  if (!fresh) {
    el.textContent = '待机';
    el.className = 'state-pill ghost';
    el.title = '';
    return;
  }
  const gifName = (actionCatalog.find((x) => x.action === a.name) || {}).gif || '';
  const ready = giftGifStatus && (giftGifStatus.files || []).includes(gifName);
  el.textContent = '动作：' + actionLabel(a.name) + (ready ? '' : '（等 GIF）');
  el.className = 'state-pill';
  el.title = [a.user && '送礼：' + a.user,
              a.gift && a.gift + (a.count > 1 ? '×' + a.count : ''),
              gifName && '动图：' + gifName,
              a.fx && '特效：' + a.fx].filter(Boolean).join(' · ');
}

async function showUser(name, silent) {
  activeMemUser = name;
  document.querySelectorAll('.mem-item').forEach((b) =>
    b.classList.toggle('active', b.dataset.user === name));
  const d = await api('/api/memory/user?name=' + encodeURIComponent(name));
  if (!d.ok) return;
  const p = d.profile || {};
  const facts = (d.facts || []).map((f) => `
    <div class="fact"><span>${esc(f.text)}</span>
      <button class="del" data-fact="${f.id}" title="忘掉这条">✕</button></div>`).join('')
    || '<p class="muted">还没有长期事实。让她自我介绍一句，例如「我叫小林，我在准备考研」。</p>';
  const turns = (d.turns || []).map((t) => `
    <div class="turn"><b>${t.role === 'user' ? esc(name) : '鲸宝'}</b>：${esc(t.content)}</div>`).join('');
  $('memDetail').innerHTML = `
    <h4>${esc(name)}</h4>
    <div class="kv">
      <span>互动 ${p.msg_count || 0} 次</span>
      <span>礼物流水 ¥${Number(p.gift_value || 0).toFixed(1)}</span>
      <span>好感 ${Number(p.affinity || 0).toFixed(0)}</span>
      <span>首次 ${esc((p.first_seen || '').slice(0, 16))}</span>
    </div>
    <h4 style="font-size:13px">长期事实</h4>${facts}
    <h4 style="font-size:13px;margin-top:14px">最近对话</h4>${turns || '<p class="muted">暂无</p>'}
    <div class="row"><button class="btn danger small" data-forget="${esc(name)}">清空这位观众的记忆</button></div>`;
  $('memDetail').querySelectorAll('[data-fact]').forEach((b) => {
    b.onclick = async () => { await api('/api/memory/forget', { fact_id: Number(b.dataset.fact) }); showUser(name); };
  });
  const fg = $('memDetail').querySelector('[data-forget]');
  if (fg) fg.onclick = async () => {
    if (!confirm('确定清空 ' + name + ' 的全部记忆？')) return;
    await api('/api/memory/forget', { user: name });
    activeMemUser = '';
    loadMemory();
    $('memDetail').innerHTML = '<p class="muted">已清空。</p>';
  };
  if (!silent) poll();
}
$('refreshMem').onclick = loadMemory;

// ---------------- 礼物点歌 ----------------
let songCfgReady = false;

function renderSongStatus(st) {
  if (!st) return;
  const cur = st.current;
  $('songNow').innerHTML = cur
    ? `<span class="playing-dot"></span>正在播放：<b>《${esc(cur.title)}》</b>
       <span class="muted">${esc(cur.artist)} · ${cur.duration}s · 点歌人 ${esc(cur.user)}${cur.gift ? ' · ' + esc(cur.gift) : ''}</span>`
    : '<span class="muted">当前没有在放歌</span>';
  $('songNow').classList.toggle('live', !!cur);
  $('songQueueLen').textContent = st.queue_len ?? 0;
  $('songQueue').innerHTML = (st.queue || []).map((q, i) => `
    <div class="queue-item"><span class="idx">${i + 1}</span><b>《${esc(q.title)}》</b>
      <span class="muted">${esc(q.user)}${q.gift ? ' · ' + esc(q.gift) : ''}${q.priority > 1 ? ' · 礼物点歌' : ''}</span></div>`
  ).join('') || '<p class="muted">队列空的。</p>';
}

async function loadSongs() {
  const d = await api('/api/song/library');
  if (!d.ok) return;
  const st = d.status || {};
  if (!songCfgReady) {
    songCfgReady = true;
    $('songEnable').value = st.enabled === false ? '0' : '1';
    $('songThreshold').value = st.gift_min_value ?? 0.5;
    $('songVolume').value = st.volume ?? 0.55;
    $('songVolumeHint').textContent = Math.round((st.volume ?? 0.55) * 100) + '%（鲸宝说话时自动压低）';
    $('songAuto').value = st.auto_next === false ? '0' : '1';
    if ($('songAutoDj')) $('songAutoDj').value = st.auto_dj === false ? '0' : '1';
    const on = st.online || {};
    if ($('songOnline')) $('songOnline').value = on.online === false ? '0' : '1';
    if ($('songSource')) $('songSource').value = on.source || 'netease';
    if ($('songBr')) $('songBr').value = String(on.br || 320);
    if ($('songCache')) $('songCache').value = '1';
  }
  $('songLibLen').textContent = (d.songs || []).length;
  $('songLib').innerHTML = (d.songs || []).map((s) => `
    <button class="song-item" data-song="${esc(s.title)}">
      <b>《${esc(s.title)}》</b>
      <span>${esc(s.artist)} · ${s.duration}s${s.tags && s.tags.length ? ' · ' + esc(s.tags.join(' / ')) : ''}</span>
    </button>`).join('')
    || '<p class="muted">曲库为空：把 mp3/wav 放进 songs/ 目录，或在 songs/songs.json 写标题。</p>';
  $('songLib').querySelectorAll('[data-song]').forEach((b) => {
    b.onclick = () => { $('songQuery').value = b.dataset.song; $('songRequest').click(); };
  });
  renderSongStatus(st);
}

$('songVolume').addEventListener('input', () => {
  $('songVolumeHint').textContent = Math.round($('songVolume').value * 100) + '%（鲸宝说话时自动压低）';
});
$('songSave').onclick = async () => {
  const d = await api('/api/config', {
    songs: {
      enable: $('songEnable').value === '1',
      gift_min_value: Number($('songThreshold').value) || 0,
      volume: Number($('songVolume').value),
      auto_next: $('songAuto').value === '1',
      auto_dj: $('songAutoDj') ? $('songAutoDj').value === '1' : true,
      auto_dj_keep: $('songAutoDj') ? $('songAutoDj').value === '1' : true,
      online: $('songOnline').value === '1',
      source: $('songSource').value,
      br: Number($('songBr').value) || 320,
      cache_download: $('songCache').value === '1',
    },
  });
  flash(d.ok ? '✓ 点歌设置已保存' : '保存失败', d.ok);
  songCfgReady = false;
  loadSongs();
};

// ---------------- 在线搜歌 ----------------
async function onlineSearch(byWord) {
  const q = byWord ? '' : $('onlineQuery').value.trim();
  const box = $('onlineHits');
  box.innerHTML = '<p class="muted">搜索中…</p>';
  const url = byWord ? '/api/music/hot' : '/api/music/search?q=' + encodeURIComponent(q);
  const d = await api(url);
  const hits = (d && d.hits) || [];
  $('onlineCount').textContent = hits.length;
  if (!hits.length) {
    box.innerHTML = '<p class="muted">没搜到。换个关键词，或检查网络 / 换一个音乐源。</p>';
    return;
  }
  box.innerHTML = hits.map((h, i) => `
    <button class="song-item" data-hit="${i}">
      <b>《${esc(h.name)}》</b>
      <span>${esc(h.artist)} · ${esc(h.source_name || h.source)}</span>
    </button>`).join('');
  box.querySelectorAll('[data-hit]').forEach((b) => {
    b.onclick = async () => {
      const hit = hits[Number(b.dataset.hit)];
      flash('正在入队《' + hit.name + '》…', true);
      const r = await api('/api/song/request', {
        user: $('songUser').value || '测试观众',
        query: hit.name + ' ' + (hit.artist || ''),
      });
      if (!r.ok) return flash('点歌失败：' + (r.error || ''), false);
      renderSongStatus(r.status);
      flash('✓ 已入队《' + r.song.title + '》', true);
    };
  });
}
if ($('onlineSearch')) $('onlineSearch').onclick = () => onlineSearch(false);
if ($('onlineHot')) $('onlineHot').onclick = () => onlineSearch(true);
if ($('onlineClear')) $('onlineClear').onclick = async () => {
  const d = await api('/api/music/cache', {});
  flash(d.ok ? `已清空搜索缓存（${d.cleared} 条），再搜一次就行` : '清缓存失败', !!d.ok);
};
$('songRequest').onclick = async () => {  const d = await api('/api/song/request', {
    user: $('songUser').value || '测试观众',
    query: $('songQuery').value.trim(),
  });
  if (!d.ok) return flash('点歌失败：' + (d.error || ''), false);
  flash(d.matched ? `✓ 已入队《${d.song.title}》` : `✓ 没匹配到，随机放了《${d.song.title}》`, true);
  renderSongStatus(d.status);
};
$('songSkip').onclick = async () => {
  const d = await api('/api/song/skip', {});
  renderSongStatus(d.status);
  flash(d.next ? `✓ 已跳到《${d.next.title}》` : '✓ 已跳过，队列空', true);
};
$('songStop').onclick = async () => {
  const d = await api('/api/song/stop', {});
  renderSongStatus(d.status);
  flash('✓ 已停止并清空队列', true);
};

// ---------------- 礼物图鉴 ----------------
let giftBookCache = [];

function gbIconHtml(g) {
  if (g.icon) {
    return `<img src="${esc(g.icon)}" alt="${esc(g.name)}" loading="lazy"
             onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
            <span class="gb-ico" style="display:none">🎁</span>`;
  }
  return '<span class="gb-ico">🎁</span>';
}

function gbCny(v) {
  const n = Number(v) || 0;
  if (n >= 10000) return '¥' + (n / 10000).toFixed(1) + 'w';
  if (n >= 100) return '¥' + n.toFixed(0);
  return '¥' + n.toFixed(n >= 1 ? 1 : 2).replace(/\.0+$/, '');
}

async function loadGiftBook() {
  const q = ($('gbQuery') && $('gbQuery').value.trim()) || '';
  const d = await api('/api/gifts/table' + (q ? '?q=' + encodeURIComponent(q) : ''));
  if (!d || !d.ok) return;
  giftBookCache = d.gifts || [];
  const sum = d.summary || {};
  const box = $('gbRows');
  if (!box) return;
  box.innerHTML = giftBookCache.map((g, i) => `
    <div class="gb-row" data-i="${i}">
      <div>${gbIconHtml(g)}</div>
      <div class="gb-name" title="${esc(g.name)}${g.describe ? ' · ' + esc(g.describe) : ''}">
        ${esc(g.name)}${g.learned ? ' <span class="ga-tag ok" style="font-size:9px">新</span>' : ''}</div>
      <div class="gb-num">${g.diamond || '—'}${g.diamond ? ' <span class="muted">抖币</span>' : ''}</div>
      <div class="gb-num">${g.diamond ? gbCny(g.cny) : '—'}</div>
      <div class="gb-act${g.action ? '' : ' none'}">${esc(g.action_label || (g.action ? g.action : '未命中规则'))}</div>
      <div class="gb-gif">${esc(g.action_gif || '—')} · ${g.hold || 6}s</div>
      <div><button class="btn ghost gb-send">试送</button></div>
    </div>`).join('') || '<p class="muted">没找到匹配的礼物</p>';

  box.querySelectorAll('.gb-row').forEach((row) => {
    const g = giftBookCache[Number(row.dataset.i)];
    const btn = row.querySelector('.gb-send');
    if (!g || !btn) return;
    btn.onclick = async () => {
      btn.disabled = true;
      try {
        await api('/api/event', {
          kind: 'gift',
          username: ($('userInput') && $('userInput').value) || '测试观众',
          gift: g.name,
          count: 1,
          value: g.cny || 0,
        });
        flash(`已模拟送出「${g.name}」→ ${g.action_label || '无动作'}`, true);
        setTimeout(poll, 700);
      } finally {
        btn.disabled = false;
      }
    };
  });

  const s = $('gbSummary');
  if (s) {
    s.innerHTML = q
      ? `搜索「${esc(q)}」找到 <span>${giftBookCache.length}</span> 个礼物`
      : `共 <span>${sum.total || 0}</span> 个礼物 · 有图标 <span>${sum.with_icon || 0}</span> 个`
        + ` · 运行期新学到 <span>${sum.learned || 0}</span> 个`;
  }
}

// ---------------- 礼物动作 ----------------
let gbTimer = null;
if ($('gbRefresh')) $('gbRefresh').onclick = () => loadGiftBook();
if ($('gbQuery')) {
  $('gbQuery').addEventListener('input', () => {
    clearTimeout(gbTimer);
    gbTimer = setTimeout(loadGiftBook, 280);
  });
  $('gbQuery').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { clearTimeout(gbTimer); loadGiftBook(); }
  });
}

let actionCatalog = [];
let giftGifStatus = null;
let giftFallback = {};
let giftAvailable = [];
let giftDefaultHold = 6;

// 哪些礼物关键词会命中哪个动作（从当前规则里反推，给对照表用）
function giftKeywordsByAction(rules) {
  const map = {};
  (rules || []).forEach((r) => {
    const act = r.action || 'bow';
    const list = Array.isArray(r.match) ? r.match : (r.match ? [r.match] : []);
    map[act] = map[act] || [];
    list.forEach((m) => {
      if (!m || m === '*' || m === 'default' || m === '默认') return;
      if (!map[act].includes(m)) map[act].push(m);
    });
    if (r.over) map[act].push('≥¥' + r.over);
  });
  return map;
}

function renderGiftCards(d) {
  const box = $('gaCards');
  if (!box) return;
  const catalog = d.catalog || [];
  const rules = (d.settings && Array.isArray(d.settings.rules) && d.settings.rules.length)
    ? d.settings.rules : (d.rules || []);
  const byAction = giftKeywordsByAction(rules);
  const gifs = d.gifs || {};
  giftFallback = d.fallback || {};
  giftGifStatus = gifs;
  giftAvailable = d.available_gifs || [];
  giftDefaultHold = Number(d.default_hold || 6);
  // 「文件是否存在」要看磁盘上实际有的（gifs.files），不是各动作当前在用的那张
  const readySet = new Set(gifs.files || []);
  const usedGifs = new Set(catalog.filter((a) => byAction[a.action]).map((a) => a.gif));
  const overrideNames = new Set(Object.keys((d.settings && d.settings.actions) || {}));

  const gifOptions = (cur) => {
    const opts = [`<option value=""${cur ? '' : ' selected'}>默认（内置）</option>`];
    const names = giftAvailable.map((g) => g.name);
    if (cur && !names.includes(cur)) names.unshift(cur);   // 配了但文件不在，也让它显示出来
    names.forEach((n) => {
      const ready = readySet.has(n);
      opts.push(`<option value="${esc(n)}"${n === cur ? ' selected' : ''}>${esc(n)}${ready ? '' : '（缺文件）'}</option>`);
    });
    return opts.join('');
  };

  box.innerHTML = catalog.map((a) => {
    const used = !!byAction[a.action];
    const ready = readySet.has(a.gif);
    const fb = giftFallback[a.gif];
    const overridden = overrideNames.has(a.action);
    const tags = [];
    if (used) {
      const kw = (byAction[a.action] || []).slice(0, 3).join('、');
      tags.push(`<span class="ga-tag">${esc(kw)}${(byAction[a.action] || []).length > 3 ? '…' : ''}</span>`);
    }
    tags.push(`<span class="ga-tag">${esc(a.fx_label || a.fx || '无特效')}</span>`);
    tags.push(ready
      ? '<span class="ga-tag ok">素材就绪</span>'
      : `<span class="ga-tag warn">缺文件${fb ? ' · 先播 ' + esc(fb) : ''}</span>`);
    if (overridden) tags.push('<span class="ga-tag ok">已自定义</span>');
    return `<div class="ga-card${used ? '' : ' ga-off'}" data-action="${esc(a.action)}">
      <div class="ga-t"><b>${esc(a.label || a.action)}</b><em>${esc(a.action)}</em></div>
      <div class="ga-d">${esc(a.desc || '')}</div>
      <label class="ga-f">动图
        <select class="ga-gif">${gifOptions(a.gif && a.gif !== a.default_gif ? a.gif : '')}
        </select>
      </label>
      <label class="ga-f">停留
        <input class="ga-hold" type="number" min="1" max="60" step="0.5" value="${esc(a.hold)}">
        <span class="ga-unit">秒</span>
      </label>
      <div class="ga-meta">${tags.join('')}</div>
      <div class="ga-act">
        <button class="btn small ga-save">保存</button>
        <button class="btn ghost small ga-reset" title="恢复内置默认">恢复默认</button>
      </div>
    </div>`;
  }).join('') || '<p class="muted">读不到动作清单</p>';

  box.querySelectorAll('.ga-card').forEach((card) => {
    const action = card.dataset.action;
    const saveBtn = card.querySelector('.ga-save');
    const resetBtn = card.querySelector('.ga-reset');
    if (saveBtn) {
      saveBtn.onclick = async () => {
        const gif = card.querySelector('.ga-gif').value;
        const hold = Number(card.querySelector('.ga-hold').value);
        saveBtn.disabled = true;
        try {
          const r = await api('/api/gift/action', { action, gif, hold });
          if (r && r.ok) {
            flash(`✓ ${actionLabel(action)}：动图 ${gif || '默认'} · 停留 ${hold} 秒`, true);
            await refreshGiftCatalog();
          } else {
            flash('保存失败：' + ((r && r.error) || ''), false);
          }
        } finally {
          saveBtn.disabled = false;
        }
      };
    }
    if (resetBtn) {
      resetBtn.onclick = async () => {
        const r = await api('/api/gift/action/reset', { action });
        if (r && r.ok) {
          flash(`✓ ${actionLabel(action)} 已恢复内置默认`, true);
          await refreshGiftCatalog();
        }
      };
    }
  });

  const missing = catalog.filter((a) => usedGifs.has(a.gif) && !readySet.has(a.gif));
  const sum = $('gaGifSummary');
  if (sum) {
    sum.textContent = missing.length
      ? `${catalog.length} 个动作，${missing.length} 个缺素材：${missing.map((a) => a.label).join('、')}`
      : `${catalog.length} 个动作，素材全部就绪`;
  }
  const hon = $('gaHonorifics');
  if (hon) hon.textContent = (d.honorifics || []).join(' / ');
}

// 只刷动作清单，不动规则编辑器（免得把用户正在改的规则冲掉）
async function refreshGiftCatalog() {
  const d = await api('/api/gift/catalog');
  if (!d || !d.ok) return;
  actionCatalog = d.catalog || [];
  renderGiftCards(d);
}

function splitMatch(text) {
  return String(text || '')
    .split(/[,，、/|;；]+/).map((s) => s.trim()).filter(Boolean);
}

function giftRow(rule) {
  rule = rule || {};
  const matches = Array.isArray(rule.match) ? rule.match.join('，') : (rule.match || '');
  const opts = actionCatalog.map((a) =>
    `<option value="${esc(a.action)}"${a.action === (rule.action || 'bow') ? ' selected' : ''}>${esc(a.label || a.action)}</option>`).join('');
  const allLines = Array.isArray(rule.lines) ? rule.lines : (rule.line ? [rule.line] : []);
  const line = allLines[0] || '';
  const div = document.createElement('div');
  div.className = 'ga-row';
  // 原始规则留一份：over / fx / emotion / gif / 多条 lines 这些编辑框里没有的字段，
  // 保存时必须原样带回去，否则「≥¥100 躺沙发」会退化成 * 兜底，把后面所有规则截胡。
  div._rule = JSON.parse(JSON.stringify(rule));
  div.innerHTML = `
    <input class="ga-match" value="${esc(matches)}" placeholder="小星星，星星">
    <select class="ga-action">${opts}</select>
    <input class="ga-line" value="${esc(line)}" placeholder="谢谢{user}的{gift}，本鲸转三圈！">
    <button class="ga-del" title="删除这条">×</button>`;
  if (rule.over) div.querySelector('.ga-match').title = `价值 ≥ ¥${rule.over} 才命中`;
  div.querySelector('.ga-del').onclick = () => {
    div.remove();
    $('gaRuleLen').textContent = $('gaRules').children.length;
  };
  $('gaRules').appendChild(div);
  $('gaRuleLen').textContent = $('gaRules').children.length;
  return div;
}

function readGiftRules() {
  return Array.from($('gaRules').children).map((row) => {
    const match = splitMatch(row.querySelector('.ga-match').value);
    const action = row.querySelector('.ga-action').value;
    const line = row.querySelector('.ga-line').value.trim();
    // 以原始规则为基底，只覆盖用户真正改过的三个字段
    const rule = Object.assign({}, row._rule || {});
    rule.match = match.length ? match : ['*'];
    rule.action = action;
    const oldLines = Array.isArray(rule.lines) ? rule.lines : [];
    if (line) {
      rule.line = line;
      if (oldLines.length > 1 && oldLines[0] === line) {
        // 用户没动台词，保留多套备选
        delete rule.line;
        rule.lines = oldLines;
      } else {
        delete rule.lines;      // 改过就只留这一条，别让旧台词盖回去
      }
    } else {
      delete rule.line;
      delete rule.lines;
    }
    return rule;
  });
}

// 用真实配置算一遍：某个礼物会命中什么动作、读什么台词
async function giftPreviewHint() {
  const el = $('giftActionHint');
  if (!el || !$('giftSelect')) return;
  const gift = $('giftSelect').value;
  try {
    const d = await api('/api/gift/test?gift=' + encodeURIComponent(gift) + '&value=1');
    const a = (d && d.action) || {};
    el.textContent = a.action ? `→ 鲸鱼会：${actionLabel(a.action)}` : '';
  } catch (e) {
    el.textContent = '';
  }
}

async function loadGift() {
  const d = await api('/api/gift/catalog');
  if (!d.ok) return;
  actionCatalog = d.catalog || [];
  renderGiftCards(d);
  const st = d.settings || {};
  $('gaEnable').value = st.enable === false ? '0' : '1';
  $('gaCooldown').value = st.cooldown ?? 0.5;
  if ($('gaDefaultHold')) $('gaDefaultHold').value = Number(d.default_hold || 6);
  $('gaRules').innerHTML = '';
  const active = (d.settings && Array.isArray(d.settings.rules) && d.settings.rules.length)
    ? d.settings.rules : (d.rules || []);
  active.forEach((r) => giftRow(r));
  if (!active.length) giftRow({ match: ['*'], action: 'bow', line: '谢谢{user}的{gift}！' });
}

$('gaAdd').onclick = () => giftRow({ match: [], action: 'dance' });$('gaDefaults').onclick = async () => {
  const d = await api('/api/gift/catalog');
  const defaults = d.defaults || [];
  $('gaRules').innerHTML = '';
  defaults.forEach((r) => giftRow(r));
  flash('已载入内置默认规则，改完记得保存', true);
};
$('gaSave').onclick = async () => {
  const rules = readGiftRules();
  const d = await api('/api/config', {
    gift_actions: {
      enable: $('gaEnable').value === '1',
      cooldown: Number($('gaCooldown').value) || 0,
      default_hold: Number($('gaDefaultHold').value) || giftDefaultHold,
      rules,
    },
  });
  flash(d.ok ? `✓ 已保存 ${rules.length} 条礼物动作` : '保存失败', d.ok);
  loadGift();       // 重新拉一遍，对照表跟着更新
};
$('gaTest').onclick = async () => {
  const gift = encodeURIComponent($('gaTestGift').value.trim() || '小星星');
  const value = Number($('gaTestValue').value) || 0;
  const d = await api('/api/gift/test?gift=' + gift + '&value=' + value);
  const a = d.action || {};
  $('gaResult').innerHTML = d.ok
    ? (a.action
      ? `命中规则 <b>${esc(a.rule || a.action)}</b> → 动作 <b>${esc(a.action)}</b> · 特效 <b>${esc(a.fx || '无')}</b><br>
         台词：${esc(d.line || '（这条规则没写台词，用通用答谢）')}`
      : '没命中任何规则（礼物动作可能被关掉了）。')
    : '测试失败：' + esc(d.error || '');
};

// ---------------- 局域网访问 ----------------
let netBusy = false;

async function loadNetwork(refresh) {
  const d = await api('/api/network' + (refresh ? '?refresh=1' : ''));
  const net = (d && d.network) || null;
  if (!net) {
    $('netPill').textContent = '不可用';
    $('netRows').innerHTML = '<p class="muted">读不到网络状态</p>';
    return;
  }
  const fwOk = !!net.firewall_ok;
  $('netPill').textContent = fwOk ? '已开放' : '仅本机/待放行';
  $('netPill').className = 'pill' + (fwOk ? ' live' : '');
  const rows = [];
  rows.push(`<div class="net-row"><b>本机</b><code>${esc(net.local_url)}</code>
    <span class="muted">舞台 ${esc(net.local_stage)}</span></div>`);
  const ips = net.ips || [];
  const adapters = net.adapters || ips.map((ip, i) => ({ name: i === 0 ? '局域网' : '网卡', ip }));
  if (!adapters.length) {
    rows.push('<div class="net-row"><b>局域网</b><span class="muted">没找到可用网卡</span></div>');
  }
  adapters.forEach((a, i) => {
    const url = `http://${a.ip}:${net.port}/`;
    rows.push(`<div class="net-row"><b>${i === 0 ? '局域网' : esc(a.name)}</b>
      <code>${esc(url)}</code>
      <span class="muted">${esc(a.name)} · 舞台 /stage</span>
      <button class="btn ghost small" data-copy="${esc(url)}">复制</button></div>`);
  });
  rows.push(`<div class="net-row"><b>监听</b><span class="muted">${esc(net.host)}:${net.port} ·
    防火墙 ${fwOk ? '已放行 TCP ' + net.port : '未放行（局域网设备可能连不上）'}</span></div>`);
  $('netRows').innerHTML = rows.join('');
  $('netRows').querySelectorAll('[data-copy]').forEach((b) => {
    b.onclick = async () => {
      const text = b.dataset.copy;
      try {
        await navigator.clipboard.writeText(text);
        flash('✓ 已复制 ' + text, true);
      } catch (e) {
        flash('复制失败，手动选中就行：' + text, false);
      }
    };
  });
  if (!fwOk) {
    $('netTip').textContent = '防火墙还没放行 TCP ' + net.port +
      '：点「开放局域网」会弹一次管理员确认（UAC），点「是」就通了；也可以手动执行 netsh 命令。';
  } else {
    $('netTip').textContent = '同一 WiFi 的手机 / 另一台电脑打开上面的地址，就能看舞台或控制台。';
  }
}

$('netOpen').onclick = async () => {
  if (netBusy) return;
  netBusy = true;
  $('netOpen').disabled = true;
  try {
    const d = await api('/api/network/open', { elevate: true });
    flash(d.message || d.error || (d.ok ? '已发起放行' : '失败'), !!d.ok);
    let tries = 0;
    const tick = setInterval(async () => {
      tries += 1;
      const st = await api('/api/network?refresh=1');
      const ok = st && st.network && st.network.firewall_ok;
      if (ok || tries >= 5) {
        clearInterval(tick);
        netBusy = false;
        $('netOpen').disabled = false;
        loadNetwork(true);
        if (ok) flash('✓ 局域网已开放，手机可以直接访问了', true);
        else flash('还没生效：可能没点 UAC 的「是」，或需要手动执行 netsh', false);
      }
    }, 1500);
  } catch (e) {
    netBusy = false;
    $('netOpen').disabled = false;
    flash('失败：' + e, false);
  }
};
$('netRefresh').onclick = () => { loadNetwork(true); flash('已重新检测网络', true); };

// ---------------- 抖音 ----------------
function dyField(inputId, on) {
  const el = $(inputId);
  if (!el) return;
  el.style.display = on ? '' : 'none';
  const label = el.previousElementSibling;
  if (label && label.tagName === 'LABEL') label.style.display = on ? '' : 'none';
}

function syncDyMode() {
  const mode = $('dyMode').value;
  dyField('dyLive', mode === 'live');
  dyField('dyUrl', mode === 'bridge');
  dyField('dyRoom', mode !== 'off');
  const tips = {
    live: '直连抖音直播间：填开播中的直播间地址（App 分享的 v.douyin.com 短链也认），点「启动数据源」就开收。',
    bridge: 'bridge 需要你自己的弹幕监听程序在 8888 端口推 JSON。没有的话请把模式切到 live（直连抖音）。',
    webhook: 'webhook 不主动连：把事件 POST 到 /api/event 即可。',
    off: '已关闭数据源，只用「互动测试」手动造事件。',
  };
  $('dyModeTip').textContent = tips[mode] || '';
}
$('dyMode').onchange = syncDyMode;

function dyHint(dy) {
  const err = dy.last_error || '';
  if (dy.mode === 'live') {
    if (dy.state === 'error' && err) {
      if (/直播间地址|live_id/i.test(err)) return '先填直播间地址：https://live.douyin.com/房间号';
      if (/依赖|ModuleNotFound|mini_racer/i.test(err)) return err + ' → 执行 pip install -r requirements-douyin.txt';
      return '直连失败：' + err;
    }
    if (dy.state === 'connected' && (dy.messages || 0) === 0) {
      if ((dy.frames || 0) > 0) {
        return `连接活着（已收到 ${dy.frames} 个数据帧），但这段时间没有弹幕/礼物/进场。发一条弹幕试试。`;
      }
      return '刚连上，抖音还没推数据；等 5~10 秒或发一条弹幕试试。';
    }
    if (dy.state === 'connecting') {
      return '正在连接抖音直播间，首次要拿 ttwid / 算签名，大约 3~10 秒。';
    }
    return '';
  }
  if (dy.mode === 'bridge' && (dy.state === 'connecting' || dy.state === 'error')) {
    if (/10061|refused|拒绝/i.test(err)) {
      return 'bridge 模式在等 8888 端口的弹幕监听程序，现在没有。想直连抖音：把上面的模式改成 live，填直播间地址再启动。';
    }
    return '正在连弹幕桥，确认监听器已启动并监听 ' + (dy.url || 'ws://127.0.0.1:8888') + '。';
  }
  if (dy.state === 'connected' && (dy.messages || 0) === 0) {
    return '已连上但还没收到消息，等一条弹幕；若一直为 0，检查监听器推送格式。';
  }
  return '';
}

function renderDouyin(dy) {
  dy = dy || {};
  const gd = dy.gift_debug || null;
  let giftLine = '';
  if (gd) {
    const errs = (gd.errors && gd.errors.length) ? gd.errors.join(' / ') : '';
    const unknown = Object.keys(gd.unknown || {});
    const gm = Object.entries(gd.gift_methods || {}).map(([k, v]) => `${k}×${v}`).join('、');
    const recent = (gd.recent || []).slice(-6).map((f) => `${f.t} ${f.m.replace('Webcast', '')}`).join(' · ');
    giftLine = `<br>礼物消息 <b>${gd.raw || 0}</b> 条 → 已感谢 <b>${gd.ok || 0}</b> 组` +
      (gd.pending ? ` · 连击缓冲 ${gd.pending}` : '') +
      ` · 弹幕帧 <b>${gd.chat || 0}</b> · 最近帧 <b>${esc(gd.last_frame_at || '—')}</b>` +
      (gm ? `<br>带 Gift 的方法：<b>${esc(gm)}</b>` : '') +
      (recent ? `<br><span class="muted">最近收到的帧：${esc(recent)}</span>` : '') +
      (errs ? `<br><span style="color:#ff6b81">礼物解析异常：${esc(errs)}</span>` : '') +
      (unknown.length ? `<br><span class="muted">未处理的消息类型：${esc(unknown.join('、'))}</span>` : '');
    if (!gd.raw && (gd.chat || 0) > 0) {
      giftLine += `<br><span style="color:#ffb020">礼物帧一条都没到：弹幕帧正常，说明连接没问题——` +
        `确认礼物是送进<b>这个房间</b>（${esc(dy.live_id || dy.url || '')}），而不是别的直播间。</span>`;
    }
  }
  $('dyStatus').innerHTML = `
    模式 <b>${esc(dy.mode || 'off')}</b> · 状态 <b>${esc(dy.state || 'stopped')}</b><br>
    收到消息 <b>${dy.messages || 0}</b> 条 · 收到帧 <b>${dy.frames || 0}</b> · 重连 <b>${dy.reconnects || 0}</b> 次<br>
    地址 <b>${esc(dy.url || '—')}</b>${dy.last_message_at ? '<br>最近一条 <b>' + esc(dy.last_message_at) + '</b>' : ''}
    ${giftLine}
    ${dy.last_error ? '<br><span style="color:#ff6b81">最近错误：' + esc(dy.last_error) + '</span>' : ''}`;
  const hint = dyHint(dy);
  $('dyHint').textContent = hint;
  $('dyHint').style.color = hint ? '#ffb020' : '';
}
$('dyStart').onclick = async () => {
  const room = $('dyRoom').value.trim();
  const bridgeUrl = $('dyUrl').value.trim() || 'ws://127.0.0.1:8888';
  let mode = $('dyMode').value;
  let liveUrl = $('dyLive').value.trim() || (/douyin\.com\//.test(room) ? room : '');

  if (mode === 'live' && !liveUrl) {
    $('dyLive').focus();
    return flash('先填直播间地址，例如 https://live.douyin.com/123456789', false);
  }

  const launch = async (m, url) => {
    const cookie = $('dyCookie').value.trim();
    const douyin = { mode: m, live_url: liveUrl, bridge_url: bridgeUrl, room_id: room };
    if (cookie) douyin.cookie = cookie;      // 留空视为不改动已保存的 Cookie
    await api('/api/config', { douyin });
    return api('/api/douyin/start', { mode: m, url, room_id: room, cookie });
  };

  let url = mode === 'live' ? liveUrl : (mode === 'bridge' ? bridgeUrl : '');
  let d = await launch(mode, url);

  // bridge 没监听程序、但已经配过直播间 → 自动切 live 重试一次
  if (mode === 'bridge' && !d.ok && /10061|没有弹幕监听程序|refused|拒绝/i.test(d.status?.last_error || '')) {
    if (liveUrl) {
      mode = 'live';
      url = liveUrl;
      $('dyMode').value = 'live';
      syncDyMode();
      d = await launch(mode, url);
      flash(d.ok ? 'bridge 没有监听程序，已自动切到 live 直连' : '启动失败：' + (d.status?.last_error || ''), !!d.ok);
      return renderDouyin(d.status);
    }
  }

  renderDouyin(d.status);
  flash(d.ok ? '数据源已启动：' + mode : '启动失败：' + (d.status?.last_error || ''), !!d.ok);
};
$('dyStop').onclick = async () => {
  const d = await api('/api/douyin/stop', {});
  renderDouyin(d.status);
  flash('已停止', true);
};

// ---------------- 模型与语音 ----------------
function cfgPayload(extra) {
  return Object.assign({
    api_key: $('apiKey').value,
    base_url: $('baseUrl').value,
    model: $('model').value,
    voice: $('voice').value,
    rate: $('rate').value,
    pitch: $('pitch').value,
    gif_theme: $('gifTheme').value,
    persona: $('persona').value,
  }, extra || {});
}
function flash(text, ok) {
  $('cfgResult').textContent = text;
  $('cfgResult').className = 'cfg-result ' + (ok ? 'ok' : 'error');
}
$('saveCfg').onclick = async () => {
  const d = await api('/api/config', cfgPayload());
  if (d.ok) {
    const blank = !$('persona').value.trim();
    flash('✓ 配置已保存' + (blank ? '（人设：内置默认「打工大肥鲸」）' : ''), true);
    $('apiKey').value = '';
    cfgReady = false;
    if (d.settings) renderPersonaHint(d.settings);
  } else flash(d.error || '保存失败', false);
};
if ($('resetPersona')) {
  $('resetPersona').onclick = async () => {
    $('persona').value = '';
    const d = await api('/api/config', { clear_persona: true, persona: '' });
    if (d && d.ok) {
      flash('✓ 人设已恢复内置默认「打工大肥鲸」', true);
      if (d.settings) renderPersonaHint(d.settings);
      cfgReady = false;
    } else flash('恢复失败', false);
  };
}
$('testCfg').onclick = async () => {
  flash('正在连接模型…', true);
  $('testCfg').disabled = true;
  try {
    const d = await api('/api/config/test', {});
    flash(d.ok ? '✓ 连接成功：' + d.reply : '失败：' + d.error, d.ok);
  } finally { $('testCfg').disabled = false; }
};
$('previewTts').onclick = async () => {
  flash('正在合成试听…', true);
  const d = await api('/api/tts/preview', {
    voice: $('voice').value, rate: $('rate').value, pitch: $('pitch').value,
    text: '你好呀，我是大肥鲸，深海工位今天照常加班。',
  });
  if (!d.ok) return flash('合成失败：' + (d.error || ''), false);
  new Audio(d.audio_url).play();
  flash('✓ 正在试听（直播也用这个音色）', true);
};
$('clearKey').onclick = async () => {
  if (!confirm('清除本机保存的 API Key，切回本地话术？')) return;
  await api('/api/config', cfgPayload({ clear_key: true, api_key: '' }));
  $('apiKey').value = '';
  cfgReady = false;
  flash('已切回本地话术大脑（记忆仍然生效）', true);
};
['voice', 'rate', 'pitch'].forEach((id) => $(id).addEventListener('change', async () => {
  await api('/api/tts/settings', { voice: $('voice').value, rate: $('rate').value, pitch: $('pitch').value });
  flash('音色已应用到直播', true);
}));
$('gifTheme').addEventListener('change', async () => {
  await api('/api/config', { gif_theme: $('gifTheme').value });
  flash('动图素材已切换', true);
});

// ---------- 智能体工具 ----------
let toolCatalogReady = false;

function renderToolList(catalog) {
  if (toolCatalogReady || !catalog || !catalog.length) return;
  toolCatalogReady = true;
  $('toolList').innerHTML = catalog.map((t) =>
    `<div class="tool-item"><b>${t.name}</b><span>${t.desc}</span><em>试试：${t.example}</em></div>`).join('');
}

$('toolSave').onclick = async () => {
  const d = await api('/api/config', {
    tools: {
      enable: $('toolEnable').value === '1',
      default_city: $('toolCity').value.trim() || '北京',
    },
  });
  flash(d.ok ? '✓ 工具设置已保存' : '保存失败', d.ok);
};

$('toolTest').onclick = async () => {
  const q = $('toolQuery').value.trim();
  if (!q) return flash('先写一句，例如「杭州天气怎么样」', false);
  $('toolResult').textContent = '查询中…';
  const d = await api('/api/tool', { text: q });
  const r = (d && d.result) || {};
  $('toolResult').textContent = r.ok
    ? `${r.text}\n\n鲸宝会这么说：${r.speak}`
    : `没查到：${r.text || d.error || '未知错误'}`;
};

// ---------- 直播智能体（DSH Harness） ----------
function renderHarness(st) {
  if (!st) return;
  const state = st.ok ? '在线' : (st.available ? '待铺 profile' : '不可用');
  $('hxState').textContent = `智能体：${state}${st.enable ? '' : '（已关闭）'}`;
  const rows = [];
  if (st.ok) {
    rows.push(`profile ${st.profile} · 模型 ${st.model || '—'} · 超时 ${st.timeout || 20}s · 活跃会话 ${st.sessions || 0}`);
  } else {
    rows.push(st.reason || '先点「铺 / 刷新 profile」把本机 dsh 接上');
  }
  if (st.base_url) rows.push(`API：${st.base_url}`);
  if (st.bin) rows.push(`dsh：${st.bin}`);
  const lt = st.last_turn;
  if (lt && lt.elapsed) {
    const t = lt.tokens || {};
    rows.push(`上一轮 ${Number(lt.elapsed).toFixed(1)}s · token ${t.prompt_tokens || 0}+${t.completion_tokens || 0}`);
  }
  if (st.last_error) rows.push(`最近错误：${st.last_error}`);
  const ag = (window.__agentState || null);
  if (ag && ag.cooldown_left > 0) {
    rows.push(`⚠ 智能体熔断中，还剩 ${Math.ceil(ag.cooldown_left)} 秒（连续失败后自动退回快模型/本地话术）`);
  }
  $('hxInfo').textContent = rows.join('\n');
}

function hxFlash(text, ok) {
  $('hxResult').textContent = text;
  $('hxResult').className = 'cfg-result ' + (ok ? 'ok' : 'error');
}

function hxPayload() {
  return {
    enable: $('hxEnable').value === '1',
    question_only: $('hxQuestionOnly').value === '1',
    timeout: Math.max(5, Math.min(120, parseInt($('hxTimeout').value, 10) || 20)),
    max_chars: Math.max(20, Math.min(140, parseInt($('hxMaxChars').value, 10) || 70)),
    session: $('hxSession').value === '1',
    deep: $('hxDeep').value === '1',
    model: $('hxModel').value.trim(),
    base_url: $('hxBaseUrl').value.trim(),
    api_key_env: $('hxKeyEnv').value.trim() || 'BUDDYHUB_API_KEY',
    api_key: $('hxKey').value.trim(),
    dsh_bin: $('hxBin').value.trim(),
    style: parseInt($('hxStyle').value, 10) || 0,
    gift_thanks_agent: $('hxGiftAgent').value === '1',
    quirks: $('hxQuirks').value.split(/[,，、;；]+/).map((s) => s.trim()).filter(Boolean),
    persona_suffix: $('hxSuffix').value.trim(),
  };
}

$('hxSave').onclick = async () => {
  hxFlash('保存中…', true);
  const d = await api('/api/config', { harness: hxPayload() });
  if (!d.ok) return hxFlash('保存失败：' + (d.error || ''), false);
  $('hxKey').value = '';
  cfgReady = false;
  if (d.harness) renderHarness(d.harness);
  hxFlash('✓ 智能体设置已保存', true);
  poll();
};

$('hxSetup').onclick = async () => {
  hxFlash('正在铺 profile（首次会复制 headless 模板）…', true);
  $('hxSetup').disabled = true;
  try {
    const d = await api('/api/harness/setup', {});
    renderHarness(d.status);
    hxFlash(d.ok
      ? `✓ profile 就绪：${d.path}${d.wrote ? '（已按当前设置重写）' : '（无需改动）'}`
      : '失败：' + (d.reason || ''), !!d.ok);
  } finally { $('hxSetup').disabled = false; }
};

$('hxRefresh').onclick = async () => {
  const d = await api('/api/harness/status');
  if (d.status) renderHarness(d.status);
  hxFlash(d.status && d.status.ok ? '✓ 智能体在线' : '还不可用：' + ((d.status && d.status.reason) || ''), !!(d.status && d.status.ok));
};

$('hxReset').onclick = async () => {
  const d = await api('/api/harness/reset', {});
  if (d.status) renderHarness(d.status);
  hxFlash('会话已清空，下一条弹幕它会重新认识观众', true);
};

$('hxTest').onclick = async () => {
  const text = $('hxTestText').value.trim() || '鲸鱼为什么会喷水？';
  hxFlash('智能体思考中…（真实跑一轮，约 2~10 秒）', true);
  $('hxTest').disabled = true;
  try {
    const d = await api('/api/harness/test', { text, timeout: 45 });
    if (d.status) renderHarness(d.status);
    const facts = (d.facts && d.facts.length) ? `｜记下：${d.facts.join('；')}` : '';
    hxFlash(d.ok
      ? `✓ ${Number(d.elapsed || 0).toFixed(1)}s｜${d.reply}${facts}`
      : '智能体没回话：' + (d.error || ''), !!d.ok);
  } finally { $('hxTest').disabled = false; }
};

setInterval(poll, 900);
poll();
setInterval(() => { if (document.querySelector('.tab.active')?.dataset.tab === 'memory') loadMemory(); }, 6000);
if (document.getElementById('netRows')) loadNetwork(false);
// 启动时先拉一次动作清单：顶部的「鲸鱼此刻在做什么」需要中文名和动图状态
api('/api/gift/catalog').then((d) => {
  if (!d || !d.ok) return;
  actionCatalog = d.catalog || [];
  giftGifStatus = d.gifs || null;
  giftFallback = d.fallback || {};
  if ($('gaCards')) renderGiftCards(d);
  previewGiftAction();
}).catch(() => {});
