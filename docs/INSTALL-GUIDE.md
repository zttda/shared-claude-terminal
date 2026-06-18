# Shared Claude Terminal 安装说明书

## 1. 这份压缩包包含什么

这份包包含三部分：

- `shared-claude-terminal/`
  网页终端项目本体。
- `skills/shared-claude-bridge/`
  Codex 用来把消息转给 Claude 的 skill。
- `scripts/`
  环境检查、skill 安装和启动脚本。

## 2. 前置环境

目标机器建议满足这些条件：

1. Windows。
2. 已安装 `Node.js`，并且 `node`、`npm` 可用。
3. 已安装 `Claude Code`，并且 `claude` 命令可用。
4. 如果要配合 Codex 自动调用 Claude，已安装 Codex desktop。

说明：

- 这份分发包已经带了 `node_modules`，多数情况下不用重新 `npm install`。
- 如果换机器后依赖不兼容，可以在 `shared-claude-terminal/` 里重新执行一次 `npm install`。

## 3. 推荐解压路径

建议解压到一个固定目录，例如：

```text
D:\shared-claude-terminal-delivery
```

后文默认都用这个路径举例。

## 4. 安装步骤

### 4.1 先做环境检查

```powershell
cd D:\shared-claude-terminal-delivery
powershell -ExecutionPolicy Bypass -File .\scripts\preflight-check.ps1
```

这个脚本会检查：

- `node`
- `npm`
- `claude`
- `shared-claude-terminal\server.js`
- `skills\shared-claude-bridge\SKILL.md`
- 4317 端口占用情况

### 4.2 安装 skill

```powershell
cd D:\shared-claude-terminal-delivery
powershell -ExecutionPolicy Bypass -File .\scripts\install-shared-claude-bridge.ps1
```

这个脚本会把 skill 安装到：

```text
%USERPROFILE%\.codex\skills\shared-claude-bridge
```

如果目标位置已有同名 skill，会先备份再覆盖。

### 4.3 配置 AGENTS

如果你希望在某个项目里，当你说“Claude交流”“问 Claude”“让 Claude 看看”“把这个发给 Claude”时，Codex 自动优先走这个 skill，请把 `docs/AGENTS.example.md` 的内容放进目标项目的 `AGENTS.md`。

## 5. 启动桥接项目

### 5.1 用脚本启动

```powershell
cd D:\shared-claude-terminal-delivery
powershell -ExecutionPolicy Bypass -File .\scripts\start-bridge.ps1 -Workspace "D:\your-project"
```

临时会话，不保存历史：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-bridge.ps1 -Workspace "D:\your-project" -NoSessionPersistence
```

切换端口：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-bridge.ps1 -Workspace "D:\your-project" -Port 4321
```

### 5.2 手动启动

```powershell
cd D:\shared-claude-terminal-delivery\shared-claude-terminal
node .\server.js --cwd "D:\your-project"
```

默认页面地址：

```text
http://127.0.0.1:4317/
```

## 6. 页面怎么用

- `Session`
  选择当前目录下的 Claude 历史会话。
- `New`
  重启为新对话。
- `Open`
  重启并恢复历史会话。
- `Delete`
  删除历史会话。
- `Reload`
  刷新历史会话列表。
- `History`
  开关历史保存；切换会重启 Claude。
- `Model`
  选择内置模型命令。
- `Use`
  发送 `/model <model-id>` 到当前 Claude，会立即提交，不重启。
- `Menu`
  发送 `/model`，打开 Claude 原生模型菜单。
- `Effort`
  发送 `/effort`，打开 Claude 原生推理能力菜单。
- `Restart`
  重启 Claude 进程。

## 7. 和 Codex 一起用时的重要规则

这份 skill 当前有两个关键行为：

1. Codex 把消息发给 Claude 时，默认会直接提交。
   不是只把内容粘贴到输入区，而是会连同回车一起发出去。
2. 如果要 Claude 看本地文件、图片、截图或代码文件，并且这些文件就在 Claude 当前工作目录下，Codex 应该把明确的文件路径写进提示词里，并直接要求 Claude 去看这个路径。

推荐这样写请求：

```text
问 Claude：请检查 D:\your-project\output\figure.png，这是一张图，看看构图和标注有没有问题。
```

或者：

```text
把这个发给 Claude：请阅读 D:\your-project\src\app.py，并审查这个文件里的错误处理逻辑。
```

不要只说“帮我看这个图”或“看看这个文件”，最好把路径一起说清楚。

## 8. 模型列表说明

网页内置的是静态模型列表，不会提前扫描账号权限。当前列表包括：

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

如果某个模型当前账号不可用，以 Claude 终端自己的提示为准。

## 9. 常见问题

### 9.1 打不开 127.0.0.1:4317

重新跑：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\preflight-check.ps1
```

先检查 `node`、`claude` 和端口占用。

### 9.2 Claude 看不到文件

优先检查这几件事：

1. 文件是否在 Claude 当前 `--cwd` 工作目录内。
2. 提示词里是否写了明确路径。
3. 是否明确告诉 Claude “请打开/阅读/检查这个文件”。

如果文件不在当前工作目录下，要么把 Claude 切到正确目录启动，要么把文件放进共享工作目录里再让 Claude 看。

### 9.3 依赖不兼容

如果带过去的 `node_modules` 在另一台机器上不可用：

```powershell
cd D:\shared-claude-terminal-delivery\shared-claude-terminal
npm install
```

## 10. 分发方式

可以直接把整个 zip 发给别人。对方只需要：

1. 解压。
2. 跑 `preflight-check.ps1`。
3. 装 skill。
4. 配置 `AGENTS.md`。
5. 启动服务。
6. 打开页面或直接在 Codex 里使用。
