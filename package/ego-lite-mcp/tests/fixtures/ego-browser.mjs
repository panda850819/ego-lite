// Executed by the stdio integration tests, once per generated script.
// Expose only one installed SDK surface so missing globals cannot be masked.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";

assert.equal(process.argv[2], "nodejs");
const statePath = process.env.EGO_MCP_TEST_STATE;
const state = JSON.parse(readFileSync(statePath, "utf8"));
const legacy = process.env.EGO_MCP_TEST_RUNTIME === "flat";
const record = (name, ...args) => state.calls.push({ name, args });
const info = async () => ({
  url: "https://example.com/",
  title: "Example Domain",
});
const list = async () => state.spaces;
const select = async (name) => {
  record("switch", name);
  const space = state.spaces.find((space) => space.name === name);
  assert.ok(space);
  if (state.controlError) throw new Error("user is controlling");
  return space;
};
const create = async (name) => {
  record("create", name);
  const space = { id: 44, name, ownership: state.newOwnership ?? "agent" };
  state.spaces.push(space);
  // Native creation can omit ownership even though list() includes it.
  return legacy || state.omitCreationOwnership
    ? { id: space.id, name: space.name }
    : space;
};
const tabs = async () => [
  { targetId: "test-tab", url: "https://example.com/" },
];
const open = async (url, options) => {
  assert.equal(options.wait, true);
  // Facades use milliseconds; the installed flat helpers use seconds.
  assert.equal(options.timeout, legacy ? 20 : 20_000);
  record("open", url, options);
  return (await tabs())[0];
};
const snapshot = async () =>
  state.snapshot ?? "heading Example Domain\nlink Learn more";
const click = async (target) => {
  record("click", target);
};
const fill = async (target, text) => {
  record("fill", target, text);
};
const press = async (key) => {
  record("press", key);
};
const wheel = async (dx, dy) => {
  record("wheel", dx, dy);
};
// The installed CLI forwards its output (including cliLog) to stderr.
const output = (value) => process.stderr.write(`${value}\n`);
const bindings = legacy
  ? {
      listTaskSpaces: list,
      switchTaskSpace: select,
      useOrCreateTaskSpace: create,
      listTabs: tabs,
      openOrReuseTab: open,
      snapshotText: snapshot,
      pageInfo: info,
      click,
      fillInput: fill,
      pressKey: press,
      scroll: async (options) => {
        assert.deepEqual(options, { dy: 500 });
        await wheel(0, options.dy);
      },
      cliLog: output,
    }
  : {
      taskSpaces: { list, switch: select, useOrCreate: create },
      browser: { listTabs: tabs, openOrReuseTab: open },
      page: {
        info,
        snapshot,
        locator: (target) => ({
          click: () => click(target),
          fill: (text) => fill(target, text),
        }),
        keyboard: { press },
        mouse: { wheel },
      },
    };

try {
  const script = readFileSync(0, "utf8");
  // Preserve the installed CLI's classic-script ambiguity: `await (expr)`
  // parses as a call to an identifier named await, unlike `await helper()`.
  let classic;
  try {
    classic = new Function(...Object.keys(bindings), script);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  if (classic) {
    await classic(...Object.values(bindings));
  } else {
    const AsyncFunction = Object.getPrototypeOf(
      async function () {},
    ).constructor;
    await new AsyncFunction(...Object.keys(bindings), script)(
      ...Object.values(bindings),
    );
  }
} finally {
  writeFileSync(statePath, JSON.stringify(state));
}
