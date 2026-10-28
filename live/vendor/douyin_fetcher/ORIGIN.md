# 来源与改动说明（第三方代码）

本目录下的文件来自开源项目 **saermart/DouyinLiveWebFetcher**，按原样引入（vendored），
用于本项目的抖音直播间弹幕接入。

| 项 | 值 |
| --- | --- |
| 仓库 | https://github.com/saermart/DouyinLiveWebFetcher |
| 提交 | `40a904bdb0561a5a9c958a95634a29681cc4fbf4`（2026-09-08） |
| 抓取时间 | 2026-10-26 |
| 许可证 | GNU Affero General Public License v3.0（见同目录 `LICENSE`，未修改） |
| 作者声明 | 上游 README：本代码库所有代码均只用于学习研究交流 |

## 引入的文件

| 文件 | 作用 | 是否改动 |
| --- | --- | --- |
| `liveMan.py` | 直播间 roomId 解析、ttwid/`__ac_signature`、WebSocket 握手与心跳、protobuf 解包与消息分发 | 未改动 |
| `sign.js` | WebSocket `signature` 签名（V8 执行） | 未改动 |
| `a_bogus.js` | 请求 `a_bogus` 参数 | 未改动 |
| `ac_signature.py` | `__ac_signature` 生成 | 未改动 |
| `protobuf/douyin.py`、`protobuf/__init__.py` | betterproto 生成的抖音消息结构 | 未改动 |
| `LICENSE` | AGPL-3.0 原文 | 未改动 |

上游仓库里未引入的文件：`main.py`（示例入口）、`sign_v0.js`、`douyin.proto`、`protobuf/protoc.exe`、
`README.MD`、`requirements.txt`。需要时可从上游按同一提交取回。

## 本项目对其做的适配（都在本项目自己的代码里，不改上游文件）

- `core/douyin_live.py`：
  - `liveMan.generateSignature` 默认使用相对路径 `sign.js`，这里包一层补成绝对路径；
  - 子类化 `DouyinLiveWebFetcher`，覆写 `_parseChatMsg/_parseGiftMsg/_parseLikeMsg/_parseMemberMsg/_parseSocialMsg`，
    把消息翻译成本项目事件格式（`comment/gift/like/enter/follow`）；
  - 覆写 `_wsOnOpen/_wsOnError/_wsOnClose` 上报连接状态；
  - 断线按 8s 起、上限 60s 的退避重连。
- `tools/test_douyin_map.py`：离线构造 protobuf 帧，校验映射结果（不联网）。

## 依赖版本

```
requests>=2.31.0
websocket-client>=1.7.0
betterproto==2.0.0b6
PyExecJS>=1.5.1
mini_racer>=0.12.0
```

`mini_racer` 用来在进程内跑 `sign.js`（免装 Node.js）。若某平台没有 `mini_racer` 轮子，
上游还提供 `PyExecJS` + Node 的路径（`sign_v0.js`），本项目默认走 `mini_racer`。

## 许可提示

AGPL-3.0 是强 copyleft 许可证：分发本项目（含 `vendor/` 里的这些文件）时，需要一并提供
对应源码并保留本目录与 `LICENSE`。自用、不对外分发时按上游声明使用即可。
