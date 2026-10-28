# dsh-live-pet · 抖音直播桌面宠物（DSH 插件）

把抖音直播间的弹幕接到 **DeepSeek Harness（DSH）** 的会话里，让一只透明置顶的「小鲸鱼」在桌面上：

- 用鲸鱼口吻回弹幕（DSH 会话，跨弹幕保持上下文）
- 换 9 套情绪动图（开心 / 调皮 / 大哭 / 不开心 / 吃饭 / 做饭 / 敲电脑 / 躺沙发看电视 / 散步）
- 用 Edge-TTS 把回复念出来
- 欢迎进场观众、感谢礼物、冷场自己抛话题
- 自己判断要不要**点歌 / 切歌**（走工具调用，不是关键词匹配）
- 在宠物左侧显示**歌单板**（只在有歌在放时出现）
- 用只读工具查电脑状态、读文件、免 key 中文搜索
- 在 **DSH → 设置 → 直播宠物** 里统一配置

## 环境要求

| 项 | 要求 |
| --- | --- |
| 系统 | Windows 10/11（宠物窗口是 WPF，用 PowerShell 5.1 跑） |
| DSH | DeepSeek Harness 桌面版（Host + Web UI） |
| 直播服务 | [douyinlive](https://github.com/szhadmin/douyinlive) 项目的 `app.py`（提供弹幕、点歌台、礼物规则） |
| Python | 装了 `edge-tts` 的解释器（语音合成用；`pythonBin` 可指向任意 python） |
| Node | DSH 自带的 node 就够，无需额外安装 |
| 模型 | 一个 OpenAI 兼容的 API key（DSH 里已经配好的那个即可） |

> 插件**不内置**抖音弹幕抓取，它依赖 `app.py` 那份直播服务。插件可以**托管**它：
> 在设置页点一下就在 `8791` 端口起一个独立实例（自己的 settings/data/songs/logs），
> 和你手动开的 `8790` 完全隔离。

## 安装

### 方式 A：让 DSH 从 GitHub 安装（推荐）

```
plugin_manager install_bundle  target="github:szhadmin/dsh-live-pet"
plugin_manager set_bundle      target="dsh-live-pet" enabled=true
```

> **装完必须重启一次 DSH**：设置页属于客户端模块，DSH 的客户端模块表在启动时编排，
> 热装不会把新页面加进来。重启后打开 **设置 → 直播宠物**。

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

## 宠物窗口

- 透明、置顶、可拖到桌面任意位置；位置与缩放在 `pet-window.json`
- `Ctrl+滚轮` 或右键「大小」缩放（0.6 / 0.85 / 1.1 / 1.35）
- **单击**：挤压回弹 + 随机反应 + 弹出输入条，回车就把话发给它
- **右键菜单**：大小 / 跟它说句话 / 歌单板 / 重新居中 / 重开 DSH 会话 / 退出
- 歌单板在**宠物左侧**，只在有歌在放的时候出现；开关记在 `pet-window.json`

## 行为与情绪联动

| 触发 | 默认表现 |
| --- | --- |
| 弹幕回复 | 由模型给 `emotion`，9 套动图任选 |
| 有人进场 | 招呼一句（45 秒一次 / 每小时 12 次 / 同一人 30 分钟不重复） |
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
frames/<情绪>/NNN.png         240×240 动图帧（9 种情绪，共 546 张）
locale/                       设置页文案（中/英）
cordis.patch.yml              bundle patch
```

## 接口（本地 HTTP）

| 路由 | 作用 |
| --- | --- |
| `GET /dsh-live-pet/state` | 宠物窗口轮询的状态（台词/情绪/音频/歌单） |
| `GET|POST /dsh-live-pet/config` | 设置页读写配置（宠物配置 + 转发直播服务配置） |
| `POST /dsh-live-pet/chat` | 窗口输入条发消息 |
| `GET|POST /dsh-live-pet/live` | 托管直播服务的状态 / 启动 / 停止 / 重启 |
| `GET /dsh-live-pet/log`、`POST /reset`、`GET /selftest`、`GET /idle`、`GET /action` | 诊断与手动触发 |

## 已知限制

- 一轮回复约 2.5~10 秒（DSH 会话 + TTS）；弹幕密集时按 `maxPerMinute` 丢弃新的
- 同一时刻只处理一轮（保证长会话的上下文顺序）
- 语音是 Edge-TTS 固定参数，情绪只靠 rate/pitch 微调，做不到"哽咽/撒娇"
- 首次安装后必须重启一次 DSH 才能看到设置页
- `frames` 约 26MB（546 张 PNG），仓库偏大

## 卸载

```
plugin_manager set_bundle    target="dsh-live-pet" enabled=false
plugin_manager remove_bundle target="dsh-live-pet"
```

再删掉 `$DSH_HOME\profiles\pet\`（插件生成的宠物 profile）即可。

## License

MIT
