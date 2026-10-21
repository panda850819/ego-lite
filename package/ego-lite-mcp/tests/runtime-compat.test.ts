import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "bun:test";

// Failure matrix (written before the fix):
// - Missing facade globals must not break any of the nine tools on a flat SDK.
// - A facade-only SDK must not eagerly access missing flat helpers.
// - Navigation timeout units and input/scroll arguments must retain semantics.
// - Each subprocess must reuse the same isolated task; strings stay literal.
// - User-owned spaces stay hidden/unselected, and bad creation ownership fails.
// - Runtime/control errors propagate; never retry through another SDK surface.
// Real-app discoveries added before the corresponding fixes:
// - CLI output can be on stderr, including snapshots exceeding 8 KB.
// - Native creation may omit ownership; verify against list(), never assume it.
// - Parenthesized await alone can be interpreted as a classic-script call.
const adapter = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const fixture = new URL("./fixtures/ego-browser.mjs", import.meta.url);
const owned = { id: 41, name: "ego-lite-mcp:existing", ownership: "agent" };
const delegated = {
  id: 42,
  name: "ego-lite-mcp:delegated",
  ownership: "agentDelegatedToUser",
};
const occupied = { id: 43, name: "ego-lite-mcp:occupied", ownership: "user" };
const unrelated = { id: 40, name: "unrelated", ownership: "agent" };
type Call = [string, Record<string, unknown>];

async function runStdio(runtime: string, calls: Call[], extraState = {}) {
  const directory = await mkdtemp(join(tmpdir(), "ego-mcp-compat-"));
  try {
    const binary = join(directory, "ego-browser");
    const statePath = join(directory, "state.json");
    await writeFile(
      binary,
      `#!${process.execPath}\n${await readFile(fixture, "utf8")}`,
      { mode: 0o755 },
    );
    await writeFile(
      statePath,
      JSON.stringify({
        spaces: [owned, delegated, occupied, unrelated],
        calls: [],
        ...extraState,
      }),
    );
    const requests = [
      {
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: { protocolVersion: "2025-11-25" },
      },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      ...calls.map(([name, args], index) => ({
        jsonrpc: "2.0",
        id: index + 1,
        method: "tools/call",
        params: { name, arguments: args },
      })),
    ];
    const child = spawnSync(process.execPath, ["--no-env-file", adapter], {
      input: `${requests.map((request) => JSON.stringify(request)).join("\n")}\n`,
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        EGO_BROWSER_BIN: binary,
        EGO_MCP_TEST_RUNTIME: runtime,
        EGO_MCP_TEST_STATE: statePath,
      },
    });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    expect(child.stderr).toBe("");
    const responses = child.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(responses).toHaveLength(calls.length + 1);
    expect(responses[0].result.protocolVersion).toBe("2025-11-25");
    responses.forEach((response, index) => expect(response.id).toBe(index));
    return {
      responses: responses.slice(1),
      state: JSON.parse(await readFile(statePath, "utf8")),
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

for (const runtime of ["flat", "facade"]) {
  describe(`stdio adapter with ${runtime} SDK`, () => {
    it("executes all nine tools through the generated-script subprocess boundary", async () => {
      const task = `compat-\"; throw new Error('injected'); //`;
      const target = "@12";
      const text = `\"; throw new Error('injected'); //\nsecond\u2028third\u2029`;
      const { responses, state } = await runStdio(runtime, [
        ["browser_list_spaces", {}],
        ["browser_open", { task, url: "https://example.com" }],
        ["browser_list_tabs", { task }],
        ["browser_snapshot", { task }],
        ["browser_page_info", { task }],
        ["browser_click", { task, target }],
        ["browser_fill", { task, target, text }],
        ["browser_press_key", { task, key: "Enter" }],
        ["browser_scroll", { task, dy: 500 }],
      ]);
      for (const response of responses) {
        expect(response.error).toBeUndefined();
        // Include the entire response in failures, preserving ReferenceError stacks.
        expect(response.result).not.toHaveProperty("isError", true);
      }
      const results = responses.map((response) =>
        JSON.parse(response.result.content[0].text),
      );
      expect(results[0]).toEqual([owned, delegated]);
      expect(results[1].page.title).toBe("Example Domain");
      expect(results[2][0].targetId).toBe("test-tab");
      expect(results[3]).toContain("heading Example Domain");
      for (const result of results.slice(4))
        expect(result.title).toBe("Example Domain");
      const name = `ego-lite-mcp:${task}`;
      expect(state.spaces).toEqual([
        owned,
        delegated,
        occupied,
        unrelated,
        { id: 44, name, ownership: "agent" },
      ]);
      expect(state.calls).toEqual([
        { name: "create", args: [name] },
        {
          name: "open",
          args: [
            "https://example.com/",
            { wait: true, timeout: runtime === "flat" ? 20 : 20_000 },
          ],
        },
        ...Array.from({ length: 3 }, () => ({ name: "switch", args: [name] })),
        { name: "switch", args: [name] },
        { name: "click", args: [target] },
        { name: "switch", args: [name] },
        { name: "fill", args: [target, text] },
        { name: "switch", args: [name] },
        { name: "press", args: ["Enter"] },
        { name: "switch", args: [name] },
        { name: "wheel", args: [0, 500] },
      ]);
    });

    it("refuses user-owned spaces before any selection or browser action", async () => {
      const { responses, state } = await runStdio(runtime, [
        ["browser_snapshot", { task: "occupied" }],
      ]);
      expect(responses[0].result.isError).toBe(true);
      expect(responses[0].result.content[0].text).toContain("non-agent-owned");
      expect(state.calls).toEqual([]);
      expect(state.spaces).toEqual([owned, delegated, occupied, unrelated]);
    });

    it("rejects a newly returned non-agent-owned space before browser actions", async () => {
      const { responses, state } = await runStdio(
        runtime,
        [["browser_open", { task: "new", url: "https://example.com" }]],
        { newOwnership: "user" },
      );
      expect(responses[0].result.isError).toBe(true);
      expect(responses[0].result.content[0].text).toContain(
        "without agent ownership",
      );
      expect(state.calls).toEqual([
        { name: "create", args: ["ego-lite-mcp:new"] },
      ]);
    });

    it("verifies incomplete creation metadata against the task listing", async () => {
      const { responses, state } = await runStdio(
        runtime,
        [["browser_snapshot", { task: "new" }]],
        { omitCreationOwnership: true },
      );
      expect(responses[0].result.isError).toBeUndefined();
      expect(JSON.parse(responses[0].result.content[0].text)).toContain(
        "Example Domain",
      );
      expect(state.calls).toEqual([
        { name: "create", args: ["ego-lite-mcp:new"] },
      ]);
    });

    it("does not infer agent ownership from incomplete creation metadata", async () => {
      const { responses } = await runStdio(
        runtime,
        [["browser_snapshot", { task: "new" }]],
        { omitCreationOwnership: true, newOwnership: "user" },
      );
      expect(responses[0].result.isError).toBe(true);
      expect(responses[0].result.content[0].text).toContain(
        "without agent ownership",
      );
    });

    it("preserves snapshots larger than the stderr diagnostic tail", async () => {
      const snapshot = "Example Domain ".repeat(1_000);
      const { responses } = await runStdio(
        runtime,
        [["browser_snapshot", { task: "existing" }]],
        { snapshot },
      );
      expect(responses[0].result.isError).toBeUndefined();
      expect(JSON.parse(responses[0].result.content[0].text)).toBe(snapshot);
    });

    it("bounds result output on either CLI stream", async () => {
      const { responses } = await runStdio(
        runtime,
        [["browser_snapshot", { task: "existing" }]],
        { snapshot: "x".repeat(8_000_001) },
      );
      expect(responses[0].result.isError).toBe(true);
      expect(responses[0].result.content[0].text).toContain(
        "output exceeded the MCP limit",
      );
    });

    it("propagates control errors without retry, creation, or takeover", async () => {
      const { responses, state } = await runStdio(
        runtime,
        [["browser_snapshot", { task: "delegated" }]],
        { controlError: true },
      );
      expect(responses[0].result.isError).toBe(true);
      expect(responses[0].result.content[0].text).toContain(
        "user is controlling",
      );
      expect(state.calls).toEqual([{ name: "switch", args: [delegated.name] }]);
    });
  });
}
