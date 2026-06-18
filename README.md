# Shared Claude Terminal

这是一个在本机浏览器里显示并控制同一个 Claude Code 终端进程的小工具。Codex 可以通过 HTTP API 给 Claude 发送输入，也可以把这个页面展示在 Codex 的 in-app Browser 侧边栏里，让用户直接看到 Claude 当前在做什么。

## 实现思路

核心文件只有两个：

- `server.js`：启动 Express HTTP 服务、WebSocket 服务和 Claude Code 的 PTY 进程。
- `public/index.html`：基于 xterm.js 的网页终端界面，包含会话、历史、模型、推理能力和常用按键按钮。

启动后，`server.js` 会在 `127.0.0.1:4317` 提供页面和 API，并用 `node-pty` 启动 `claude` 命令。终端输出会写入内存缓冲区，再通过 WebSocket 广播给网页。网页输入、按钮点击和窗口 resize 会通过 WebSocket 或 HTTP API 传回后端，再写入 Claude 的 PTY。

会话记录来自 Claude Code 自己的 `~/.claude/projects` 和 `~/.claude/sessions`。网页里的 `Session` 控件只是读取、恢复或删除这些已有记录；切换历史模式、打开历史会话或新建会话时会重启 Claude 进程。

模型切换不重启 Claude。`Model` 下拉框列出内置模型命令，点击 `Use` 会发送对应的 `/model <model-id>` 到当前 Claude 终端。`Menu` 会发送 `/model`，打开 Claude Code 自带的模型选择界面。命令行启动时仍然可以用 `--model` 指定初始模型，这只影响启动参数。

推理能力按钮 `Effort` 会发送 `/effort`，打开 Claude Code 自带的推理能力选择界面。

## 需要配合的 Skill

推荐配合这些 Codex skill 使用：

- `$shared-claude-bridge`：默认桥接入口。用户说“Claude交流”“问 Claude”“让 Claude 看看”“把这个发给 Claude”时，Codex 应通过这个工具页和 API 与 Claude 交流。
- `$frontend-design`：修改网页工具栏、按钮、尺寸、布局和视觉细节时使用。
- `browser:control-in-app-browser`：在 Codex 的 in-app Browser 侧边栏打开、刷新和检查 `http://127.0.0.1:4317/`。

当前默认行为应是：使用当前 Codex 工作目录，保留 Claude 历史，继续当前 Claude 会话，并把网页终端展示在 Codex 侧边栏；除非用户明确要求后台模式、临时对话、新对话或指定历史会话。

## 启动方式

```powershell
cd /d D:\codexuseclaude\shared-claude-terminal
npm install
node server.js --cwd "C:\Users\Administrator\Documents\Codex\2026-06-16\claude-hi"
```

也可以用 npm 脚本：

```powershell
npm start -- --cwd "C:\path\to\workspace"
```

不保存 Claude 历史：

```powershell
npm run start:ephemeral -- --cwd "C:\path\to\workspace"
```

启动时指定模型：

```powershell
node server.js --cwd "C:\path\to\workspace" --model claude-opus-4-7
```

然后打开：

```text
http://127.0.0.1:4317/
```

## 页面用法

- `Session`：选择当前目录下的 Claude 历史会话。
- `New`：重启为新对话。
- `Open`：重启并恢复选中的历史会话。
- `Delete`：删除选中的历史会话记录。
- `Reload`：重新读取历史会话列表。
- `History`：开关 Claude 历史保存；切换会重启 Claude。
- `Model`：选择内置模型命令，例如 `claude-opus-4-7`。
- `Use`：向当前 Claude 终端发送 `/model <model-id>`，不重启。
- `Menu`：发送 `/model`，打开 Claude 原生模型选择界面。
- `Effort`：发送 `/effort`，打开 Claude 原生推理能力选择界面。
- `Enter`、`Ctrl+C`、`Esc`：发送常用控制键。
- `Clear`：只清空网页终端显示，不清空 Claude 会话。
- `Restart`：重启 Claude 进程。

## API

读取状态：

```powershell
Invoke-RestMethod http://127.0.0.1:4317/api/status
```

发送文本到 Claude：

```powershell
Invoke-RestMethod http://127.0.0.1:4317/api/input -Method Post -ContentType "application/json" -Body '{"text":"hi`r"}'
```

发送按键：

```powershell
Invoke-RestMethod http://127.0.0.1:4317/api/key -Method Post -ContentType "application/json" -Body '{"key":"Ctrl+C"}'
```

发送模型命令，不重启：

```powershell
Invoke-RestMethod http://127.0.0.1:4317/api/model -Method Post -ContentType "application/json" -Body '{"model":"claude-opus-4-7"}'
```

打开 Claude 原生模型菜单：

```powershell
Invoke-RestMethod http://127.0.0.1:4317/api/model -Method Post -ContentType "application/json" -Body '{"model":null}'
```

列出内置模型：

```powershell
Invoke-RestMethod http://127.0.0.1:4317/api/models
```

重启 Claude：

```powershell
Invoke-RestMethod http://127.0.0.1:4317/api/restart -Method Post
```

恢复指定历史会话：

```powershell
Invoke-RestMethod http://127.0.0.1:4317/api/restart -Method Post -ContentType "application/json" -Body '{"resumeSessionId":"SESSION_ID"}'
```

## 模型列表说明

网页当前使用内置静态列表，不扫描账号权限，也不额外调用 Claude 做探测。这样打开页面更快，也不会因为扫描模型产生额外请求。

内置列表包含：

- `opus`
- `claude-opus-4-8`
- `claude-opus-4-8[1m]`
- `claude-opus-4-7`
- `claude-opus-4-7[1m]`
- `claude-opus-4-6`
- `claude-opus-4-6[1m]`
- `sonnet`
- `claude-sonnet-4-6`
- `claude-sonnet-4-6[1m]`
- `haiku`
- `claude-haiku-4-5`
- `fable`
- `claude-fable-5`
- `claude-fable-5[1m]`

如果某个模型不是当前账号可用的，Claude Code 会在终端里显示自己的错误或提示；这个工具不会在点击前预先拦截。
