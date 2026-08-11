import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    "agents-memo": "extensions/agents-memo.ts",
    agents: "extensions/agents.ts",
  },
  format: ["esm"],
  dts: false,
  splitting: false,
  sourcemap: true,
  clean: true,
  target: "es2022",
  platform: "node",
  external: [
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-tui",
    "@mariozechner/pi-ai",
    "typebox",
  ],
});
