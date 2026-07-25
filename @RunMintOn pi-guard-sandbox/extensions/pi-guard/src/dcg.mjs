import { spawn } from "node:child_process";

export const DEFAULT_DCG_TIMEOUT_MS = 1_000;
export const DEFAULT_DCG_KILL_GRACE_MS = 100;

/** A small injectable boundary around the optional dcg executable. */
export function runProcess(bin, args, {
  timeoutMs = DEFAULT_DCG_TIMEOUT_MS,
  killGraceMs = DEFAULT_DCG_KILL_GRACE_MS,
} = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let timedOut = false;
    let forceKilled = false;
    let timeoutTimer;
    let forceKillTimer;
    let settleTimer;

    const clearTimers = () => {
      clearTimeout(timeoutTimer);
      clearTimeout(forceKillTimer);
      clearTimeout(settleTimer);
    };
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimers();
      resolve({ stdout, ...result });
    };

    let child;
    try {
      child = spawn(bin, args, { stdio: ["ignore", "pipe", "ignore"] });
    } catch (error) {
      finish({ error });
      return;
    }

    child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
    child.on("error", (error) => finish({ error }));
    child.on("close", (code, signal) => finish({ code, signal, timedOut, forceKilled }));

    timeoutTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => {
        forceKilled = true;
        child.kill("SIGKILL");
        // SIGKILL is definitive on Linux/WSL. Do not let a missing close event
        // make the optional integration wait forever.
        settleTimer = setTimeout(() => {
          finish({ code: null, signal: "SIGKILL", timedOut: true, forceKilled: true });
        }, killGraceMs);
      }, killGraceMs);
    }, timeoutMs);
  });
}

function integrationError(reason) {
  return { kind: "error", reason: `DCG integration error: ${reason}` };
}

function errorReason(result, context = "DCG") {
  if (result?.error) return `${context} could not start (${result.error.message ?? result.error}).`;
  if (result?.timedOut) return `${context} timed out.`;
  if (result?.signal) return `${context} was terminated by signal ${result.signal}.`;
  return `${context} exited with code ${result?.code ?? "unknown"}.`;
}

export function parseDcgResult(result) {
  if (result?.error || result?.timedOut || result?.signal || (result?.code !== 0 && result?.code !== 1)) {
    return integrationError(errorReason(result));
  }

  let output;
  try {
    output = JSON.parse(result.stdout);
  } catch {
    return integrationError("DCG returned invalid JSON.");
  }
  const decision = output?.decision;
  if (!new Set(["allow", "deny", "indeterminate"]).has(decision)) return integrationError("DCG returned an unsupported decision.");
  if ((decision === "allow" && result.code !== 0) || (decision !== "allow" && result.code !== 1)) {
    return integrationError("DCG returned an inconsistent exit code and decision.");
  }
  return { kind: decision, output };
}

export function formatDcgReason(output, fallback) {
  const details = [output?.reason, output?.explanation, output?.rule_id && `rule: ${output.rule_id}`, output?.severity && `severity: ${output.severity}`].filter(Boolean);
  return details.length > 0 ? details.join("\n") : fallback;
}

export function parseDcgAvailability(result) {
  if (result?.error?.code === "ENOENT") return { kind: "missing" };
  if (result?.error || result?.timedOut || result?.signal || result?.code !== 0) {
    return { kind: "error", reason: errorReason(result, "DCG availability check") };
  }
  return { kind: "available" };
}

export function createDcgClient({ bin = process.env.DCG_BIN ?? "dcg", run = runProcess, timeoutMs = DEFAULT_DCG_TIMEOUT_MS } = {}) {
  return {
    bin,
    timeoutMs,
    async detect() {
      return parseDcgAvailability(await run(bin, ["--version"], { timeoutMs }));
    },
    async evaluate(command) {
      return parseDcgResult(await run(bin, ["--robot", "test", command], { timeoutMs }));
    },
  };
}
