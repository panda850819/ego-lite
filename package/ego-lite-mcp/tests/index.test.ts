import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";
import {
  handleMcpRequest,
  runEgoBrowser,
  scriptForTool,
} from "../src/index.ts";

function resultOf(response: Awaited<ReturnType<typeof handleMcpRequest>>) {
  return response?.result as
    | { content?: Array<{ text?: string }>; isError?: boolean }
    | undefined;
}

function expectParseableScript(script: string): void {
  expect(
    () => new Function(`return (async () => {\n${script}\n})();`),
  ).not.toThrow();
}

async function withExecutable(
  contents: string,
  callback: (binary: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "ego-lite-mcp-"));
  const binary = join(directory, "ego-browser");
  await writeFile(binary, contents, { mode: 0o755 });
  try {
    await callback(binary);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("ego-lite-mcp", () => {
  it("supports modern discovery and the legacy initialize handshake", async () => {
    const discovery = await handleMcpRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "server/discover",
    });
    expect(
      (discovery?.result as { supportedVersions: string[] }).supportedVersions,
    ).toEqual(["2026-07-28"]);

    const initialize = await handleMcpRequest({
      jsonrpc: "2.0",
      id: 2,
      method: "initialize",
      params: { protocolVersion: "2025-11-25" },
    });
    expect(
      (initialize?.result as { protocolVersion: string }).protocolVersion,
    ).toBe("2025-11-25");

    const unsupported = await handleMcpRequest({
      jsonrpc: "2.0",
      id: 3,
      method: "initialize",
      params: { protocolVersion: "2026-07-28" },
    });
    expect(unsupported?.error?.code).toBe(-32602);
  });

  it("discovers only constrained semantic browser tools", async () => {
    const response = await handleMcpRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    const tools = (
      response?.result as { tools: Array<{ name: string }> }
    ).tools.map((tool) => tool.name);

    expect(tools).toEqual([
      "browser_list_spaces",
      "browser_list_tabs",
      "browser_open",
      "browser_snapshot",
      "browser_page_info",
      "browser_click",
      "browser_fill",
      "browser_press_key",
      "browser_scroll",
    ]);
    expect(
      tools.some((tool) => /(?:js|cdp|shell|fetch|upload|execute)/i.test(tool)),
    ).toBe(false);
  });

  it("uses the current Ego Lite nodejs facade APIs", () => {
    const scripts = [
      scriptForTool("browser_list_spaces", {}),
      scriptForTool("browser_list_tabs", { task: "research" }),
      scriptForTool("browser_open", {
        task: "research",
        url: "https://example.com",
      }),
      scriptForTool("browser_snapshot", { task: "research" }),
      scriptForTool("browser_page_info", { task: "research" }),
      scriptForTool("browser_click", { task: "research", target: "@12" }),
      scriptForTool("browser_fill", {
        task: "research",
        target: "loc=Email",
        text: "panda@example.com",
      }),
      scriptForTool("browser_press_key", { task: "research", key: "Enter" }),
      scriptForTool("browser_scroll", { task: "research", dy: 500 }),
    ];

    for (const script of scripts) {
      expectParseableScript(script);
      expect(script).not.toMatch(
        /\b(?:browserJs|browserCdp|serverFetch|browserFetch|uploadFile|cliLog|fillInput|pageInfo)\s*\(/,
      );
    }
    expect(scripts.join("\n")).toContain("taskSpaces.useOrCreate");
    expect(scripts.join("\n")).toContain("browser.openOrReuseTab");
    expect(scripts.join("\n")).toContain("page.locator");
    expect(scripts.join("\n")).toContain("page.snapshot()");
    expect(scripts.join("\n")).toContain("page.info()");
    expect(scripts.join("\n")).toContain("console.log");
  });

  it("serializes every user-controlled script value", () => {
    const malicious = `"; throw new Error('pwned'); //`;
    const cases = [
      [
        "browser_open",
        { task: malicious, url: `https://example.com/');process.exit()//` },
      ],
      ["browser_snapshot", { task: malicious }],
      ["browser_click", { task: malicious, target: malicious }],
      [
        "browser_fill",
        {
          task: malicious,
          target: malicious,
          text: `${malicious}\nsecond line`,
        },
      ],
      ["browser_press_key", { task: malicious, key: malicious }],
      ["browser_scroll", { task: malicious, dy: 1 }],
    ] as const;

    for (const [name, args] of cases) {
      const script = scriptForTool(name, args);
      expectParseableScript(script);
      expect(script).toContain(JSON.stringify(`ego-lite-mcp:${malicious}`));
      if (name === "browser_open") {
        expect(script).toContain(JSON.stringify(args.url));
      }
      if (name === "browser_fill") {
        expect(script).toContain(JSON.stringify(args.target));
        expect(script).toContain(JSON.stringify(args.text));
      }
      if (name === "browser_click") {
        expect(script).toContain(JSON.stringify(args.target));
      }
      if (name === "browser_press_key") {
        expect(script).toContain(JSON.stringify(args.key));
      }
    }
  });

  it("rejects unsafe navigation schemes and embedded credentials", () => {
    for (const url of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "data:text/plain,secret",
      "chrome://settings",
      "about:blank",
      "ftp://example.com/file",
    ]) {
      expect(() => scriptForTool("browser_open", { url })).toThrow(
        "only http:// and https:// URLs are allowed",
      );
    }
    expect(() =>
      scriptForTool("browser_open", {
        url: "https://user:password@example.com",
      }),
    ).toThrow("embedded credentials");
    expect(() =>
      scriptForTool("browser_open", { url: "https://example.com" }),
    ).not.toThrow();
    expect(() =>
      scriptForTool("browser_open", { url: "HTTP://example.com/path" }),
    ).not.toThrow();
  });

  it("isolates and verifies task-space ownership without taking over user spaces", () => {
    const script = scriptForTool("browser_snapshot", { task: "pond-research" });

    expect(script).toContain("ego-lite-mcp:pond-research");
    expect(script).toContain("taskSpaces.list()");
    expect(script).toContain("taskSpaces.useOrCreate");
    expect(script).toContain("taskSpaces.switch");
    expect(script).toContain("space?.ownership === 'agent'");
    expect(script).toContain("space?.ownership === 'agentDelegatedToUser'");
    expect(script).toContain("non-agent-owned");
    expect(script).not.toContain("claimTaskSpace");
    expect(script).not.toContain("takeOverTaskSpace");

    const spacesScript = scriptForTool("browser_list_spaces", {});
    expect(spacesScript).toContain('startsWith("ego-lite-mcp:")');
    expect(spacesScript).toContain("space.ownership === 'agent'");
  });

  it("refuses an existing user-owned space before selecting it", async () => {
    let selected = 0;
    let created = 0;
    const execute = new Function(
      "taskSpaces",
      "page",
      "console",
      `return (async () => {${scriptForTool("browser_snapshot", { task: "research" })}})();`,
    ) as (
      taskSpaces: Record<string, unknown>,
      page: Record<string, unknown>,
      console: Record<string, unknown>,
    ) => Promise<unknown>;

    await expect(
      execute(
        {
          list: async () => [
            { name: "ego-lite-mcp:research", ownership: "user" },
          ],
          switch: async () => {
            selected += 1;
          },
          useOrCreate: async () => {
            created += 1;
          },
        },
        {},
        {},
      ),
    ).rejects.toThrow("non-agent-owned");
    expect(selected).toBe(0);
    expect(created).toBe(0);
  });

  it("uses switch for an existing agent-owned space and emits a marked result", async () => {
    const logs: string[] = [];
    let switched = 0;
    const execute = new Function(
      "taskSpaces",
      "page",
      "console",
      `return (async () => {${scriptForTool("browser_page_info", { task: "research" })}})();`,
    ) as (
      taskSpaces: Record<string, unknown>,
      page: Record<string, unknown>,
      console: { log: (value: string) => void },
    ) => Promise<unknown>;

    await execute(
      {
        list: async () => [
          { name: "ego-lite-mcp:research", ownership: "agent" },
        ],
        switch: async () => {
          switched += 1;
          return { name: "ego-lite-mcp:research", ownership: "agent" };
        },
        useOrCreate: async () => {
          throw new Error("must not create an existing task");
        },
      },
      { info: async () => ({ url: "https://example.com" }) },
      { log: (value) => logs.push(value) },
    );

    expect(switched).toBe(1);
    expect(JSON.parse(logs[0])).toMatchObject({
      __egoLiteMcp: true,
      ok: true,
      result: { url: "https://example.com" },
    });
  });

  it("bounds and validates structured tool arguments", () => {
    expect(() => scriptForTool("browser_scroll", { dy: 1.5 })).toThrow(
      "dy must be an integer",
    );
    expect(() => scriptForTool("browser_scroll", { dy: 10_001 })).toThrow(
      "dy must be an integer",
    );
    expect(() =>
      scriptForTool("browser_click", { target: "button", unexpected: true }),
    ).toThrow("unexpected property unexpected");
    expect(() =>
      scriptForTool("browser_click", { target: "button\nsubmit" }),
    ).toThrow("contains control characters");
    expect(() =>
      scriptForTool("browser_snapshot", { task: "a".repeat(81) }),
    ).toThrow("task must be at most 80 characters");

    const unicode = scriptForTool("browser_fill", {
      task: "research",
      target: "@1",
      text: "first\u2028second\u2029third",
    });
    expectParseableScript(unicode);
    expect(unicode).toContain("\\u2028");
    expect(unicode).toContain("\\u2029");
  });

  it("validates arguments before invoking the runner", async () => {
    let calls = 0;
    const runner = async () => {
      calls += 1;
      return {};
    };

    const invalid = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "browser_open",
          arguments: { url: "file:///etc/passwd" },
        },
      },
      runner,
    );
    expect(resultOf(invalid)?.isError).toBe(true);
    expect(calls).toBe(0);

    const malformed = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "browser_open", arguments: [] },
      },
      runner,
    );
    expect(malformed?.error?.code).toBe(-32602);
    expect(calls).toBe(0);
  });

  it("calls generated scripts through an injected runner", async () => {
    let captured = "";
    const response = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "browser_page_info", arguments: { task: "test" } },
      },
      async (script) => {
        captured = script;
        return { url: "https://example.com", title: "Example" };
      },
    );

    expect(captured).toContain("page.info()");
    expect(captured).toContain("console.log");
    expect(JSON.stringify(response)).toContain("https://example.com");
  });

  it("returns runner failures as tool errors without exposing runner output", async () => {
    const response = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 8,
        method: "tools/call",
        params: { name: "browser_snapshot", arguments: {} },
      },
      async () => {
        throw new Error(
          "runner failed auth_token=super-secret; ct0=another-secret",
        );
      },
    );

    const result = resultOf(response);
    expect(result?.isError).toBe(true);
    expect(result?.content?.[0]?.text).toBe(
      "runner failed auth_token=[REDACTED]; ct0=[REDACTED]",
    );
    expect(JSON.stringify(response)).not.toContain("super-secret");
    expect(JSON.stringify(response)).not.toContain("another-secret");
  });

  it("propagates notifications silently and rejects unknown protocol methods", async () => {
    const notification = await handleMcpRequest({
      jsonrpc: "2.0",
      method: "tools/list",
    });
    expect(notification).toBeNull();

    const response = await handleMcpRequest({
      jsonrpc: "2.0",
      id: 9,
      method: "not-a-method",
    });
    expect(response?.error?.code).toBe(-32601);
  });

  it("invokes the installed ego-browser with the nodejs command and parses its envelope", async () => {
    await withExecutable(
      `#!/bin/sh
if [ "$1" != "nodejs" ]; then
  exit 9
fi
cat >/dev/null
printf '%s\\n' '{"__egoLiteMcp":true,"ok":true,"result":{"invoked":"nodejs"}}'
`,
      async (binary) => {
        await expect(
          runEgoBrowser("console.log(1)", { binary, timeoutMs: 1_000 }),
        ).resolves.toEqual({ invoked: "nodejs" });
      },
    );
  });

  it("reports missing binaries and enforces the runner timeout", async () => {
    await expect(
      runEgoBrowser("", {
        binary: "/definitely/missing/ego-browser",
        timeoutMs: 100,
      }),
    ).rejects.toThrow("executable not found");

    await withExecutable(
      `#!/bin/sh
while :; do :; done
`,
      async (binary) => {
        await expect(
          runEgoBrowser("", { binary, timeoutMs: 25 }),
        ).rejects.toThrow("timed out after 25ms");
      },
    );
  });
});
