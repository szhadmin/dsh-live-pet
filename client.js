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

    function TextArea(props) {
      return h('textarea', {
        style: { ...styles.input, flex: '1 1 100%', minHeight: '120px', lineHeight: '1.6', padding: '8px 10px', resize: 'vertical' },
        value: props.value === undefined || props.value === null ? '' : props.value,
        placeholder: props.placeholder || '',
        rows: props.rows || 6,
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
      const [deps, setDeps] = React.useState(null)
      const [backgrounds, setBackgrounds] = React.useState([])
      const [depsBusy, setDepsBusy] = React.useState(false)
      const [poses, setPoses] = React.useState([])
      const [posesText, setPosesText] = React.useState('[]')
      const [skins, setSkins] = React.useState([])
      const [skinsBusy, setSkinsBusy] = React.useState(false)
      const [usage, setUsage] = React.useState(null)
      /** 配置文件的真实路径（「配置在哪」那张卡片上显示） */
      const [configFile, setConfigFile] = React.useState('')

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
          const custom = payload.pet && Array.isArray(payload.pet.posesCustom) ? payload.pet.posesCustom : []
          setPosesText(JSON.stringify(custom, null, 2))
          setConfigFile(typeof payload.configFile === 'string' ? payload.configFile : '')
          void refreshPoses()
          void refreshSkins()
          void refreshUsage()
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

      /* ---- 动作库：内置的从插件读，自定义的存在 posesCustom 里 ---- */
      async function refreshPoses() {
        try {
          const response = await fetch('/dsh-live-pet/poses', { headers: { accept: 'application/json' } })
          const payload = await response.json()
          setPoses(Array.isArray(payload.poses) ? payload.poses : [])
        } catch {
          setPoses([])
        }
      }

      /* ---- 形象包：换宠物长相 ---- */
      async function refreshSkins() {
        try {
          const response = await fetch('/dsh-live-pet/skins', { headers: { accept: 'application/json' } })
          const payload = await response.json()
          setSkins(Array.isArray(payload.skins) ? payload.skins : [])
        } catch {
          setSkins([])
        }
      }

      async function createSkin() {
        const name = window.prompt('形象叫什么？（会建一个文件夹，比如 小海豚）', '我的形象')
        if (!name) return
        setSkinsBusy(true)
        try {
          const response = await fetch('/dsh-live-pet/skins/create', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name }),
          })
          const payload = await response.json()
          if (payload.ok === true) {
            setMessage({ kind: 'ok', text: `已建好：${payload.dir}　把 happy.gif 之类的动图放进去，再点「刷新形象列表」` })
            await refreshSkins()
            await openSkinFolder(payload.dir)
          } else {
            setMessage({ kind: 'err', text: payload.error || '创建失败' })
          }
        } catch (error) {
          setMessage({ kind: 'err', text: '创建失败：' + (error && error.message ? error.message : error) })
        } finally {
          setSkinsBusy(false)
        }
      }

      async function openSkinFolder(dir) {
        try {
          await fetch('/dsh-live-pet/skins/open', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ dir: dir || '' }),
          })
        } catch (error) {
          setMessage({ kind: 'err', text: '打不开目录：' + (error && error.message ? error.message : error) })
        }
      }

      /* ---- token 用量 ---- */
      async function refreshUsage() {
        try {
          const response = await fetch('/dsh-live-pet/usage', { headers: { accept: 'application/json' } })
          const payload = await response.json()
          setUsage(payload.usage || null)
        } catch {
          setUsage(null)
        }
      }

      async function resetUsage() {
        try {
          await fetch('/dsh-live-pet/usage?reset=1', { headers: { accept: 'application/json' } })
          await refreshUsage()
          setMessage({ kind: 'ok', text: '用量统计已清零（只清统计，不影响宠物）' })
        } catch (error) {
          setMessage({ kind: 'err', text: '清零失败：' + (error && error.message ? error.message : error) })
        }
      }

      /** 一个设置项直接落盘（不经过「保存」按钮的那种快捷开关）。 */
      async function postPet(patch, okText) {
        setBusy(true)
        setMessage({ kind: '', text: '' })
        try {
          const response = await fetch('/dsh-live-pet/config', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ pet: patch }),
          })
          const payload = await response.json()
          if (payload.petSaved === true) {
            setPet(payload.pet || {})
            setMessage({ kind: 'ok', text: okText })
            return true
          }
          setMessage({ kind: 'err', text: payload.error || '保存失败' })
        } catch (error) {
          setMessage({ kind: 'err', text: '保存失败：' + (error && error.message ? error.message : error) })
        } finally {
          setBusy(false)
        }
        return false
      }

      /** 背景三态：全屏 / 最小化（只留宠物）/ 关闭。 */
      function applySceneMode(mode) {
        const patch = mode === 'off'
          ? { sceneEnabled: false, sceneMinimized: false }
          : mode === 'minimal'
            ? { sceneEnabled: true, sceneMinimized: true }
            : { sceneEnabled: true, sceneMinimized: false }
        const text = mode === 'off' ? '背景已关闭（宠物仍在桌面上）'
          : mode === 'minimal' ? '背景已最小化：只留宠物，OBS 里可以先把背景那路关掉'
            : '背景已全屏铺开'
        void postPet(patch, text)
      }

      async function savePoses() {
        let list
        try {
          list = posesText.trim() === '' ? [] : JSON.parse(posesText)
        } catch (error) {
          setMessage({ kind: 'err', text: '动作 JSON 语法错误：' + (error && error.message ? error.message : error) })
          return
        }
        if (!Array.isArray(list)) {
          setMessage({ kind: 'err', text: '动作必须是一个 JSON 数组，例如 [{"id":"jing","label":"敬个礼","emotion":"happy","sec":5,"fx":"squash"}]' })
          return
        }
        const saved = await postPet({ posesCustom: list }, `已保存 ${list.length} 个自定义动作，右键菜单里立刻能看到`)
        if (saved) void refreshPoses()
      }

      /* ---- 双智能体（连麦）：multiAgent 是嵌套对象，逐字段改 ---- */
      const teamValue = (key) => {
        const draft = petDraft.multiAgent || (pet && pet.multiAgent) || {}
        return draft[key]
      }
      const setTeamValue = (key, value) => setPetDraft((draft) => {
        const current = draft.multiAgent || (pet && pet.multiAgent) || {}
        return { ...draft, multiAgent: { ...current, [key]: value } }
      })

      async function savePet(override, okText) {
        // override 用来做「一键应用」（比如切形象）；直接当 onClick 用时传进来的是事件对象
        const extra = override && typeof override === 'object'
          && !('nativeEvent' in override) && !('target' in override) ? override : null
        const patch = extra ? { ...petDraft, ...extra } : petDraft
        setBusy(true)
        setMessage({ kind: '', text: '' })
        try {
          const response = await fetch('/dsh-live-pet/config', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ pet: patch }),
          })
          const payload = await response.json()
          if (payload.ok === true && payload.petSaved === true) {
            setPet(payload.pet || {})
            setPetDraft({})
            setMessage({ kind: 'ok', text: okText || '宠物设置已保存并立即生效' })
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

      async function refreshDeps() {
        try {
          const payload = await (await fetch('/dsh-live-pet/deps', { headers: { accept: 'application/json' } })).json()
          setDeps(payload)
        } catch {
          setDeps(null)
        }
      }

      async function installDeps() {
        setDepsBusy(true)
        setMessage({ kind: '', text: '' })
        try {
          const payload = await (await fetch('/dsh-live-pet/deps', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'install' }),
          })).json()
          if (payload.missing && payload.missing.length > 0) {
            setMessage({ kind: 'err', text: '还缺：' + payload.missing.join('、') + '（输出：' + String(payload.output || '').slice(0, 200) + '）' })
          } else if (payload.ok === true) {
            setMessage({ kind: 'ok', text: '依赖已装好，可以点「启动」了' })
          } else {
            setMessage({ kind: 'err', text: '安装失败：' + String(payload.output || payload.error || '').slice(0, 220) })
          }
          await refreshDeps()
        } catch (error) {
          setMessage({ kind: 'err', text: '安装失败：' + (error && error.message ? error.message : error) })
        }
        setDepsBusy(false)
      }

      async function refreshBackgrounds() {
        try {
          const payload = await (await fetch('/dsh-live-pet/scene/backgrounds', { headers: { accept: 'application/json' } })).json()
          setBackgrounds(Array.isArray(payload.items) ? payload.items : [])
        } catch {
          setBackgrounds([])
        }
      }

      React.useEffect(() => { refreshLive(); refreshDeps(); refreshBackgrounds() }, [])

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
          h(Row, { label: '服务依赖' },
            deps === null
              ? h('span', { style: styles.hint }, '检测中…')
              : (deps.missing && deps.missing.length > 0
                ? h('span', { style: styles.err }, '缺：' + deps.missing.join('、'))
                : h('span', { style: styles.ok }, '齐全（' + String(deps.python || 'python') + (deps.bundled ? ' · 自带直播服务' : ' · 外部目录') + '）')),
            h('button', { style: styles.button, disabled: depsBusy, onClick: installDeps }, depsBusy ? '安装中…' : '安装依赖'),
            h('button', { style: styles.button, disabled: depsBusy, onClick: refreshDeps }, '重新检测')),
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
          h(Row, { label: '直播背景' },
            h(Check, {
              label: '铺一张背景图：左上角弹幕池、右上角点歌台（宠物只在背景里活动）',
              value: petValue('sceneEnabled') === true,
              onChange: (v) => setPetValue('sceneEnabled', v),
            })),
          h(Row, { label: '背景窗口' },
            h('button', { style: styles.button, disabled: busy, onClick: () => applySceneMode('full') }, '全屏背景'),
            h('button', { style: styles.button, disabled: busy, onClick: () => applySceneMode('minimal') }, '最小化背景'),
            h('button', { style: styles.button, disabled: busy, onClick: () => applySceneMode('off') }, '关闭背景'),
            h('span', { style: styles.hint },
              (petValue('sceneEnabled') === true
                ? (petValue('sceneMinimized') === true ? '当前：最小化（只留宠物）' : '当前：全屏')
                : '当前：已关闭') + ' · 三个按钮点了立刻生效，也可以右键宠物 → 背景')),
          h(Row, { label: '背景图' },
            h(Select, {
              value: petValue('sceneImage') || '',
              options: (() => {
                const list = [['', '插件自带（bg/scene.jpg）']]
                const seen = new Set([''])
                for (const item of backgrounds) {
                  list.push([item.path, item.name])
                  seen.add(item.path)
                }
                const custom = petValue('sceneImage')
                if (custom && !seen.has(custom)) list.push([custom, custom.split(/[\\/]/).pop() + '（自定义路径）'])
                return list
              })(),
              onChange: (v) => setPetValue('sceneImage', v),
            }),
            h('button', { style: styles.button, onClick: refreshBackgrounds }, '重新扫描')),
          h(Row, { label: '自定义背景' },
            h(Text, {
              value: petValue('sceneImage'),
              placeholder: '也可以填本地图片的完整路径，例如 D:\\壁纸\\xxx.jpg',
              onChange: (v) => setPetValue('sceneImage', v),
            }),
            h('span', { style: styles.hint }, '把图片丢进插件的 bg 文件夹，就能在上面那个下拉里选到')),
          h(Row, { label: '气泡字号' },
            h(Number, { value: petValue('bubbleFontSize'), onChange: (v) => setPetValue('bubbleFontSize', v === '' ? 20 : v) }),
            h('span', { style: styles.hint }, '宠物说话的气泡字号，直播建议 20~30')),
          h(Row, { label: '弹幕池字号' },
            h(Number, { value: petValue('poolFontSize'), onChange: (v) => setPetValue('poolFontSize', v === '' ? 20 : v) }),
            h('span', { style: styles.hint }, '左上角弹幕池的字号，直播建议 20~28')),
          h(Row, { label: '自动溜达' },
            h(Check, {
              label: '让它在桌面上自己走动（走一会儿停一会儿）',
              value: petValue('wander') !== false,
              onChange: (v) => setPetValue('wander', v),
            })),
          h(Row, { label: '走多快' },
            h(Number, { value: petValue('wanderSpeed'), onChange: (v) => setPetValue('wanderSpeed', v === '' ? 55 : v) }),
            h('span', { style: styles.hint }, '像素/秒，35 慢悠悠，80 有点赶')),
          h(Row, { label: '歇多久' },
            h(Number, { value: petValue('wanderDwellMinSec'), onChange: (v) => setPetValue('wanderDwellMinSec', v === '' ? 6 : v) }),
            h('span', { style: styles.hint }, '到'), 
            h(Number, { value: petValue('wanderDwellMaxSec'), onChange: (v) => setPetValue('wanderDwellMaxSec', v === '' ? 18 : v) }),
            h('span', { style: styles.hint }, '秒之间随机停一会儿；你点它、拖它、打字时会自动暂停')),          h(Row, { label: '宠物名字' },
            h(Text, { value: petValue('petName'), placeholder: '大肥鲸', onChange: (v) => setPetValue('petName', v) }),
            h('span', { style: styles.hint }, '弹幕池署名、气泡落款用；连麦时用来区分谁在说话')),
          h(Row, { label: '人设' },
            h(TextArea, {
              value: petValue('persona'),
              placeholder: '留空就用内置默认人设（大肥鲸）。想改性格/说话方式就在这里写，例如：\n你是直播间里一只爱吐槽的海獭，说话短、爱用「哎」开头，不懂就说不知道。',
              onChange: (v) => setPetValue('persona', v),
            }),
            h('span', { style: styles.hint }, '保存后会重建宠物 profile，下一轮对话生效（当前这轮不受影响）')),
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

        h(Card, {
          title: '动作（右键菜单）',
          hint: '右键点宠物 → 动作，就能让它当场演一个。下面能看到全部动作，也能自己加。',
        },
          h(Row, { label: '动作库' },
            h('span', { style: styles.hint }, poses.length === 0
              ? '（还没读到，点右边刷新）'
              : poses.map((pose) => pose.label).join('、')),
            h('button', { style: styles.button, onClick: () => refreshPoses() }, '刷新')),
          h('div', { style: styles.hint },
            '自定义动作：JSON 数组。字段 —— id：英文短名；label：菜单上显示的字；'
            + 'emotion：情绪帧（happy / mischievous / crying / unhappy / eating / cooking / coding / tv / walking）；'
            + 'sec：演多少秒；fx：特效（none / squash 挤压 / firework 烟花 / shake 抖一抖 / spin 转个身 / hop 蹦一下）。'),
          h('div', { style: styles.hint },
            '例：[{"id":"jing","label":"敬个礼","emotion":"happy","sec":5,"fx":"squash"},{"id":"sad","label":"装可怜","emotion":"crying","sec":6,"fx":"shake"}]'),
          h('textarea', {
            style: styles.area,
            value: posesText,
            spellCheck: false,
            onChange: (event) => setPosesText(event.target.value),
          }),
          h('div', { style: styles.row },
            h('button', { style: styles.buttonPrimary, disabled: busy, onClick: savePoses }, '保存自定义动作'))),

        h(Card, {
          title: '双智能体（连麦）',
          hint: '开启后，主宠物会和另一个 AI（默认叫小海豚）在直播间里连麦：要么互相抬杠，要么一起闲聊；观众弹幕随时能插话。开了直播背景时两只都画在背景里（OBS 抓一个窗口就够），没开背景时 B 自己一个窗口。',
        },
          h(Row, { label: '开关' },
            h(Check, { label: '让它俩互相说话', value: teamValue('enabled') === true, onChange: (v) => setTeamValue('enabled', v) }),
            h(Check, { label: '观众弹幕能插话', value: teamValue('audienceJoin') !== false, onChange: (v) => setTeamValue('audienceJoin', v) }),
            h(Check, { label: 'B 也出镜', value: teamValue('showPetB') !== false, onChange: (v) => setTeamValue('showPetB', v) })),
          h(Row, { label: '关系' },
            h(Select, {
              value: teamValue('mode') || 'argue',
              options: [['argue', '互相抬杠（吵架）'], ['chat', '搭子闲聊']],
              onChange: (v) => setTeamValue('mode', v),
            })),
          h(Row, { label: '对方名字' },
            h(Text, { value: teamValue('nameB'), placeholder: '小海豚', onChange: (v) => setTeamValue('nameB', v) })),
          h(Row, { label: '对方人设' },
            h(TextArea, {
              value: teamValue('personaB'),
              rows: 4,
              placeholder: '留空就用内置的「抬杠搭子」人设。想换成捧哏、或者另一个完全不同的角色，在这里写。',
              onChange: (v) => setTeamValue('personaB', v),
            })),
          h(Row, { label: '对方 DSH profile' },
            h(Text, {
              value: teamValue('profileB'),
              placeholder: '留空 = 跟主宠物同一个 profile，只隔离会话',
              onChange: (v) => setTeamValue('profileB', v),
            }),
            h('span', { style: styles.hint }, '想让它用别的模型/别的权限档，就填另一个 profile 名')),
          h(Row, { label: '节奏' },
            h('span', { style: styles.hint }, '冷场 '),
            h(Number, { value: teamValue('idleStartSec'), onChange: (v) => setTeamValue('idleStartSec', v === '' ? 45 : v) }),
            h('span', { style: styles.hint }, '秒后开聊 · 每句间隔 '),
            h(Number, { value: teamValue('turnGapSec'), onChange: (v) => setTeamValue('turnGapSec', v === '' ? 3 : v) }),
            h('span', { style: styles.hint }, '秒 · 一波最多 '),
            h(Number, { value: teamValue('roundsPerBurst'), onChange: (v) => setTeamValue('roundsPerBurst', v === '' ? 8 : v) }),
            h('span', { style: styles.hint }, '轮 · 聊完歇 '),
            h(Number, { value: teamValue('quietSec'), onChange: (v) => setTeamValue('quietSec', v === '' ? 60 : v) }),
            h('span', { style: styles.hint }, '秒')),
          h('div', { style: styles.row },
            h('button', { style: styles.buttonPrimary, disabled: busy, onClick: savePet }, '保存双智能体设置'))),

        h(Card, {
          title: '形象（换成自己的动图）',
          hint: '形象包就是一个文件夹：里面按情绪名放 GIF（happy.gif / crying.gif …），缺哪个情绪自动用自带那套。切形象后宠物窗口会重启一次。',
        },
          h(Row, { label: '当前形象' },
            h('span', { style: styles.hint }, petValue('skinDir') ? String(petValue('skinDir')) : '内置（大肥鲸）'),
            h('button', { style: styles.button, onClick: () => savePet({ skinDir: '' }, '已恢复内置形象（窗口会重启一次）') }, '用内置'),
            h('button', { style: styles.button, disabled: skinsBusy, onClick: () => refreshSkins() }, '刷新形象列表'),
            h('button', { style: styles.button, disabled: skinsBusy, onClick: () => createSkin() }, '建一个形象文件夹'),
            h('button', { style: styles.button, disabled: skinsBusy, onClick: () => openSkinFolder('') }, '打开形象目录')),
          skins.length === 0
            ? h('div', { style: styles.hint }, '（还没有自己的形象包。点「建一个形象文件夹」，把 GIF 丢进去再回来选）')
            : null,
          skins.map((skin) => h(Row, { key: skin.dir, label: skin.name },
            h('span', { style: styles.hint }, `${skin.count}/9 情绪 · ${Object.keys(skin.emotions || {}).join(' ') || '没认出 GIF'}`),
            skin.active === true
              ? h('span', { style: styles.ok }, '正在用')
              : h('button', {
                style: styles.buttonPrimary,
                disabled: busy,
                onClick: () => savePet({ skinDir: skin.dir }, `形象已切到「${skin.name}」（窗口会重启一次）`),
              }, '用这个形象'),
            h('button', { style: styles.button, onClick: () => openSkinFolder(skin.dir) }, '打开'))),
          h('div', { style: styles.hint },
            '情绪文件名固定这 9 个：happy、mischievous、crying、unhappy、eating、cooking、coding、tv、walking。'
            + '支持透明背景 GIF（每帧时长按 GIF 自己写的走），也可以放 PNG 序列：happy\\001.png、002.png …')),

        h(Card, {
          title: 'Token 用量',
          hint: '每轮从 DSH 的 --json 输出里取 usage 累加（输入 / 输出 / 缓存读），重启插件接着记。',
        },
          h(Row, { label: '累计' },
            h('span', { style: styles.ok }, usage ? `${usage.total || 0} token · ${usage.turns || 0} 轮` : '（还没读到）'),
            h('span', { style: styles.hint }, usage
              ? `输入 ${usage.input || 0} / 输出 ${usage.output || 0} / 缓存读 ${usage.cacheRead || 0}`
              : ''),
            h('button', { style: styles.button, onClick: () => refreshUsage() }, '刷新'),
            h('button', { style: styles.button, onClick: () => resetUsage() }, '清零重新统计')),
          h(Row, { label: '分工' },
            h('span', { style: styles.hint }, usage
              ? `主宠物 A ${usage.turnsA || 0} 轮 · 搭子 B ${usage.turnsB || 0} 轮 · 平均每轮 ${usage.avgPerTurn || 0} token`
              : ''),
            h('span', { style: styles.hint }, usage && usage.last
              ? `最后一轮：${usage.last.slot === 'b' ? 'B' : 'A'} 输入 ${usage.last.input} / 输出 ${usage.last.output}`
              : ''))),

        h(Card, {
          title: '配置存在哪',
          hint: '改哪个文件就影响哪个装法；设置页保存时改的就是下面这个。',
        },
          h(Row, { label: '本插件 config.json' },
            h('span', { style: styles.hint }, configFile || '（读取中…）'),
            h('button', { style: styles.button, onClick: () => load() }, '重新读取')),
          h(Row, { label: '直播服务 settings.json' },
            h('span', { style: styles.hint }, (liveState && liveState.baseDir)
              ? `${liveState.baseDir}\\settings.json`
              : '（托管启动后显示；默认在插件目录的 live-data 下）')),
          h('div', { style: styles.hint },
            '独立 exe 版：%LOCALAPPDATA%\\dsh-live-pet\\app\\config.json（同目录里有 app.log / live-pet.log / pet-window-*.log）。'
            + '宠物窗口的位置记在 pet-window-a.json / pet-window-b.json，token 用量记在 usage.json。')),

        h('div', { style: styles.hint },
          '提示：改完「直播服务」里的开关后，直播服务会把它写进自己的 settings.json；' +
          '插件的开关写在 ' + (configFile || '本插件的 config.json') + '。'))
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
