// Generic wedged-child fixture for tests/support/fault-injection.ts (#1838).
//
// Pauses its stdin immediately and keeps a harmless interval alive. The
// keepalive is the load-bearing half (the #1811 lesson): with `pause()` alone
// and no other active handle, Node decides the event loop is empty and exits
// the child within milliseconds — every subsequent parent write then fails
// FAST with EPIPE/EOF instead of genuinely hanging, so a test built on that
// passes for the wrong reason (a fast rejection, not an unbounded await).
// The interval keeps the process, and its unread stdin pipe, open like a real
// wedged server whose main loop is busy elsewhere.
//
// This child NEVER reads stdin and NEVER exits on its own. The parent is
// responsible for killing it (`WedgedChild.kill()` from the kit).

process.stdin.pause();
setInterval(() => {}, 60_000);
