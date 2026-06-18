# Shared Claude Terminal v0.1.0

First public release of `shared-claude-terminal`.

## Overview

`shared-claude-terminal` is a local browser terminal bridge for Claude Code on Windows. It starts Claude in a PTY, streams the terminal to a local web UI, and exposes simple HTTP APIs so Codex or other local tools can keep talking to the same Claude session.

This release is aimed at a practical workflow:

- Watch Claude output live in a browser or Codex in-app Browser
- Type into the same terminal manually at any time
- Keep or disable Claude history depending on the task
- Continue the current conversation, start a new one, or reopen a saved session
- Send input and control keys through local APIs instead of desktop automation

## Highlights

- Windows-friendly local bridge built with `node-pty`
- Browser terminal UI built with `xterm.js`
- Real-time terminal output via WebSocket
- HTTP APIs for input, key events, status, restart, models, and session management
- Default workflow keeps chat history on and continues the current Claude session
- Session picker for opening, reloading, and deleting saved conversations
- Model and effort controls from the web UI
- White theme UI tuned for side-panel use inside Codex
- Scroll behavior and scrollbar hit area improved for long chat history browsing

## Included in this release

Source repository:

- `server.js`
- `public/index.html`
- `package.json`
- `README.md`

Release asset:

- `shared-claude-terminal-delivery.zip`

## Quick start

```powershell
npm install
npm start
```

Then open:

```text
http://127.0.0.1:4317/
```

## Notes

- This tool is designed for local use on your own machine.
- It does not rely on Windows Terminal automation or Codex UI automation.
- Claude must already be available on the machine as a callable `claude` command.

