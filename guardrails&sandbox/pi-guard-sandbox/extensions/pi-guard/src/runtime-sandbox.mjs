function getDependencyError(checkResult) {
  if (checkResult === true) return null;
  if (checkResult === false) return "Sandbox runtime dependencies are unavailable.";
  if (checkResult && typeof checkResult === "object") {
    const errors = Array.isArray(checkResult.errors) ? checkResult.errors.filter(Boolean) : [];
    if (errors.length > 0) {
      return `Sandbox dependencies missing: ${errors.join(", ")}`;
    }
    const warnings = Array.isArray(checkResult.warnings) ? checkResult.warnings.filter(Boolean) : [];
    if (warnings.length > 0) return null;
  }
  return null;
}

function injectMaskArgs(bwrapCommand, extraMaskPaths) {
  const lastDashDash = bwrapCommand.lastIndexOf(" -- ");
  if (lastDashDash === -1) return bwrapCommand;
  const prefix = bwrapCommand.slice(0, lastDashDash);
  const suffix = bwrapCommand.slice(lastDashDash);
  const maskArgs = [];
  for (const { path: p, isDir } of extraMaskPaths) {
    if (isDir) {
      maskArgs.push("--tmpfs", p);
    } else {
      maskArgs.push("--ro-bind", "/dev/null", p);
    }
  }
  if (maskArgs.length === 0) return bwrapCommand;
  return prefix + " " + maskArgs.join(" ") + suffix;
}

const VENDOR_PATH = new URL("../vendor/sandbox-runtime/index.js", import.meta.url).pathname;

export async function createRuntimeSandboxAdapter(runtimeOverride) {
  const runtime = runtimeOverride ?? await import(VENDOR_PATH);
  const { SandboxManager } = runtime;
  let initialized = false;

  return {
    async apply(config) {
      const dependencyError = getDependencyError(SandboxManager.checkDependencies(config.ripgrep));
      if (dependencyError) {
        throw new Error(dependencyError);
      }
      if (!initialized) {
        await SandboxManager.initialize(config);
        initialized = true;
      } else {
        SandboxManager.updateConfig(config);
      }
    },
    async wrap(command, extraMaskPaths = []) {
      let wrapped = await SandboxManager.wrapWithSandbox(command, undefined, undefined);
      if (extraMaskPaths.length > 0) {
        wrapped = injectMaskArgs(wrapped, extraMaskPaths);
      }
      return wrapped;
    },
    async reset() {
      if (!initialized) return;
      await SandboxManager.reset();
      initialized = false;
    },
  };
}
