/**
 * dsh-live-pet — Client half.
 *
 * One settings page: 「直播宠物」. Everything is written through this bundle's
 * Host half (`/dsh-live-pet/config`), because the browser cannot POST to the
 * live project's 8790 origin (cross-origin) while the Host can.
 *
 *   pet  → the plugin's own config.json (mode, limits, TTS, idle chatter…)
 *   live → douyin / songs / gift_actions / voice, forwarded to the live project
 */
window.__ModuleLoader__.load({
  id: 'dsh-live-pet',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const PAGE_ID = 'live-pet'
    const VOICES = [
      'zh-CN-XiaoxiaoNeural',
      'zh-CN-XiaoyiNeural',
      'zh-CN-YunxiNeural',
      'zh-CN-YunjianNeural',
      'zh-CN-YunyangNeural',
      'zh-CN-liaoning-XiaobeiNeural',
      'zh-CN-shaanxi-XiaoniNeural',
    ]
    const MODES = [
      ['auto', '自动（能读弹幕就接管，否则镜像）'],
      ['takeover', '接管（插件自己回答每条弹幕）'],
      ['mirror', '镜像（只播直播服务自己的回复）'],
    ]
    const SOURCES = ['netease', 'tencent', 'kugou', 'kuwo', 'migu', 'douyin']
    const EMOTION_OPTIONS = [
      ['happy', '开心'],
      ['mischievous', '调皮'],
      ['crying', '大哭'],
      ['unhappy', '不开心'],
      ['eating', '吃饭'],
      ['cooking', '做饭'],
      ['coding', '敲电脑'],
      ['tv', '躺沙发看电视'],
      ['walking', '散步'],
    ]

    const styles = {
      wrap: { display: 'flex', flexDirection: 'column', gap: '18px', padding: '4px 2px 24px' },
      card: {
        border: '1px solid var(--dsw-alias-border-l1, #444)',
        borderRadius: '10px',
        padding: '14px 16px',
        background: 'var(--dsw-alias-bg-layer-1, #1c1c1c)',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
      },
      title: { fontSize: '14px', fontWeight: 600, color: 'var(--dsw-alias-label-primary, #eee)' },
      hint: { fontSize: '12px', lineHeight: '1.6', color: 'var(--dsw-alias-label-secondary, #999)' },
      row: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' },
      label: { width: '132px', flex: 'none', fontSize: '13px', color: 'var(--dsw-alias-label-primary, #eee)' },
      input: {
        flex: '1 1 220px',
        minWidth: '160px',
        padding: '5px 8px',
        fontSize: '13px',
        borderRadius: '6px',
        border: '1px solid var(--dsw-alias-border-l1, #444)',
        background: 'var(--dsw-alias-bg-layer-2, #262626)',
        color: 'var(--dsw-alias-label-primary, #eee)',
        fontFamily: 'inherit',
      },
      button: {
        padding: '5px 14px',
        fontSize: '13px',
        borderRadius: '6px',
        border: '1px solid var(--dsw-alias-border-l1, #444)',
        background: 'var(--dsw-alias-bg-layer-2, #262626)',
        color: 'var(--dsw-alias-label-primary, #eee)',
        cursor: 'pointer',
      },
      buttonPrimary: {
        padding: '5px 14px',
        fontSize: '13px',
        borderRadius: '6px',
        border: '1px solid var(--dsw-alias-brand-primary, #4d9fe0)',
        background: 'var(--dsw-alias-brand-primary, #4d9fe0)',
        color: '#fff',
        cursor: 'pointer',
      },
      ok: { fontSize: '12px', color: 'var(--dsw-alias-state-success-primary, #3fbf7f)' },
      err: { fontSize: '12px', color: 'var(--dsw-alias-state-error-primary, #e06c6c)' },
      area: {
        width: '100%',
        minHeight: '90px',
        padding: '8px',
        fontSize: '12px',
        fontFamily: 'ui-monospace, Consolas, monospace',
        borderRadius: '6px',
        border: '1px solid var(--dsw-alias-border-l1, #444)',
        background: 'var(--dsw-alias-bg-layer-2, #262626)',
        color: 'var(--dsw-alias-label-primary, #eee)',
      },
    }

    const get = (object, path) => {
      let node = object
      for (const key of path) {
        if (node === null || typeof node !== 'object') return undefined
        node = node[key]
      }
      return node
    }

    const setPath = (object, path, value) => {
      const clone = Array.isArray(object) ? object.slice() : { ...object }
      let node = clone
      for (let i = 0; i < path.length - 1; i += 1) {
        const key = path[i]
        node[key] = node[key] !== null && typeof node[key] === 'object' ? { ...node[key] } : {}
        node = node[key]
      }
      node[path[path.length - 1]] = value
      return clone
    }

    function Row(props) {
      return h('div', { style: styles.row },
        h('span', { style: styles.label }, props.label),
        props.children,
        props.hint ? h('span', { style: styles.hint }, props.hint) : null)
    }

    function Text(props) {
      return h('input', {
        style: styles.input,
        type: 'text',
        value: props.value === undefined || props.value === null ? '' : String(props.value),
        placeholder: props.placeholder || '',
        onChange: (event) => props.onChange(event.target.value),
      })
    }

    function Number(props) {
      return h('input', {
        style: { ...styles.input, flex: '0 0 110px', minWidth: '90px' },
        type: 'number',
        step: props.step || '1',
        value: props.value === undefined || props.value === null ? '' : String(props.value),
        onChange: (event) => props.onChange(event.target.value === '' ? '' : Number(event.target.value)),
      })
    }

    function Check(props) {
      return h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '13px', cursor: 'pointer' } },
        h('input', {
          type: 'checkbox',
          checked: props.value === true,
          onChange: (event) => props.onChange(event.target.checked),
        }),
        h('span', null, props.label))
    }

    function Select(props) {
      return h('select', {
        style: styles.input,
        value: props.value,
        onChange: (event) => props.onChange(event.target.value),
      }, props.options.map(([value, label]) => h('option', { key: value, value }, label)))
    }

    function Card(props) {
      return h('section', { style: styles.card },
        h('div', { style: styles.title }, props.title),
        props.hint ? h('div', { style: styles.hint }, props.hint) : null,
        props.children)
    }

    function LivePetSettings(props) {
      const [pet, setPet] = React.useState(null)
      const [live, setLive] = React.useState(null)
      const [liveOk, setLiveOk] = React.useState(false)
      const [petDraft, setPetDraft] = React.useState({})
      const [liveDraft, setLiveDraft] = React.useState(null)
      const [liveGroups, setLiveGroups] = React.useState([])
      const [actionsText, setActionsText] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [message, setMessage] = React.useState({ kind: '', text: '' })
      const [liveState, setLiveState] = React.useState(null)
      const [liveBusy, setLiveBusy] = React.useState(false)

      async function load() {
        try {
          const response = await fetch('/dsh-live-pet/config', { headers: { accept: 'application/json' } })
          const payload = await response.json()
          setPet(payload.pet || {})
          setPetDraft({})
          const settings = payload.live && payload.live.settings ? payload.live.settings : null
          setLive(settings)
          setLiveOk(Boolean(payload.live && payload.live.ok))
          setLiveDraft(settings ? JSON.parse(JSON.stringify(settings)) : null)
          setLiveGroups([])
          setActionsText(settings && settings.gift_actions && settings.gift_actions.actions
            ? JSON.stringify(settings.gift_actions.actions, null, 2)
            : '{}')
        } catch (error) {
          setMessage({ kind: 'err', text: '读取配置失败：' + (error && error.message ? error.message : error) })
        }
      }

      React.useEffect(() => { load() }, [])

      const petValue = (key) => (Object.prototype.hasOwnProperty.call(petDraft, key) ? petDraft[key] : pet ? pet[key] : '')
      const setPetValue = (key, value) => setPetDraft((draft) => ({ ...draft, [key]: value }))

      const liveValue = (path) => (liveDraft === null ? '' : get(liveDraft, path))
      const setLiveValue = (path, value, group) => {
        setLiveDraft((draft) => (draft === null ? draft : setPath(draft, path, value)))
        setLiveGroups((groups) => (groups.includes(group) ? groups : groups.concat([group])))
      }

      async function savePet() {
        setBusy(true)
        setMessage({ kind: '', text: '' })
        try {
          const response = await fetch('/dsh-live-pet/config', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ pet: petDraft }),
          })
          const payload = await response.json()
          if (payload.ok === true && payload.petSaved === true) {
            setPet(payload.pet || {})
            setPetDraft({})
            setMessage({ kind: 'ok', text: '宠物设置已保存并立即生效' })
          } else {
            setMessage({ kind: 'err', text: payload.error || '保存失败' })
          }
        } catch (error) {
          setMessage({ kind: 'err', text: '保存失败：' + (error && error.message ? error.message : error) })
        }
        setBusy(false)
      }

      async function saveLive() {
        if (liveDraft === null) return
        setBusy(true)
        setMessage({ kind: '', text: '' })
        const payloadLive = {}
        if (liveGroups.includes('douyin')) payloadLive.douyin = liveDraft.douyin
        if (liveGroups.includes('songs')) payloadLive.songs = liveDraft.songs
        if (liveGroups.includes('gift_actions')) {
          let parsed = {}
          try {
            parsed = actionsText.trim() === '' ? {} : JSON.parse(actionsText)
          } catch {
            setMessage({ kind: 'err', text: '礼物动作的 JSON 解析失败，先修好再保存' })
            setBusy(false)
            return
          }
          payloadLive.gift_actions = { ...liveDraft.gift_actions, actions: parsed }
        }
        if (liveGroups.includes('voice')) {
          payloadLive.voice = liveDraft.voice
          payloadLive.rate = liveDraft.rate
          payloadLive.pitch = liveDraft.pitch
        }
        try {
          const response = await fetch('/dsh-live-pet/config', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ live: payloadLive }),
          })
          const payload = await response.json()
          const settings = payload.live && payload.live.settings ? payload.live.settings : null
          if (settings !== null) {
            setLive(settings)
            setLiveDraft(JSON.parse(JSON.stringify(settings)))
            setLiveGroups([])
            setActionsText(settings.gift_actions && settings.gift_actions.actions
              ? JSON.stringify(settings.gift_actions.actions, null, 2)
              : '{}')
          }
          setLiveOk(Boolean(payload.live && payload.live.ok))
          if (payload.liveSaved === true) setMessage({ kind: 'ok', text: '直播设置已写入直播服务' })
          else setMessage({ kind: 'err', text: payload.liveError || '直播服务没有确认保存' })
        } catch (error) {
          setMessage({ kind: 'err', text: '保存失败：' + (error && error.message ? error.message : error) })
        }
        setBusy(false)
      }

      /** Managed-instance status + one-click start/stop. */
      async function refreshLive() {
        try {
          const response = await fetch('/dsh-live-pet/live', { headers: { accept: 'application/json' } })
          const payload = await response.json()
          if (payload && payload.status) setLiveState(payload.status)
        } catch {
          setLiveState(null)
        }
      }

      async function controlLive(action) {
        setLiveBusy(true)
        setMessage({ kind: '', text: '' })
        try {
          const response = await fetch('/dsh-live-pet/live', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action }),
          })
          const payload = await response.json()
          if (payload.status) setLiveState(payload.status)
          if (payload.ok === true) {
            setMessage({
              kind: 'ok',
              text: action === 'stop' ? '直播服务已停止' : `直播服务已就绪（${payload.status ? payload.status.base : ''}）`,
            })
          } else {
            setMessage({ kind: 'err', text: payload.error || '操作失败' })
          }
        } catch (error) {
          setMessage({ kind: 'err', text: '操作失败：' + (error && error.message ? error.message : error) })
        }
        setLiveBusy(false)
        await load()
      }

      React.useEffect(() => { refreshLive() }, [])

      if (pet === null) {
        return h('div', { style: styles.wrap }, h('div', { style: styles.hint }, '正在读取配置…'))
      }

      const runningNow = liveState !== null && liveState.running === true
      const managedNow = petValue('manageLive') === true

      return h('div', { style: styles.wrap },

        message.text === '' ? null : h('div', { style: message.kind === 'ok' ? styles.ok : styles.err }, message.text),

        h(Card, {
          title: '直播服务（插件托管）',
          hint: managedNow
            ? '插件自己起一个独立实例：自己的端口、自己的 settings.json / data / songs / logs，和原来那个 8790 完全分开。'
            : '托管已关闭：插件只连你手动启动的直播服务（下面的「服务地址」）。',
        },
          h(Row, { label: '一键托管' },
            h(Check, {
              label: '由插件启动和停止直播服务',
              value: managedNow,
              onChange: (v) => setPetValue('manageLive', v),
            }),
            h(Check, {
              label: '插件激活时自动启动',
              value: petValue('autoStartLive') === true,
              onChange: (v) => setPetValue('autoStartLive', v),
            })),
          h(Row, { label: '状态' },
            h('span', {
              style: runningNow ? styles.ok : styles.err,
            }, runningNow
              ? `运行中 · ${liveState ? liveState.base : ''}${liveState && liveState.pid ? ` · pid ${liveState.pid}` : ''}`
              : (liveState && liveState.error ? `未运行 · ${liveState.error}` : '未运行')),
            h('button', {
              style: styles.buttonPrimary,
              disabled: liveBusy || managedNow !== true || runningNow,
              onClick: () => controlLive('start'),
            }, '启动'),
            h('button', {
              style: styles.button,
              disabled: liveBusy || runningNow !== true,
              onClick: () => controlLive('stop'),
            }, '停止'),
            h('button', {
              style: styles.button,
              disabled: liveBusy || managedNow !== true,
              onClick: () => controlLive('restart'),
            }, '重启'),
            h('button', { style: styles.button, disabled: liveBusy, onClick: refreshLive }, '刷新状态')),
          h(Row, { label: '端口' },
            h(Number, { value: petValue('livePort'), onChange: (v) => setPetValue('livePort', v) }),
            h('span', { style: styles.hint }, `监听 ${petValue('liveHost') || '127.0.0.1'}；换端口后点「重启」`)),
          h(Row, { label: '弹幕来源' },
            h(Select, {
              value: petValue('liveMode') || 'live',
              options: [
                ['live', '抖音直连（用下面的直播间地址）'],
                ['bridge', '本机 WS 弹幕桥'],
                ['webhook', '外部 POST /api/event'],
                ['off', '不接弹幕'],
              ],
              onChange: (v) => setPetValue('liveMode', v),
            })),
          managedNow ? h(Row, { label: '数据目录' },
            h('span', { style: styles.hint },
              (liveState && liveState.baseDir) || '（保存后显示）')) : null,
          h('div', { style: styles.row },
            h('button', { style: styles.buttonPrimary, disabled: busy, onClick: savePet }, '保存托管设置'))),

        h(Card, {
          title: '直播内容',
          hint: liveOk
            ? '已连上直播服务；下面的改动会写回它自己的 settings.json。'
            : '直播服务还没起来（点上面「启动」），起来后这里就能改了。',
        },
          managedNow ? null : h(Row, { label: '服务地址' },
            h(Text, { value: petValue('appUrl'), onChange: (v) => setPetValue('appUrl', v) })),
          live === null ? null : h(Row, { label: '直播间地址' },
            h(Text, {
              value: liveValue(['douyin', 'live_url']),
              placeholder: 'https://live.douyin.com/123456789 或短链',
              onChange: (v) => setLiveValue(['douyin', 'live_url'], v, 'douyin'),
            })),
          live === null ? null : h(Row, { label: '直播标题' },
            h(Text, {
              value: liveValue(['douyin', 'title']),
              onChange: (v) => setLiveValue(['douyin', 'title'], v, 'douyin'),
            })),
          live === null ? null : h(Row, { label: '欢迎进场' },
            h(Check, {
              label: '有人进场就打招呼',
              value: liveValue(['douyin', 'welcome_enter']) === true,
              onChange: (v) => setLiveValue(['douyin', 'welcome_enter'], v, 'douyin'),
            }),
            h(Check, {
              label: '点赞答谢',
              value: liveValue(['douyin', 'welcome_like']) === true,
              onChange: (v) => setLiveValue(['douyin', 'welcome_like'], v, 'douyin'),
            })),
          h('div', { style: styles.row },
            h('button', { style: styles.buttonPrimary, disabled: busy, onClick: saveLive }, '保存直播设置'),
            h('button', { style: styles.button, disabled: busy, onClick: load }, '重新读取')),

          live === null ? null : h('div', { style: styles.hint },
            `服务端智能体：${live.harness && live.harness.enable ? '开（会和插件抢话，建议关）' : '关 ✓'} · ` +
            `冷场口播：${live.idle && live.idle.enable ? '开' : '关 ✓'} · ` +
            `自动口播：${live.promo && live.promo.enable ? '开' : '关 ✓'}`)),

        live === null ? null : h(Card, { title: '音色', hint: '两边的语音都用这一套（宠物的 TTS 会跟随这里的设置）。' },
          h(Row, { label: '音色' },
            h(Select, {
              value: liveValue(['voice']) || VOICES[0],
              options: VOICES.map((v) => [v, v]),
              onChange: (v) => setLiveValue(['voice'], v, 'voice'),
            })),
          h(Row, { label: '语速' },
            h(Text, { value: liveValue(['rate']), placeholder: '+4%', onChange: (v) => setLiveValue(['rate'], v, 'voice') })),
          h(Row, { label: '音调' },
            h(Text, { value: liveValue(['pitch']), placeholder: '+3Hz', onChange: (v) => setLiveValue(['pitch'], v, 'voice') })),
          h('div', { style: styles.row },
            h('button', { style: styles.buttonPrimary, disabled: busy, onClick: saveLive }, '保存音色'))),

        live === null ? null : h(Card, { title: '音乐 / 点歌' },
          h(Row, { label: '点歌' },
            h(Check, {
              label: '允许观众点歌',
              value: liveValue(['songs', 'enable']) === true,
              onChange: (v) => setLiveValue(['songs', 'enable'], v, 'songs'),
            }),
            h(Check, {
              label: '在线曲库',
              value: liveValue(['songs', 'online']) === true,
              onChange: (v) => setLiveValue(['songs', 'online'], v, 'songs'),
            })),
          h(Row, { label: '曲库源' },
            h(Select, {
              value: liveValue(['songs', 'source']) || 'netease',
              options: SOURCES.map((s) => [s, s]),
              onChange: (v) => setLiveValue(['songs', 'source'], v, 'songs'),
            })),
          h(Row, { label: '音量' },
            h(Number, {
              value: liveValue(['songs', 'volume']),
              step: '0.05',
              onChange: (v) => setLiveValue(['songs', 'volume'], v, 'songs'),
            })),
          h(Row, { label: '礼物点歌门槛' },
            h(Number, {
              value: liveValue(['songs', 'gift_min_value']),
              step: '0.1',
              onChange: (v) => setLiveValue(['songs', 'gift_min_value'], v, 'songs'),
            }),
            h('span', { style: styles.hint }, '元')),
          h(Row, { label: '切歌权限' },
            h(Check, {
              label: '允许小鲸鱼切歌',
              value: petValue('allowSkip') === true,
              onChange: (v) => setPetValue('allowSkip', v),
            }),
            h(Number, { value: petValue('skipCooldownSec'), onChange: (v) => setPetValue('skipCooldownSec', v) }),
            h('span', { style: styles.hint }, '秒内只能切一次（防观众刷切歌）')),
          h('div', { style: styles.row },
            h('button', { style: styles.buttonPrimary, disabled: busy, onClick: saveLive }, '保存音乐设置'),
            h('button', { style: styles.button, disabled: busy, onClick: savePet }, '保存切歌权限'))),

        live === null ? null : h(Card, { title: '礼物感谢动作' },
          h(Row, { label: '启用' },
            h(Check, {
              label: '收到礼物就做动作',
              value: liveValue(['gift_actions', 'enable']) === true,
              onChange: (v) => setLiveValue(['gift_actions', 'enable'], v, 'gift_actions'),
            })),
          h(Row, { label: '冷却（秒）' },
            h(Number, {
              value: liveValue(['gift_actions', 'cooldown']),
              step: '0.1',
              onChange: (v) => setLiveValue(['gift_actions', 'cooldown'], v, 'gift_actions'),
            })),
          h(Row, { label: '动作时长（秒）' },
            h(Number, {
              value: liveValue(['gift_actions', 'default_hold']),
              onChange: (v) => setLiveValue(['gift_actions', 'default_hold'], v, 'gift_actions'),
            })),
          h('div', { style: styles.hint }, '动作表（礼物名 → 动作/特效/台词），JSON；留 {} 用内置规则'),
          h('textarea', {
            style: styles.area,
            value: actionsText,
            spellCheck: false,
            onChange: (event) => {
              setActionsText(event.target.value)
              setLiveGroups((groups) => (groups.includes('gift_actions') ? groups : groups.concat(['gift_actions'])))
            },
          }),
          h('div', { style: styles.row },
            h('button', { style: styles.buttonPrimary, disabled: busy, onClick: saveLive }, '保存礼物动作'))),

        h(Card, { title: '宠物行为', hint: '这些只影响插件，不改直播服务。保存后立即生效。' },
          h(Row, { label: '对话模式' },
            h(Select, {
              value: petValue('mode'),
              options: MODES,
              onChange: (v) => setPetValue('mode', v),
            })),
          h(Row, { label: 'DSH profile' },
            h(Text, { value: petValue('profile'), onChange: (v) => setPetValue('profile', v) }),
            h('span', { style: styles.hint }, 'pet = 只读档（插件生成）')),
          h(Row, { label: '说话' },
            h(Check, { label: '合成语音', value: petValue('speak') === true, onChange: (v) => setPetValue('speak', v) }),
            h(Check, { label: '接受打字聊天', value: petValue('chatEnabled') === true, onChange: (v) => setPetValue('chatEnabled', v) })),
          h(Row, { label: '冷场热场' },
            h(Check, { label: '自己找话题', value: petValue('idleChat') === true, onChange: (v) => setPetValue('idleChat', v) }),
            h(Number, {
              value: petValue('idleEverySec'),
              onChange: (v) => setPetValue('idleEverySec', v),
            }),
            h('span', { style: styles.hint }, '秒没动静就说一句')),
          h(Row, { label: '欢迎进场' },
            h(Check, { label: '有人进来就招呼一句', value: petValue('welcomeEnter') === true, onChange: (v) => setPetValue('welcomeEnter', v) }),
            h(Number, { value: petValue('welcomeEnterGapSec'), onChange: (v) => setPetValue('welcomeEnterGapSec', v) }),
            h('span', { style: styles.hint }, '秒内最多一次 · 每小时上限 '),
            h(Number, { value: petValue('welcomeEnterPerHour'), onChange: (v) => setPetValue('welcomeEnterPerHour', v) }),
            h('span', { style: styles.hint }, '次 · 同一人 '),
            h(Number, { value: petValue('welcomeEnterUserGapSec'), onChange: (v) => setPetValue('welcomeEnterUserGapSec', v) }),
            h('span', { style: styles.hint }, '秒内不重复招呼')),
          h(Row, { label: '感谢礼物' },
            h(Check, { label: '收到礼物就道谢', value: petValue('thanksGift') === true, onChange: (v) => setPetValue('thanksGift', v) }),
            h(Number, { value: petValue('giftThanksGapSec'), onChange: (v) => setPetValue('giftThanksGapSec', v) }),
            h('span', { style: styles.hint }, '秒内最多谢一次 · 同一人 '),
            h(Number, { value: petValue('giftThanksUserGapSec'), onChange: (v) => setPetValue('giftThanksUserGapSec', v) }),
            h('span', { style: styles.hint }, '秒')),
          h(Row, { label: '情绪联动' },
            h('span', { style: styles.hint }, '查东西时 '),
            h(Select, {
              value: petValue('queryEmotion') || 'coding',
              options: EMOTION_OPTIONS,
              onChange: (v) => setPetValue('queryEmotion', v),
            }),
            h('span', { style: styles.hint }, '· 点歌时 '),
            h(Select, {
              value: petValue('songEmotion') || 'crying',
              options: EMOTION_OPTIONS,
              onChange: (v) => setPetValue('songEmotion', v),
            })),
          h(Row, { label: '礼物表情' },
            h(Select, {
              value: petValue('giftForcedEmotion') === undefined || petValue('giftForcedEmotion') === null ? 'tv' : String(petValue('giftForcedEmotion')),
              options: [['', '按礼物规则（分类）']].concat(EMOTION_OPTIONS),
              onChange: (v) => setPetValue('giftForcedEmotion', v),
            }),
            h('span', { style: styles.hint }, '持续 '),
            h(Number, { value: petValue('giftPoseSec'), onChange: (v) => setPetValue('giftPoseSec', v) }),
            h('span', { style: styles.hint }, '秒后回散步')),
          h(Row, { label: '弹幕回复字数' },
            h(Number, { value: petValue('maxChars'), onChange: (v) => setPetValue('maxChars', v) }),
            h('span', { style: styles.hint }, '老板打字的上限 '),
            h(Number, { value: petValue('chatMaxChars'), onChange: (v) => setPetValue('chatMaxChars', v) })),
          h(Row, { label: '限流' },
            h(Number, { value: petValue('maxPerMinute'), onChange: (v) => setPetValue('maxPerMinute', v) }),
            h('span', { style: styles.hint }, '条/分钟，间隔 '),
            h(Number, { value: petValue('minReplyGapMs'), onChange: (v) => setPetValue('minReplyGapMs', v) }),
            h('span', { style: styles.hint }, 'ms')),
          h(Row, { label: '动作' },
            h(Check, { label: '允许点歌/礼物动作', value: petValue('actions') === true, onChange: (v) => setPetValue('actions', v) }),
            h(Check, { label: '礼物特效转发给舞台', value: petValue('stageGiftFx') === true, onChange: (v) => setPetValue('stageGiftFx', v) })),
          h(Row, { label: '窗口' },
            h(Check, { label: '插件激活时自动开宠物窗口', value: petValue('autoStartPet') === true, onChange: (v) => setPetValue('autoStartPet', v) }),
            h(Check, { label: '静音启动', value: petValue('petSilent') === true, onChange: (v) => setPetValue('petSilent', v) })),
          h('div', { style: styles.row },
            h('button', { style: styles.buttonPrimary, disabled: busy, onClick: savePet }, '保存宠物设置'),
            props.close ? h('button', { style: styles.button, disabled: busy, onClick: props.close }, '关闭') : null)),

        h('div', { style: styles.hint },
          '提示：改完「直播服务」里的开关后，直播服务会把它写进自己的 settings.json；' +
          '插件的开关写在 F:\\douyinlive\\dsh-live-pet\\config.json。'))
    }

    const inject = ['slots']

    function apply(ctx) {
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: PAGE_ID,
        order: 60,
        label: () => '直播宠物',
      }, LivePetSettings))
    }

    return { inject, apply }
  },
})
