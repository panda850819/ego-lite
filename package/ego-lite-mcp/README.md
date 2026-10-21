# ego-lite-mcp

Experimental stdio MCP adapter for Ego Lite.

It converts a small typed MCP tool surface into fixed `ego-browser nodejs` scripts. The adapter is intentionally narrower than Ego Lite itself: V1 does **not** expose arbitrary JavaScript, CDP, shell commands, fetch helpers, file upload, or generic command passthrough.

## Requirements

- macOS with Ego Lite installed and onboarding completed
- `ego-browser` available on `PATH` (normally `~/.local/bin/ego-browser`)
- Bun 1.2+

If Ego Lite is not installed, run the repository's macOS installer from the repository root:

```bash
sh skills/ego-browser/scripts/install.sh
```

Complete the GUI onboarding after the app opens. Onboarding registers `ego-browser`; if the command is not found in a new shell, add `~/.local/bin` to `PATH`.

## Run

From this directory:

```bash
bun src/index.ts
```

The process speaks MCP over stdio. An MCP client can configure it similarly to:

```json
{
  "mcpServers": {
    "ego-lite": {
      "command": "bun",
      "args": ["/absolute/path/to/ego-lite/package/ego-lite-mcp/src/index.ts"]
    }
  }
}
```

If `ego-browser` is not on `PATH`, set its executable path. The value is passed as one executable path; it is not parsed as a shell command.

```bash
EGO_BROWSER_BIN="$HOME/.local/bin/ego-browser"
```

Optional runner timeout, in milliseconds (default 30 seconds, maximum 5 minutes):

```bash
EGO_LITE_MCP_TIMEOUT_MS=45000
```

## V1 tools

- `browser_list_spaces`
- `browser_list_tabs`
- `browser_open`
- `browser_snapshot`
- `browser_page_info`
- `browser_click`
- `browser_fill`
- `browser_press_key`
- `browser_scroll`

All normal task names are prefixed with `ego-lite-mcp:` before they are sent to Ego Lite. Existing spaces are checked first and must be agent-owned (`agent` or `agentDelegatedToUser`); user-owned spaces are never claimed or reused. `browser_list_spaces` returns only prefixed, agent-owned spaces.

The generated scripts detect the SDK exposed by the installed `ego-browser`, which can differ from this checkout. They prefer the `taskSpaces` / `browser` / `page` facades when present, and otherwise call the installed flat helpers (`listTaskSpaces`, `switchTaskSpace`, `useOrCreateTaskSpace`, `listTabs`, `openOrReuseTab`, `snapshotText`, `pageInfo`, `click`, `fillInput`, `pressKey`, `scroll`). Results use `cliLog` when available, otherwise `console.log`. The runner accepts the marked JSON envelope from stdout or stderr (the installed CLI may forward output to stderr), with one combined output limit. If native creation omits ownership, the adapter re-reads the exact task id/name and still requires agent ownership before browser actions.

Navigation waits remain 20 seconds on both SDKs: `timeout: 20_000` for the facades, `timeout: 20` for flat helpers. Capability detection happens before the operation; action or ownership/control errors are never retried through a different SDK. No app update or service restart is needed for this compatibility handling.

## Security model

The MCP client never receives generic shell access. Each tool validates structured input and generates a fixed Ego Lite helper script. String values are serialized with `JSON.stringify` before being embedded in the generated JavaScript. Navigation accepts only absolute `http://` and `https://` URLs without embedded credentials.

V1 deliberately excludes:

- `js()` / Runtime.evaluate
- `cdp()`
- `serverFetch()` / `browserFetch()`
- `uploadFile()`
- arbitrary `ego-browser` scripts
- shell execution
- automatic task-space takeover

This is a capability boundary, not a browser sandbox. `browser_click`, `browser_fill`, and keyboard actions can still cause effects on websites when an authenticated session is present, so MCP clients should apply their own approval policy for consequential actions.

## Why an adapter instead of SSH

Ego Lite already provides a local bridge through `ego-browser`. MCP only needs a narrow adapter around that bridge. Giving an agent SSH access to the host would expose unrelated files, credentials, processes, and commands that are unnecessary for browser automation.

## Development

```bash
npm run typecheck
bun test
bun build src/index.ts --target bun --outfile /tmp/ego-lite-mcp.js
```

Tests inject a runner and use temporary fake executables for protocol/runner checks. The stdio integration suite also launches the real adapter and executes its generated scripts in subprocesses exposing only a flat SDK or only a facade SDK. It covers all nine tools, timeout units, literal arguments, task reuse, incomplete creation metadata, ownership refusal, control errors, and bounded stdout/stderr results (including large snapshots). CI does not require Ego Lite or a logged-in browser session.
