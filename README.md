# dsh-live-pet · 抖音直播桌面宠物（DSH 插件）

把抖音直播间的弹幕接到 **DeepSeek Harness（DSH）** 的会话里，让一只透明置顶的「小鲸鱼」在桌面上：

- 用鲸鱼口吻回弹幕（DSH 会话，跨弹幕保持上下文）
- 换 9 套情绪动图（开心 / 调皮 / 大哭 / 不开心 / 吃饭 / 做饭 / 敲电脑 / 躺沙发看电视 / 散步）
- 用 Edge-TTS 把回复念出来
- 欢迎进场观众、感谢礼物、冷场自己抛话题
- 自己判断要不要**点歌 / 切歌**（走工具调用，不是关键词匹配）
- 在宠物左侧显示**歌单板**（只在有歌在放时出现）
- 用只读工具查电脑状态、读文件、免 key 中文搜索
- **人设可换**：在 DSH 设置里写一段系统提示词，它就不是鲸鱼了（想让它叫「阿獭」也行）
- **自己溜达**：会在桌面各处走动（带走路动画和左右转身），走一会儿停一会儿；你一点/一拖/一打字它就自动让路
- **直播场景**：一键铺一张背景图，左上角弹幕池、右上角点歌台，宠物只在这块背景里活动——单窗口，OBS 直接抓窗口即可
- **背景三态**：全屏背景 / 最小化（只留宠物）/ 关闭，右键菜单和设置页都能一键切
- **右键动作菜单**：13 个内置动作（敬礼/贴沙发/蹦一下/放烟花…）+ 自己写的自定义动作，点了当场演
- **双智能体连麦**：主宠物和另一个 AI 在直播间抬杠（也可切成搭子闲聊），观众弹幕随时能插话
- **桌面上两只宠物**：连麦时 A / B 各有自己的窗口，各说各的，气泡不打架
- **形象可换**：把 GIF 丢进一个文件夹，就是另一套宠物（缺哪个情绪自动回退内置）
- **token 用量统计**：设置页看累计消耗、A/B 各多少轮，可清零
- **只读查看 DSH**：能看 DSH 有几个 profile、多少条会话、最近聊了啥（只读，不改不跑命令）
- 在 **DSH → 设置 → 直播宠物** 里统一配置
- 也可以打成一个 **exe 双击就跑**，设置页跟着 exe 走（见「方式 C」）

## 让 AI 帮你装（复制给 AI 用）

> 把下面整段发给你的 AI 助手（DSH 自带的也行），**只需要把最后一行的房间号改成你自己的**。
> AI 会自己装包、检查依赖、启动服务并逐条验收；唯一需要你动手的是中途重启一次 DSH。

```
请帮我把 DSH 插件 dsh-live-pet 装好并跑通。按顺序执行，每步都验证结果，失败就停下来说明原因，不要跳步。

【1. 安装】
  plugin_manager({ action: 'install_bundle', target: 'github:szhadmin/dsh-live-pet' })
  plugin_manager({ action: 'set_bundle', target: 'dsh-live-pet', enabled: true })

【2. 检查直播服务的 Python 依赖】
  GET {DSH地址}/dsh-live-pet/deps
  - missing 为空 → 继续下一步
  - missing 非空 → POST {DSH地址}/dsh-live-pet/deps ，body {"action":"install"}；装完再 GET 一次确认 missing 为空
  - pip 装不上（无网络/无权限）→ 把缺的包名告诉我，别继续

【3. 让我重启一次 DSH】
  设置页属于客户端模块，必须重启 DSH 后才会出现。重启完请确认设置里出现了「直播宠物」这一页。

【4. 配置并启动】
  - 「直播服务（插件托管）」保持开启 → 点「启动」→ 状态应显示运行中（127.0.0.1:8791）
  - 「直播间地址」填 https://live.douyin.com/把这里换成我的房间号 → 保存

【5. 验收（逐条把结果报给我）】
  - GET {DSH地址}/dsh-live-pet/live → running = true
  - GET http://127.0.0.1:8791/api/state → douyin.state = connected
  - GET {DSH地址}/dsh-live-pet/state → status 是 idle / thinking / speaking（不是 offline）
  - 桌面上有一只透明小鲸鱼，点一下弹输入条，打字能收到回复

【6. 卡住时按这个顺序自查，并把结论告诉我】
  - GET {DSH地址}/dsh-live-pet/log 的最后 20 行
  - 插件目录下 live-pet.log、pet-window.log 的报错
  - 8791 端口是否被占用（冲突就改 config.json 的 livePort）
  - Python 是否在 PATH（不在就把 config.json 的 pythonBin 写成绝对路径）
```
## 环境要求

| 项 | 要求 |
| --- | --- |
| 系统 | Windows 10/11（宠物窗口是 WPF，用 PowerShell 5.1 跑） |
| DSH | DeepSeek Harness 桌面版（Host + Web UI） |
| Python | 3.10+（语音合成 + 直播服务都用它；`pythonBin` 可指向任意解释器） |
| Python 包 | `edge-tts` `websocket-client` `requests` `betterproto` `py-mini-racer` `PyExecJS` `protobuf`（设置页可一键安装） |
| Node | DSH 自带的 node 就够，无需额外安装 |
| 模型 | 一个 OpenAI 兼容的 API key（DSH 里已经配好的那个即可） |

> **开箱即用**：抖音弹幕抓取、点歌台、礼物规则、控制台页面都在本仓库的 `live/` 里，
> 不用再单独装别的项目。插件会在 `8791` 端口把这份直播服务跑成独立实例
> （数据落在插件的 `live-data/`，和别的实例完全隔离）。
> 想改用你自己的直播服务目录，把 `config.json` 的 `workspace` 指过去即可（留空 = 用自带的 `live/`）。

## 安装

### 方式 A：让 DSH 从 GitHub 安装（推荐）

```
plugin_manager install_bundle  target="github:szhadmin/dsh-live-pet"
plugin_manager set_bundle      target="dsh-live-pet" enabled=true
```

装完做两件事：

1. **重启一次 DSH**：设置页属于客户端模块，DSH 的客户端模块表在启动时编排，热装不会把新页面加进来。
2. 打开 **设置 → 直播宠物**，看「服务依赖」那行：显示"齐全"就能直接点 **启动**；
   显示缺包就点 **安装依赖**（后端跑 `pip install -r live/requirements.txt`），装完再启动。

### 方式 B：本地目录（改代码时用这个）

```powershell
git clone https://github.com/szhadmin/dsh-live-pet.git F:\douyinlive\dsh-live-pet
```

`cordis.patch.yml` 默认用包名 `dsh-live-pet`；如果你没装成包，把行名改成绝对路径：

```yaml
- insert:
    - id: dsh-live-pet
      name: "F:/douyinlive/dsh-live-pet/index.js"
```

> 用绝对路径还有额外好处：DSH 的客户端模块缓存按「模块名」记，路径式行名可以绕开它，
> 装好刷新页面就能看到设置页，不必重启。

## 方式 C：独立 exe（不装 DSH 插件也能跑）

想「双击就有一只鲸鱼在桌面上」、不进 DSH 设置也能改配置，可以打成一个 exe：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\build-exe.ps1
# 产物：dist\dsh-live-pet.exe（约 98MB，Node SEA 单文件）
```

exe 自带：宠物窗口脚本、全部帧图、直播服务代码，以及一份**本地设置页**。

| 行为 | 说明 |
| --- | --- |
| 双击 exe | 起本地服务（默认 `127.0.0.1:8899`）+ 宠物窗口；直播服务按配置托管在 `8791` |
| 再点一次 exe | 发现已在运行 → 只弹出设置页，不会开第二只宠物 |
| 首次运行 | 资源解到 `%LOCALAPPDATA%\dsh-live-pet\app`，并自动打开设置页 |
| 设置页 | 宠物 / 互动 / 模型 / 直播背景 / 动作 / 双智能体 / 直播服务 / 路径 / 其它 |
| 配置位置 | `%LOCALAPPDATA%\dsh-live-pet\app\config.json`（字段与插件版一致，可以互拷） |
| 日志 | `%LOCALAPPDATA%\dsh-live-pet\app.log`、`…\app\live-pet.log`、`…\app\pet-window.log` |
| 退出 | 宠物右键菜单里的「退出」，或任务管理器结束 `dsh-live-pet.exe` |

exe 版和插件版**共用同一套代码**（`index.js` + `pet.ps1`），区别只是宿主：
插件版跑在 DSH 的 ctx 里，exe 版用 `app/main.js` 造了个最小的 ctx 垫片。
两边配置互不影响（各读各的 `config.json`），也能同时开——不想撞车就关掉一边的宠物窗口。

> exe 版仍然需要 **Python**（点歌/语音/弹幕）和 **DSH CLI**（宠物的大脑，在设置页「路径」里指过去）。
> 只想看宠物在桌面上动、不接弹幕，把「由宠物托管直播服务」和「启动时自动起直播服务」关掉就行。
## 首次配置

1. 打开 **设置 → 直播宠物**，「直播服务（插件托管）」默认已开。
2. 点 **启动**，它会在 `127.0.0.1:8791` 起一个独立的直播服务实例
   （数据落在插件的 `live-data\`，和你自己的 8790 隔离）。
3. 填 **直播间地址**（`https://live.douyin.com/房间号`），保存。
4. 想调行为就在「宠物行为」里改：对话模式、字数、限流、欢迎进场、礼物动作、情绪联动、切歌权限。

配置文件 `config.json`（首次启动自动生成）：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `workspace` | `F:\douyinlive` | 直播服务项目目录（`app.py` 所在） |
| `pythonBin` | `python` | 跑 Edge-TTS 的解释器 |
| `manageLive` / `livePort` | `true` / `8791` | 由插件托管直播服务 |
| `profile` / `manageProfile` | `pet` / `true` | 宠物用的 DSH profile（插件自动生成到 `$DSH_HOME\profiles\pet`） |
| `apiKey` / `apiKeyEnv` | 空 / `BUDDYHUB_API_KEY` | 模型 key；留空则从直播项目的 `settings.json` 读 |
| `mode` | `auto` | `auto`=接管弹幕；`mirror`=只镜像直播服务的发言 |
| `speak` / `ttsVoice` | `true` / `zh-CN-XiaoxiaoNeural` | 语音合成与音色 |
| `maxChars` / `chatMaxChars` | 70 / 240 | 弹幕回复 / 老板聊天的字数上限 |
| `persona` | 空 | **人设（系统提示词）**：留空用内置的「大肥鲸」；填了就接管身份与说话方式。改完自动重建宠物 profile 并重置会话，下一轮生效 |
| `sceneEnabled` | `false` | 直播场景：背景图 + 弹幕池 + 点歌台，宠物限定在背景里 |
| `sceneImage` | 空 | 背景图路径（空 = 插件自带 `bg/scene.jpg`） |
| `bubbleFontSize` | `20` | 宠物对话气泡字号（直播建议 20~30） |
| `poolFontSize` | `20` | 场景里弹幕池字号（直播建议 20~28） |
| `wander` | `true` | 自动溜达：让它在桌面上自己走动 |
| `wanderSpeed` | `55` | 走路速度（像素/秒），35 慢悠悠 / 80 有点赶 |
| `wanderDwellMinSec` / `wanderDwellMaxSec` | `6` / `18` | 到地方后停留多久（这个区间里随机） |
| `skinDir` | 空 | **形象包目录**：放 `<情绪>.gif` 或 `<情绪>/*.png`，留空用自带形象（见「换形象」） |
| `multiAgent.showPetB` | `true` | 让搭子 B 出镜（开背景时画在背景里，没开背景时自己一个窗口） |

### 配置界面（设置页）在哪

| 装法 | 怎么打开 |
| --- | --- |
| DSH 插件 | DSH 客户端 → **设置** → 左侧 **「直播宠物」**（Web 界面同样：打开 `http://127.0.0.1:62209` → 右上角设置 → 直播宠物） |
| 独立 exe | 浏览器打开 **`http://127.0.0.1:8899/settings`**（端口是 `config.json` 里的 `appPort`）；也可以再双击一次 exe（发现已在运行 → 只弹出设置页） |

设置页里的分区：

- 插件版：「直播服务（插件托管）」「直播内容」「音色」「音乐 / 点歌」「礼物感谢动作」「宠物行为」「动作（右键菜单）」「双智能体（连麦）」「形象 / 用量 / 配置存在哪」
- exe 版：顶部标签页「宠物 / 互动 / 模型 / 直播背景 / 形象 / 动作 / 双智能体 / 用量 / 直播服务 / 路径 / 其它」

### 配置文件到底在哪

三种装法各有一个 `config.json`，改哪个就影响哪个：

| 装法 | 路径 | 备注 |
| --- | --- | --- |
| DSH 插件 | `%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-live-pet\config.json` | 设置页改的就是它；`profiles\desktop` 换成你实际启用的 profile |
| 独立 exe | `%LOCALAPPDATA%\dsh-live-pet\app\config.json` | exe 解压出来的 app 目录里；exe 的日志在同目录 `app.log` / `live-pet.log` / `pet-window-*.log` |
| 直播服务本体 | `<liveBaseDir>\settings.json`（默认插件目录下 `live-data\settings.json`） | 弹幕连接、歌单、语音这些是直播服务的配置，设置页会转写 |

不用记路径：设置页 **「路径」** 页直接显示当前生效的 `config.json` 完整路径和各个目录，还有「打开」按钮。

## 换形象（宠物长相 / 动图配成可替换的）

形象包就是一个文件夹，里面按**情绪名**放动图：

```
skins\小海豚\
  happy.gif        开心
  mischievous.gif  坏笑
  crying.gif       哭
  unhappy.gif      不高兴
  eating.gif       吃东西
  cooking.gif      做饭
  coding.gif       敲电脑
  tv.gif           躺沙发看电视
  walking.gif      走路
```

- 设置页 **「形象」** 页：`建一个形象文件夹` → 弹出目录 → 把 GIF 丢进去 → `刷新列表` → `用这个形象`（宠物窗口会重启一次，2 秒）
- 支持**透明背景 GIF**（每帧时长按 GIF 自己写的走）或 **PNG 序列**（建 `happy\` 文件夹放 `001.png`… 再放 `meta.json` 写每帧毫秒）
- **只放一两个也能用**：缺哪个情绪自动回退到插件自带的帧；非正方形图按比例摆，不会拉变形
- 想一次性备多套就建多个文件夹，随时互相切；`恢复内置形象` 一键回滚
- 配置文件里对应 `skinDir`（填绝对路径）；exe 版同样有效（`%LOCALAPPDATA%\dsh-live-pet\app\skins\`）

## 两只宠物（连麦搭子 B）

「双智能体」打开后，两只宠物都会出现：A 是主宠物（大肥鲸），B 是搭子（名字可在设置里改）。

- **开了直播背景（全屏）时，两只都画在背景里**：B 由 A 的窗口一起渲染，站在背景范围内、有自己的名字标签和气泡——OBS 只抓「小鲸鱼直播宠物」一个窗口，两只就都在画面里
- **没开背景时**：A 一个窗口、B 另一个窗口，各说各的（`/state?slot=a` 和 `/state?slot=b` 分开给状态，气泡不会互相覆盖），B 默认站屏幕左侧；位置分别记在 `pet-window-a.json` / `pet-window-b.json`
- 不想让 B 出镜就关掉「B 也出镜」（`multiAgent.showPetB=false`）：B 还在说话，只是台词显示在 A 的气泡里

## Token 用量

- 每轮从 DSH 的 `--json` 输出里取 `usage`（input / output / cache 读），累加进 `usage.json`，**重启插件不清零**
- 设置页 **「用量」** 页看总量、A/B 各自回合数、平均每轮、最后一轮明细，可一键清零重新统计
- **直播画面上也看得到**：开了直播背景后，左下角「本场数据」里多两行 `token  1,234,567 / 58 轮` 和 `每分钟  ...`
- 顶栏一直显示累计 token
- 命令行看：`curl http://127.0.0.1:62209/dsh-live-pet/usage`（`?reset=1` 清零）


## 直播场景（背景图 + 弹幕池 + 点歌台）

在设置里打开「直播背景」，宠物窗口会变成一块全屏的场景：

- **背景**：设置里直接**下拉选**（把图片丢进插件的 `bg/` 文件夹就会出现在列表里），也可以填任意本地图片的完整路径；建议 1920×1080。自带 `scene.jpg`（书屋·大海·晴天）和 `scene-dusk.jpg`（黄昏版）两张
- **左上角弹幕池**：观众的弹幕、进场、礼物，还有宠物自己的回复（`[我]` 开头），最多留最近 10 条
- **右上角点歌台**：正在放什么 + 排队中的前 5 首
- **宠物只在背景里活动**：溜达范围就是这块背景，不会跑到背景外面
- 气泡字号、弹幕池字号都能调（直播看着更清楚）
- **只有一个窗口**：OBS 里「窗口采集」选「小鲸鱼直播宠物」就能把整块场景抓走，不用对齐多个来源

> 场景窗口每 3 秒会把自身压回最上层并锚定在主屏 (0,0)，免得被其它窗口盖住或被系统挪到副屏。

## 宠物窗口

- 透明、置顶、可拖到桌面任意位置；位置与缩放在 `pet-window.json`
- `Ctrl+滚轮` 或右键「大小」缩放（0.6 / 0.85 / 1.1 / 1.35）
- **单击**：挤压回弹 + 随机反应 + 弹出输入条，回车就把话发给它
- **右键菜单**：大小 / 跟它说句话 / 歌单板 / 重新居中 / 重开 DSH 会话 / 退出
- 歌单板在**宠物左侧**，只在有歌在放的时候出现；开关记在 `pet-window.json`
- **自动溜达**：每 6~18 秒（可调）随机挑一个屏幕位置，用走路动画走过去，到了停一会儿再走；
  往左走会左右翻转朝向。**你点它、拖它、打开输入条时自动暂停**，松手后继续。右键菜单里也能开关。
  位置每到一个地方就存一次，重启窗口会从上次停的地方开始

## 行为与情绪联动

| 触发 | 默认表现 |
| --- | --- |
| 弹幕回复 | 由模型给 `emotion`，9 套动图任选 |
| 有人进场 | 招呼**并叫出名字**：2.5 秒内的进场合并成一批一起欢迎（"欢迎校长、里斯、贾维斯进入直播间"），名字超 8 字自动缩写、打码昵称（含 `*`）不点名；45 秒一次 / 每小时 12 次 / 同一人 30 分钟不重复 |
| 收到礼物 | 道谢 + **躺沙发看电视** 8 秒后回散步（`giftForcedEmotion`，可改成按礼物规则分类） |
| 它真的去查东西 | 切 `coding` 敲电脑（读 DSH 的 `tool_call` 事件，回答完切回来） |
| 它去点歌 | 切 `crying` 大哭 |
| 冷场 150 秒 | 自己抛话题热场 |

## 宠物能用的工具（只读）

`system_status`（CPU/内存/磁盘/运行时长）、`read_text_file`、`glob`、`grep`、
`web_search_cn`（免 key，360 主 Bing 备）、`web_fetch`、`song_request`、`song_skip`。

**故意没有 shell 和文件写工具**。原因：`pwsh` 这类工具的沙箱升级是模型自己填的参数，
在无人值守的子进程里没有审批应答者，升级请求会被放行 —— 等于没锁。
所以"只读"靠**没有这个工具**，而不是靠沙箱。

点歌 / 切歌是**真工具调用**：模型自己判断这条弹幕是不是"想点歌"，才去调 `song_request`。
只是夸歌好听、问现在放什么，不会调。

## 目录结构

```
index.js                      Host 半边：轮询弹幕、驱动 DSH 会话、TTS、HTTP 路由、托管直播服务
client.js                     Client 半边：DSH 设置页「直播宠物」
pet.ps1                       WPF 宠物窗口（透明置顶、动图、气泡、输入条、歌单板）
profile/pet-tools.js          宠物 profile 自带的只读工具（系统状态/读文件/搜索/点歌）
profile/cordis.patch.tpl.yml  宠物 profile 模板（关掉写工具、禁用子智能体/工作流等）
frames/<情绪>/NNN.png         240×240 动图帧（9 种情绪，共 546 张，已压到约 7MB）
skins/<名字>/<情绪>.gif       用户自己的形象包（留空目录也行，缺的情绪回退 frames）
live/                         内置的直播服务（app.py + core + vendor + web + defaults + requirements.txt）
locale/                       设置页文案（中/英）
app/main.js                   独立 exe 的宿主：最小 ctx 垫片 + 本地 HTTP + 打开设置窗口
app/settings.html             独立 exe 的设置页（原生 JS，不依赖 DSH）
scripts/build-exe.ps1         打 exe（esbuild → assets.zip → SEA blob → postject）
scripts/deploy.ps1            部署到本机 profile；scripts/reload.ps1 热重载插件
cordis.patch.yml              bundle patch
```

## 接口（本地 HTTP）

| 路由 | 作用 |
| --- | --- |
| `GET /dsh-live-pet/state` | 宠物窗口轮询的状态（台词/情绪/音频/歌单） |
| `GET|POST /dsh-live-pet/config` | 设置页读写配置（宠物配置 + 转发直播服务配置） |
| `POST /dsh-live-pet/chat` | 窗口输入条发消息 |
| `GET|POST /dsh-live-pet/live` | 托管直播服务的状态 / 启动 / 停止 / 重启 |
| `GET /dsh-live-pet/poses` | 动作库（内置 13 个 + 自定义），右键菜单和设置页都用它 |
| `POST|GET /dsh-live-pet/pose?id=` | 触发一个动作（表情 + 特效，到点自动还原） |
| `GET /dsh-live-pet/state?slot=a|b` | 按窗口分别取状态（A / B 各一条，气泡不互相盖） |
| `GET /dsh-live-pet/usage` | token 用量（`?reset=1` 清零） |
| `GET /dsh-live-pet/skins` | 已安装的形象包 + 每个包认得出的情绪 |
| `POST /dsh-live-pet/skins/create`、`/skins/open` | 建形象文件夹 / 用资源管理器打开形象目录 |
| `GET /health` | 仅独立 exe：版本 / 资源目录 / 实例地址 |
| `GET /dsh-live-pet/log`、`POST /reset`、`GET /selftest`、`GET /idle`、`GET /action` | 诊断与手动触发 |

## 已知限制

- 一轮回复约 2.5~10 秒（DSH 会话 + TTS）；弹幕密集时按 `maxPerMinute` 丢弃新的
- 同一时刻只处理一轮（保证长会话的上下文顺序）
- 语音是 Edge-TTS 固定参数，情绪只靠 rate/pitch 微调，做不到"哽咽/撒娇"
- 首次安装后必须重启一次 DSH 才能看到设置页
- 独立 exe 版：宠物大脑仍是 DSH CLI，所以机器上得有 DSH（`dshBin` 指到 `…\@deepseek-ai\dsh\lib\bin.js`），
  且首次运行会往 `~\.dsh\profiles\pet` 写 profile——这个目录必须可写
- exe 版和插件版同时开会有两只宠物窗口抢桌面，建议只留一边
- `frames` 约 26MB（546 张 PNG），仓库偏大

## 卸载

```
plugin_manager set_bundle    target="dsh-live-pet" enabled=false
plugin_manager remove_bundle target="dsh-live-pet"
```

再删掉 `$DSH_HOME\profiles\pet\`（插件生成的宠物 profile）即可。

## License

MIT
