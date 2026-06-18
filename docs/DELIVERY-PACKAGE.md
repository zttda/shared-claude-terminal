# Shared Claude Terminal Delivery Package

这个压缩包用于把 `shared-claude-terminal` 项目和配套 `shared-claude-bridge` skill 一起交付给别人使用。

内容包括：

- `shared-claude-terminal/`
  项目本体和当前依赖。
- `skills/shared-claude-bridge/`
  Codex 调 Claude 时使用的 skill。
- `docs/INSTALL-GUIDE.md`
  详细安装说明书。
- `docs/AGENTS.example.md`
  可直接参考的 AGENTS 规则片段。
- `scripts/`
  环境检查、skill 安装、项目启动脚本。

推荐阅读顺序：

1. `docs/INSTALL-GUIDE.md`
2. `scripts/preflight-check.ps1`
3. `scripts/install-shared-claude-bridge.ps1`
4. `scripts/start-bridge.ps1`
