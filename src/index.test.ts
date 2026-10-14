import { describe, expect, it } from "vitest";
import entry from "./index.js";
import { getToolPluginMetadata } from "openclaw/plugin-sdk/tool-plugin";

describe("harness-bridge", () => {
  it("declares the five MVP tools", () => {
    expect(getToolPluginMetadata(entry)?.tools.map((t) => t.name).sort()).toEqual([
      "harness_list",
      "harness_mount",
      "harness_run",
      "harness_status",
      "harness_sync_models",
    ]);
  });
});
