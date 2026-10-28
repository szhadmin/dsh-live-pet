# defaults —— 打包时内置的默认文件

这个目录里的东西会随 PyInstaller 一起打进 `dist\大肥鲸直播.exe`，
exe 首次运行时再把它们释放到 exe 旁边（`core/paths.py:ensure_user_files()`）。

## 目录内容

| 文件 | 来源 | 是否入库 |
| --- | --- | --- |
| `settings.json` | `build_exe.ps1` 每次打包时从仓库根目录的 `settings.json` 复制 | **不入库**（含 API Key） |
| `songs/` | 同上，从 `songs/` 复制示例曲 | 入库 |

## 为什么要这样

`settings.json` 里有大模型 API Key，属于密钥，不提交到 GitHub。
打包脚本会在打 exe 时现场复制一份到本目录，打包完成后这份副本仍然带着 Key，
所以它被 `.gitignore` 排除在外。

## 新克隆的仓库怎么打包

仓库里没有 `settings.json`，`build_exe.ps1` 会自动退回用 `settings.example.json`
（不含 Key，模型走本地话术大脑）。想用自己的 Key，先复制模板再填：

```powershell
Copy-Item settings.example.json settings.json
# 编辑 settings.json，填 api_key / douyin.live_url
.\build_exe.ps1
```
