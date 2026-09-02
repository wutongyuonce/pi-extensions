// README:142 promises the transcript root is owner-only `0700`. Transcripts
// hold the agent's full conversation — user prompts, file contents, tool output —
// in a shared temp dir, so that mode is the only thing keeping them from every
// other local user. `createOutputFilePath` is mocked in the one wiring test that
// touches it, so this body had never actually executed under test.
//
// This lives in its own file because it must mock `node:os`. The real root is
// `<os-tmpdir>/pi-subagents-<uid>` — one path shared by every worker AND by the
// e2e suites that spawn real agents. Mutating it directly makes the test race
// against anything else writing a transcript (observed: passes alone, fails
// intermittently in the full run). Redirecting `tmpdir()` gives each run its own
// root and removes the shared state entirely.

import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir as realTmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fakeTmp = vi.hoisted(() => ({ dir: "" }));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, tmpdir: () => fakeTmp.dir || actual.tmpdir() };
});

import { createOutputFilePath } from "../src/output-file.js";

const UID = process.getuid?.() ?? 0;
const AGENT = "agent-xyz";
const SESSION = "session-123";

describe("createOutputFilePath", () => {
  let root: string;

  beforeEach(() => {
    // realpath: macOS resolves /var → /private/var, and the module joins the
    // raw tmpdir() value, so comparisons must use the same form.
    fakeTmp.dir = realpathSync(mkdtempSync(join(realTmpdir(), "pi-outpath-")));
    root = join(fakeTmp.dir, `pi-subagents-${UID}`);
  });

  afterEach(() => {
    rmSync(fakeTmp.dir, { recursive: true, force: true });
    fakeTmp.dir = "";
  });

  it("builds the documented layout: <root>/<encoded-cwd>/<session>/tasks/<agent>.output", () => {
    const path = createOutputFilePath("/home/user/project", AGENT, SESSION);
    expect(path).toBe(join(root, "home-user-project", SESSION, "tasks", `${AGENT}.output`));
  });

  it("creates the directory chain so the first write cannot fail", () => {
    const path = createOutputFilePath("/home/user/project", AGENT, SESSION);
    expect(existsSync(join(path, ".."))).toBe(true);
    expect(statSync(join(path, "..")).isDirectory()).toBe(true);
  });

  it("keeps distinct cwds in separate subdirectories under the shared root", () => {
    const a = createOutputFilePath("/home/user/project", AGENT, SESSION);
    const b = createOutputFilePath("/home/user/other", "agent-2", SESSION);
    expect(a).toContain("home-user-project");
    expect(b).toContain("home-user-other");
    expect(a).not.toBe(b);
  });

  it.skipIf(process.platform === "win32")("creates the root owner-only", () => {
    createOutputFilePath("/home/user/project", AGENT, SESSION);
    expect(statSync(root).mode & 0o777).toBe(0o700);
  });

  it.skipIf(process.platform === "win32")("re-tightens a pre-existing world-readable root", () => {
    // The case the explicit chmod exists for. `mkdirSync(recursive: true)` does
    // NOT alter an existing directory's mode, so a root left behind by an older
    // version — or created by anything else under a permissive umask — would
    // keep its wide permissions and every transcript written into it would be
    // readable by every local user. (mkdir's own `mode: 0o700` cannot cover
    // this: umask only clears bits, so a fresh mkdir is never too permissive.)
    mkdirSync(root, { recursive: true, mode: 0o755 });
    chmodSync(root, 0o755); // defeat umask so the premise really holds
    expect(statSync(root).mode & 0o777).toBe(0o755);

    createOutputFilePath("/home/user/project", AGENT, SESSION);

    expect(statSync(root).mode & 0o777).toBe(0o700);
  });
});
