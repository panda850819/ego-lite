#!/usr/bin/env bun

import { spawn } from "node:child_process";

const MODERN_PROTOCOL_VERSION = "2026-07-28";
const LEGACY_PROTOCOL_VERSION = "2025-11-25";
const SERVER_INFO = { name: "ego-lite-mcp", version: "0.1.0" } as const;
const TASK_SPACE_PREFIX = "ego-lite-mcp:";
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_STDOUT_CHARS = 8_000_000;
const MAX_STDERR_CHARS = 8_000;
const MAX_REQUEST_LINE_LENGTH = 1_000_000;
const MAX_TASK_LENGTH = 80;
const MAX_URL_LENGTH = 2_048;
const MAX_TARGET_LENGTH = 4_096;
const MAX_TEXT_LENGTH = 100_000;
const MAX_KEY_LENGTH = 64;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const COOKIE_FIELD_PATTERN = /(auth_token|ct0)=[^;\s]*/gi;
const CREDENTIAL_ENV_KEYS = [
  "AUTH_TOKEN",
  "CT0",
  "TWITTER_AUTH_TOKEN",
  "TWITTER_CT0",
] as const;

type JsonRpcId = string | number | null;

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: unknown;
};

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

type Runner = (script: string) => Promise<unknown>;

type RunOptions = {
  binary?: string;
  timeoutMs?: number;
};

type StringOptions = {
  allowEmpty?: boolean;
  maxLength?: number;
  rejectControlCharacters?: boolean;
};

const tools = [
  {
    name: "browser_list_spaces",
    description:
      "List MCP-owned Ego Lite task spaces without changing ownership.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "browser_list_tabs",
    description: "List tabs in an MCP-owned Ego Lite task space.",
    annotations: { readOnlyHint: true },
    inputSchema: taskSchema(),
  },
  {
    name: "browser_open",
    description:
      "Open or reuse an HTTP(S) URL in an MCP-owned Ego Lite task space.",
    inputSchema: {
      type: "object",
      properties: {
        task: taskProperty(),
        url: { type: "string", minLength: 1, maxLength: MAX_URL_LENGTH },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_snapshot",
    description: "Return Ego Lite semantic snapshot text for the current tab.",
    annotations: { readOnlyHint: true },
    inputSchema: taskSchema(),
  },
  {
    name: "browser_page_info",
    description:
      "Return URL, title, viewport and dialog state for the current tab.",
    annotations: { readOnlyHint: true },
    inputSchema: taskSchema(),
  },
  {
    name: "browser_click",
    description:
      "Click a semantic Ego Lite target such as @12, CSS, xpath=, or loc=.",
    inputSchema: targetSchema(),
  },
  {
    name: "browser_fill",
    description: "Fill a semantic input target with text.",
    inputSchema: {
      type: "object",
      properties: {
        task: taskProperty(),
        target: { type: "string", minLength: 1, maxLength: MAX_TARGET_LENGTH },
        text: { type: "string", maxLength: MAX_TEXT_LENGTH },
      },
      required: ["target", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_press_key",
    description: "Press one keyboard key in the current Ego Lite tab.",
    inputSchema: {
      type: "object",
      properties: {
        task: taskProperty(),
        key: { type: "string", minLength: 1, maxLength: MAX_KEY_LENGTH },
      },
      required: ["key"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_scroll",
    description: "Scroll vertically by a bounded number of CSS pixels.",
    inputSchema: {
      type: "object",
      properties: {
        task: taskProperty(),
        dy: { type: "integer", minimum: -10_000, maximum: 10_000 },
      },
      required: ["dy"],
      additionalProperties: false,
    },
  },
] as const;

const toolArgumentKeys: Record<string, readonly string[]> = {
  browser_list_spaces: [],
  browser_list_tabs: ["task"],
  browser_open: ["task", "url"],
  browser_snapshot: ["task"],
  browser_page_info: ["task"],
  browser_click: ["task", "target"],
  browser_fill: ["task", "target", "text"],
  browser_press_key: ["task", "key"],
  browser_scroll: ["task", "dy"],
};

function taskProperty() {
  return {
    type: "string",
    minLength: 1,
    maxLength: MAX_TASK_LENGTH,
    description:
      "Logical MCP task name. Names are isolated under the ego-lite-mcp prefix.",
    default: "default",
  };
}

function taskSchema() {
  return {
    type: "object",
    properties: { task: taskProperty() },
    additionalProperties: false,
  };
}

function targetSchema() {
  return {
    type: "object",
    properties: {
      task: taskProperty(),
      target: { type: "string", minLength: 1, maxLength: MAX_TARGET_LENGTH },
    },
    required: ["target"],
    additionalProperties: false,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return (
    value === null ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function parseRequest(value: unknown): JsonRpcRequest | null {
  if (
    !isRecord(value) ||
    value.jsonrpc !== "2.0" ||
    typeof value.method !== "string"
  ) {
    return null;
  }
  if (Object.hasOwn(value, "id") && !isJsonRpcId(value.id)) {
    return null;
  }
  return value as JsonRpcRequest;
}

function requireString(
  args: Record<string, unknown>,
  key: string,
  options: StringOptions = {},
): string {
  const value = args[key];
  const allowEmpty = options.allowEmpty ?? false;
  if (typeof value !== "string" || (!allowEmpty && value.trim().length === 0)) {
    throw new Error(
      `Invalid argument: ${key} must be a ${allowEmpty ? "" : "non-empty "}string.`,
    );
  }
  if (options.maxLength !== undefined && value.length > options.maxLength) {
    throw new Error(
      `Invalid argument: ${key} must be at most ${options.maxLength} characters.`,
    );
  }
  if (
    options.rejectControlCharacters &&
    CONTROL_CHARACTER_PATTERN.test(value)
  ) {
    throw new Error(`Invalid argument: ${key} contains control characters.`);
  }
  return allowEmpty ? value : value.trim();
}

function taskName(args: Record<string, unknown>): string {
  const raw =
    args.task === undefined
      ? "default"
      : requireString(args, "task", {
          maxLength: MAX_TASK_LENGTH,
          rejectControlCharacters: true,
        });
  return `${TASK_SPACE_PREFIX}${raw}`;
}

function requireUrl(args: Record<string, unknown>): string {
  const raw = requireString(args, "url", {
    maxLength: MAX_URL_LENGTH,
    rejectControlCharacters: true,
  });
  if (!/^https?:\/\//i.test(raw)) {
    throw new Error(
      "Invalid argument: only http:// and https:// URLs are allowed.",
    );
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Invalid argument: url must be an absolute URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(
      "Invalid argument: only http:// and https:// URLs are allowed.",
    );
  }
  if (url.username || url.password) {
    throw new Error(
      "Invalid argument: URLs with embedded credentials are not allowed.",
    );
  }
  return url.toString();
}

function requireInteger(
  args: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): number {
  const value = args[key];
  if (
    !Number.isInteger(value) ||
    (value as number) < min ||
    (value as number) > max
  ) {
    throw new Error(
      `Invalid argument: ${key} must be an integer between ${min} and ${max}.`,
    );
  }
  return value as number;
}

function validateToolArguments(
  name: string,
  args: Record<string, unknown>,
): void {
  const allowed = toolArgumentKeys[name];
  if (!allowed) {
    throw new Error(`Unknown tool: ${name}`);
  }
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key)) {
      throw new Error(`Invalid argument: unexpected property ${key}.`);
    }
  }
}

function scriptLiteral(value: string): string {
  return JSON.stringify(value)
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

function emit(expression: string): string {
  return `const __result = await (${expression});\nconsole.log(JSON.stringify({ __egoLiteMcp: true, ok: true, result: __result }));`;
}

function withTask(task: string, body: string): string {
  const taskLiteral = scriptLiteral(task);
  return [
    "const __isAgentOwned = (space) => space?.ownership === 'agent' || space?.ownership === 'agentDelegatedToUser';",
    "const __spaces = await taskSpaces.list();",
    `const __existingTask = __spaces.find((space) => space?.name === ${taskLiteral});`,
    "if (__existingTask && !__isAgentOwned(__existingTask)) { throw new Error('Refusing to use a non-agent-owned Ego Lite task space.'); }",
    `const __task = __existingTask ? await taskSpaces.switch(${taskLiteral}) : await taskSpaces.useOrCreate(${taskLiteral});`,
    "if (!__isAgentOwned(__task)) { throw new Error('Refusing to use a task space without agent ownership.'); }",
    body,
  ].join("\n");
}

export function scriptForTool(
  name: string,
  args: Record<string, unknown>,
): string {
  validateToolArguments(name, args);
  switch (name) {
    case "browser_list_spaces":
      return emit(
        `(await taskSpaces.list()).filter((space) => typeof space?.name === 'string' && space.name.startsWith(${scriptLiteral(TASK_SPACE_PREFIX)}) && (space.ownership === 'agent' || space.ownership === 'agentDelegatedToUser'))`,
      );
    case "browser_list_tabs":
      return withTask(taskName(args), emit("browser.listTabs()"));
    case "browser_open": {
      const task = taskName(args);
      const url = requireUrl(args);
      return withTask(
        task,
        `const __tab = await browser.openOrReuseTab(${scriptLiteral(url)}, { wait: true, timeout: 20_000 });\n${emit("({ tab: __tab, page: await page.info() })")}`,
      );
    }
    case "browser_snapshot":
      return withTask(taskName(args), emit("page.snapshot()"));
    case "browser_page_info":
      return withTask(taskName(args), emit("page.info()"));
    case "browser_click": {
      const target = requireString(args, "target", {
        maxLength: MAX_TARGET_LENGTH,
        rejectControlCharacters: true,
      });
      return withTask(
        taskName(args),
        `await page.locator(${scriptLiteral(target)}).click();\n${emit("page.info()")}`,
      );
    }
    case "browser_fill": {
      const target = requireString(args, "target", {
        maxLength: MAX_TARGET_LENGTH,
        rejectControlCharacters: true,
      });
      const text = requireString(args, "text", {
        allowEmpty: true,
        maxLength: MAX_TEXT_LENGTH,
      });
      return withTask(
        taskName(args),
        `await page.locator(${scriptLiteral(target)}).fill(${scriptLiteral(text)});\n${emit("page.info()")}`,
      );
    }
    case "browser_press_key": {
      const key = requireString(args, "key", {
        maxLength: MAX_KEY_LENGTH,
        rejectControlCharacters: true,
      });
      return withTask(
        taskName(args),
        `await page.keyboard.press(${scriptLiteral(key)});\n${emit("page.info()")}`,
      );
    }
    case "browser_scroll": {
      const dy = requireInteger(args, "dy", -10_000, 10_000);
      return withTask(
        taskName(args),
        `await page.mouse.wheel(0, ${dy});\n${emit("page.info()")}`,
      );
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function configuredTimeout(options: RunOptions): number {
  const candidate =
    options.timeoutMs ??
    Number.parseInt(process.env.EGO_LITE_MCP_TIMEOUT_MS ?? "", 10);
  if (
    Number.isInteger(candidate) &&
    candidate > 0 &&
    candidate <= MAX_TIMEOUT_MS
  ) {
    return candidate;
  }
  return DEFAULT_TIMEOUT_MS;
}

function sanitizeRuntimeText(value: string): string {
  return value.replace(COOKIE_FIELD_PATTERN, "$1=[REDACTED]");
}

function serializeRuntimeResult(value: unknown): string {
  try {
    return sanitizeRuntimeText(JSON.stringify(value) ?? "undefined");
  } catch {
    return "Result could not be serialized.";
  }
}

function childEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const key of CREDENTIAL_ENV_KEYS) {
    delete environment[key];
  }
  return environment;
}

function parseRunnerOutput(stdout: string): unknown {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const parsed: unknown = JSON.parse(lines[index]);
      if (
        isRecord(parsed) &&
        parsed.__egoLiteMcp === true &&
        parsed.ok === true &&
        Object.hasOwn(parsed, "result")
      ) {
        return parsed.result;
      }
    } catch {
      // Ignore non-JSON logs and continue looking for the marked result envelope.
    }
  }
  throw new Error("ego-browser returned no MCP result envelope.");
}

export function runEgoBrowser(
  script: string,
  options: RunOptions = {},
): Promise<unknown> {
  const binary =
    options.binary?.trim() ||
    process.env.EGO_BROWSER_BIN?.trim() ||
    "ego-browser";
  const timeoutMs = configuredTimeout(options);

  return new Promise((resolve, reject) => {
    const child = spawn(binary, ["nodejs"], {
      env: childEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const rejectOnce = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(error);
    };

    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      child.kill("SIGKILL");
      rejectOnce(new Error(`ego-browser timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > MAX_STDOUT_CHARS) {
        child.kill("SIGKILL");
        rejectOnce(new Error("ego-browser output exceeded the MCP limit."));
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-MAX_STDERR_CHARS);
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        rejectOnce(
          new Error(
            "ego-browser executable not found. Install Ego Lite or set EGO_BROWSER_BIN.",
          ),
        );
        return;
      }
      rejectOnce(
        new Error(
          `Could not start ego-browser: ${sanitizeRuntimeText(error.message)}`,
        ),
      );
    });
    child.stdin.on("error", () => {
      // The child close/error event provides the actionable runner failure.
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      clearTimeout(timer);
      if (code !== 0) {
        const detail = sanitizeRuntimeText(stderr.trim());
        rejectOnce(
          new Error(
            `ego-browser exited with code ${code}${detail ? `: ${detail}` : "."}`,
          ),
        );
        return;
      }
      try {
        resolve(parseRunnerOutput(stdout));
        settled = true;
      } catch (error) {
        rejectOnce(error instanceof Error ? error : new Error(String(error)));
      }
    });

    child.stdin.end(`${script}\n`);
  });
}

function modernMeta(): Record<string, unknown> {
  return { "io.modelcontextprotocol/serverInfo": SERVER_INFO };
}

function completeResult(
  result: Record<string, unknown>,
  modern: boolean,
): Record<string, unknown> {
  return modern
    ? { resultType: "complete", ...result, _meta: modernMeta() }
    : result;
}

function success(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function failure(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  };
}

function requestProtocolVersion(request: JsonRpcRequest): string | undefined {
  if (!isRecord(request.params) || !isRecord(request.params._meta)) {
    return undefined;
  }
  const version =
    request.params._meta["io.modelcontextprotocol/protocolVersion"];
  return typeof version === "string" ? version : undefined;
}

function requestParams(request: JsonRpcRequest): Record<string, unknown> {
  if (request.params === undefined) {
    return {};
  }
  if (!isRecord(request.params)) {
    throw new Error("Invalid params: params must be an object.");
  }
  return request.params;
}

function toolArguments(
  params: Record<string, unknown>,
): Record<string, unknown> {
  if (params.arguments === undefined) {
    return {};
  }
  if (!isRecord(params.arguments)) {
    throw new Error("Invalid params: arguments must be an object.");
  }
  return params.arguments;
}

export async function handleMcpRequest(
  request: JsonRpcRequest,
  runner: Runner = runEgoBrowser,
): Promise<JsonRpcResponse | null> {
  const id = request.id ?? null;
  const modern =
    request.method === "server/discover" ||
    requestProtocolVersion(request) === MODERN_PROTOCOL_VERSION;

  if (request.id === undefined) {
    return null;
  }

  let params: Record<string, unknown>;
  try {
    params = requestParams(request);
  } catch (error) {
    return failure(
      id,
      -32602,
      error instanceof Error ? error.message : String(error),
    );
  }

  if (request.method === "server/discover") {
    return success(
      id,
      completeResult(
        {
          supportedVersions: [MODERN_PROTOCOL_VERSION],
          capabilities: { tools: {} },
          instructions:
            "Constrained local Ego Lite browser tools. No arbitrary JavaScript, CDP, shell, fetch, or file upload is exposed.",
        },
        true,
      ),
    );
  }

  if (request.method === "initialize") {
    const requestedVersion = params.protocolVersion;
    if (
      requestedVersion !== undefined &&
      typeof requestedVersion !== "string"
    ) {
      return failure(
        id,
        -32602,
        "Invalid params: protocolVersion must be a string.",
      );
    }
    if (
      typeof requestedVersion === "string" &&
      requestedVersion !== LEGACY_PROTOCOL_VERSION
    ) {
      return failure(
        id,
        -32602,
        `Unsupported protocol version: ${requestedVersion}`,
      );
    }
    return success(id, {
      protocolVersion: LEGACY_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
      instructions: "Constrained local Ego Lite browser tools over stdio.",
    });
  }

  if (request.method === "tools/list") {
    return success(
      id,
      completeResult(
        { tools, ...(modern ? { ttlMs: 60_000, cacheScope: "private" } : {}) },
        modern,
      ),
    );
  }

  if (request.method === "tools/call") {
    const name = typeof params.name === "string" ? params.name : "";
    if (!name) {
      return failure(id, -32602, "Invalid params: missing tool name.");
    }

    let args: Record<string, unknown>;
    try {
      args = toolArguments(params);
    } catch (error) {
      return failure(
        id,
        -32602,
        error instanceof Error ? error.message : String(error),
      );
    }

    try {
      const script = scriptForTool(name, args);
      const data = await runner(script);
      return success(
        id,
        completeResult(
          { content: [{ type: "text", text: serializeRuntimeResult(data) }] },
          modern,
        ),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return success(
        id,
        completeResult(
          {
            content: [{ type: "text", text: sanitizeRuntimeText(message) }],
            isError: true,
          },
          modern,
        ),
      );
    }
  }

  return failure(id, -32601, `Method not found: ${request.method}`);
}

async function run(): Promise<void> {
  process.stdin.setEncoding("utf8");
  let buffer = "";

  const processLine = async (rawLine: string): Promise<void> => {
    if (rawLine.length > MAX_REQUEST_LINE_LENGTH) {
      process.stdout.write(
        `${JSON.stringify(failure(null, -32600, "Request too large"))}\n`,
      );
      return;
    }
    const line = rawLine.trim();
    if (!line) {
      return;
    }

    let response: JsonRpcResponse | null;
    try {
      const parsed = parseRequest(JSON.parse(line));
      response = parsed
        ? await handleMcpRequest(parsed)
        : failure(null, -32600, "Invalid Request");
    } catch {
      response = failure(null, -32700, "Parse error");
    }
    if (response) {
      process.stdout.write(`${JSON.stringify(response)}\n`);
    }
  };

  for await (const chunk of process.stdin) {
    buffer += chunk;
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) {
        break;
      }
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      await processLine(line);
    }
    if (buffer.length > MAX_REQUEST_LINE_LENGTH) {
      process.stdout.write(
        `${JSON.stringify(failure(null, -32600, "Request too large"))}\n`,
      );
      buffer = "";
    }
  }

  if (buffer.trim()) {
    await processLine(buffer);
  }
}

if (import.meta.main) {
  run().catch((error) => {
    console.error(
      `ego-lite-mcp fatal: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
