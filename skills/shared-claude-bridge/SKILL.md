---
name: shared-claude-bridge
description: "Route messages to a local Claude session through `shared-claude-terminal`. Use when the user asks Codex to talk to Claude or relay a message to Claude, especially with phrases such as \"Claude\u4ea4\u6d41\", \"\u95ee Claude\", \"\u8ba9 Claude \u770b\u770b\", \"\u628a\u8fd9\u4e2a\u53d1\u7ed9 Claude\", or \"ask Claude\". Default to the current Codex working directory, keep chat history on, continue the current Claude session, and in Codex desktop show the bridge web UI in the in-app Browser side panel unless the user explicitly asks for background/API-only mode, a temporary conversation, a new conversation, or a specific saved conversation."
---

# Shared Claude Bridge

Use this skill to treat the local `shared-claude-terminal` bridge as the transport between Codex and Claude.

## Workflow

### Fast path for simple relay

- Get `GET /api/status` first and record `status.cursor`.
- If `cwd`, `persistSession`, and session mode already match, skip all restart work: show/reuse the in-app Browser bridge tab, then send the message.
- When reading Claude's reply, prefer `GET /api/output?since=<cursor-before-send>` so only new terminal output is returned. Avoid repeatedly reading the full ANSI terminal buffer.

### 1. Resolve the intent

- Treat multiple messages sent to the same running Claude process as one conversation.
- Start a new Claude conversation only when the user explicitly asks for `new conversation`, `reset Claude`, or the equivalent in another language.
- Resume a specific saved Claude conversation only when the user explicitly asks for a named or selected history item.
- Use temporary mode only when the user explicitly asks for a temporary conversation, asks not to save history, or when there is no reliable working directory.

### 1.5 Resolve local files and images

- When the user asks Codex to ask Claude to review, inspect, audit, or comment on a local file, image, screenshot, document, or code artifact that is inside the shared Claude working directory, assume Claude can access that file path directly from the same workspace.
- In those cases, include the exact file path in the message sent to Claude and explicitly tell Claude to open, inspect, read, or review that file.
- Prefer absolute Windows paths when you already have them. A path relative to the shared working directory is also acceptable when it is shorter and unambiguous.
- If the user mentions multiple files, list each path explicitly in the message to Claude instead of referring to them vaguely as "these files".
- If the user wants Claude to review an image, say clearly that it is an image and name the path, for example: `Please inspect the image at <path> and review it.`
- If the file path appears to be outside the Claude working directory, do not assume Claude can reach it reliably. Either switch Claude to the correct working directory when appropriate or tell the user that the file should be referenced from the shared workspace.

### 1.6 Prefer file-based handoff for long or multilingual content

- If the material to send to Claude is already present in a workspace file, prefer sending Claude the file path and the requested action instead of pasting a large inline block into the terminal.
- If the material is not already in a file and is long enough that inline relay would be fragile, write it to a temporary file inside the shared Claude working directory, then tell Claude to read that file.
- Treat long logs, long code snippets, long notes, large JSON, generated text, or anything beyond a few thousand characters as a candidate for file-based handoff.
- When the content contains Chinese or mixed-language text, prefer file-based handoff over terminal paste whenever practical. This reduces the chance that terminal display or console encoding quirks make the text harder to inspect.
- When creating a temporary handoff file for Claude, save it in a standard text format such as `.md`, `.txt`, `.json`, or source code with the appropriate extension, and keep the path explicit in the prompt sent to Claude.

### 2. Resolve the bridge

- Check `http://127.0.0.1:4317/api/status` first.
- If the bridge is already running and its `cwd`, history mode, and session mode match the request, reuse it.
- If the bridge is unavailable or mismatched, locate it in this order:
  1. `D:\codexuseclaude\shared-claude-terminal`
  2. Search the local machine for a folder named `shared-claude-terminal` that contains `server.js`
- Never use desktop automation, Windows Terminal control, or Codex's own chat UI as the transport.
- Do not open an external terminal or external browser as the user-facing Claude surface. If the bridge must be launched, launch it hidden and show its web UI inside Codex instead.

### 3. Resolve the Claude session settings

- Default Claude's working directory to the current Codex working directory.
- If the user explicitly provides a directory, use that directory instead.
- If no reliable working directory exists, use temporary mode.
- Default `persistSession` to `true`.
- Default to continuing the currently running Claude session for that target directory.
- If the user explicitly asks for a saved conversation, inspect `GET /api/sessions` and choose the matching `sessionId`.
- If the user explicitly asks for a new conversation, use `resumeSessionId = null`.

### 4. Bring the bridge into the requested state

- If the running bridge has the wrong `cwd`, stop the existing bridge process from `<bridge-dir>\server.pid` when possible, then relaunch it from the bridge directory.
- Treat `<bridge-dir>\server.pid` as advisory: it may be stale. If `/api/status` still reports the old `cwd`, find the process that owns local port `4317` and stop it only when its command line contains `server.js`.
- On Windows, use `Get-NetTCPConnection -LocalPort 4317` plus `Get-CimInstance Win32_Process -Filter "ProcessId = <pid>"` to identify the actual bridge process before killing it.
- If `Get-NetTCPConnection` is slow or unavailable on Windows, fall back to `netstat -ano | Select-String ':4317'`, keep only the `LISTENING` PID, then inspect it with `Get-CimInstance Win32_Process`. Avoid using `$pid` as a PowerShell loop variable because `$PID` is read-only; use names such as `$ownerPid`.
- Start commands:
  - Persistent session: `node server.js --cwd "<target-cwd>"`
  - Temporary session: `node server.js --cwd "<target-cwd>" --no-session-persistence`
- After starting, poll `GET /api/status` until `alive`, `cwd`, and `persistSession` match. If it does not become ready quickly, inspect `/api/status`, `<bridge-dir>\server.log`, `<bridge-dir>\server.err.log`, and the port owner instead of retrying blind restarts.
- Use `POST /api/restart` only for changes supported by the running bridge:
  - `persistSession`
  - `resumeSessionId`
- Do not assume `POST /api/restart` can change `cwd`; relaunch the bridge when `cwd` must change.

### 5. Present the bridge UI in Codex

- In the Codex desktop app, showing the `shared-claude-terminal` web UI in the in-app Browser side panel is the default and required presentation mode.
- After the bridge is in the requested state and before sending the real message, open the bridge web UI, normally `http://127.0.0.1:4317/`, in the in-app Browser and set Browser visibility to `true`.
- Reuse an existing in-app Browser tab already showing the bridge URL when possible; otherwise create a new tab and navigate it to the bridge URL. Do not rely on a selected tab existing; `browser.tabs.selected()` may fail when no active tab exists.
- Keep the side-panel UI visible while sending and receiving the Claude message so the user can watch the Claude terminal session from the current Codex conversation.
- Skip the visible side-panel UI only when the user explicitly asks for background mode, API-only mode, no UI, or text relay only.
- If the in-app Browser cannot be shown, tell the user and ask before falling back to API-only relay.

### 6. Keep the user looped in

- Before sending the real message, tell the user in one sentence:
  - which Claude `cwd` will be used
  - whether history is on or off
  - whether you are continuing the current session, starting a new conversation, or resuming a specific saved conversation
  - that the bridge UI is visible in the Codex in-app Browser side panel, unless the user explicitly chose background/API-only mode

### 7. Exchange messages with Claude

- Before sending, record the current cursor from `GET /api/status`. Treat that cursor as the boundary between "before send" and "after send".
- Send text with `POST /api/input`.
- For ordinary relay requests, terminate the submitted text with `\r` so it executes immediately.
- Do not leave a relayed message sitting in the terminal input as a draft. After pasting or posting the text, make sure Claude actually receives it by including `\r` in the same send or by sending `Enter` immediately after.
- Only omit the trailing `\r` when the user explicitly wants a draft left in the input box or explicitly wants Codex to stop before submission.
- First confirm that the message was actually submitted before switching to "wait for Claude's reply" mode.
- Treat a successful `POST /api/input` response with `ok: true` and a positive `wrote` count as the first send acknowledgment.
- After that, do one immediate verification pass with `GET /api/output?since=<cursor-before-send>` or `GET /api/status` and confirm that the terminal session has moved forward in some way, for example:
  - the cursor advanced
  - new terminal output appeared
  - the submitted text was echoed
  - Claude showed a trust prompt, spinner, status text, or other fresh terminal activity
- Only after send confirmation should you begin waiting for Claude's substantive reply.
- If there is no sign that the message made it into the session, do not immediately wait for a reply. Instead, inspect whether Claude is sitting at a trust prompt, a stopped prompt, or another blocking state, then resend once if appropriate.
- Use `POST /api/key` for `Enter`, `Ctrl+C`, and similar control keys.
- Read replies with `GET /api/output?since=<cursor>`, where `<cursor>` is from `/api/status` or a prior `/api/output` immediately before the send.
- If Claude first opens a trust prompt for the exact requested workspace and the user has asked Codex to use that workspace, send `Enter` once to accept the default "Yes, I trust this folder" selection, then continue. If the workspace is unexpected or not clearly authorized, ask the user before accepting.
- When accepting a first-run trust prompt, assume any message sent before the prompt was accepted may have been consumed by the prompt UI rather than submitted to Claude. After accepting trust, record a fresh cursor and resend the user's intended message once.
- Claude Code output may first contain only the submitted prompt and spinner/status text such as `Ruminating`. Keep polling `GET /api/output?since=<last-cursor>` until a substantive reply appears, the prompt returns, or a real timeout is reached.
- Do not assume failure just because Claude takes several minutes to reply. For review, audit, or file-inspection tasks, Claude may take many minutes before returning a substantive answer.
- For long-running Claude work, keep polling incrementally and treat continued spinner/status output, ongoing terminal activity, or the absence of a returned prompt as "still working" rather than "timed out".
- Use a generous wait budget for long Claude tasks. Unless the user asks to stop sooner, continue waiting and polling for up to about 20 minutes before treating the run as stalled.
- If the wait is long, give the user a short progress update such as "Claude is still working on it; I'm keeping the session open and waiting for the reply," then continue polling instead of abandoning the exchange.
- If Claude eventually returns to the prompt without a substantive answer, inspect the new output carefully before deciding whether to resend, clarify, or report back.
- Keep the in-app Browser side-panel UI visible during this exchange by default; the API is the transport, and the side-panel web terminal is the user-facing view.
- When relaying a task that depends on local files, do not send a vague message such as "please review this". Send a self-contained prompt that names the file path and the requested action, for example: `Please review C:\\path\\to\\image.png and comment on composition issues.`
- If the task is likely to produce a very long Claude reply, ask Claude to save the full output to a file inside the shared working directory and return only a short terminal summary plus the output file path.
- For long reviews or long reports, prefer prompts such as: `Write the full review to <path>, then reply here with a short summary and the file path.`
- After Claude writes a long result to a file, have Codex read that file directly rather than relying only on the terminal buffer.

### 8. Manage Claude history only when asked

- Use `GET /api/sessions` to inspect saved conversations for the current Claude working directory.
- Use `DELETE /api/sessions/:sessionId` only when the user explicitly asks to delete a saved conversation.
- Remember: sending another prompt such as `hello` to the same running Claude process does not create a new conversation by itself.

### 9. Handle failures narrowly

- Ask the user one short question only if you cannot locate or start the bridge automatically.
- If Claude is busy and the user asks to interrupt, send `Ctrl+C`.
