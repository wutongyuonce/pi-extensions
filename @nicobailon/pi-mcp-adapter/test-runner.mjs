import crossSpawn from "cross-spawn";

const args = process.argv.slice(2);

function run(script, scriptArgs = []) {
  const commandArgs = ["run", script];
  if (scriptArgs.length > 0) commandArgs.push("--", ...scriptArgs);
  // cross-spawn handles the Windows npm.cmd shim without shell: true.
  const result = crossSpawn.sync("npm", commandArgs, { stdio: "inherit" });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
  return process.exitCode === 0;
}

if (args.length > 0) {
  run("test:vitest", args);
} else if (
  run("test:vitest", ["--exclude", "__tests__/ui-server-browser.test.ts"]) &&
  run("test:vitest", ["__tests__/ui-server-browser.test.ts"])
) {
  run("test:public-exports");
}
