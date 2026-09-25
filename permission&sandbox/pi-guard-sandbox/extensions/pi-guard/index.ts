import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashTool, createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import { createRuntimeSandboxAdapter } from "./src/runtime-sandbox.mjs";
import { createDcgClient } from "./src/dcg.mjs";
import { registerPiGuard } from "./src/extension.mjs";

export default function (pi: ExtensionAPI) {
  registerPiGuard(pi, {
    createSandbox: createRuntimeSandboxAdapter,
    createLocalOps: createLocalBashOperations,
    createBashTool,
    createDcgClient,
  });
}
