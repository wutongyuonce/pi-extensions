# Pi Subagents tools

## `subagent_spawn`

| Parameter | Type | Required | Constraint / default |
| --- | --- | --- | --- |
| `task` | `string` | Yes | Self-contained task, up to 50 KiB of UTF-8 text. |
| `tools` | `string[]` | No | Up to 64 names from `read`, `bash`, `powershell`, `edit`, `write`, `grep`, `find`, and `ls`; defaults to `read`, `grep`, `find`, and `ls`. |
| `thinkingLevel` | `string` | No | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`; defaults to the main agent's effective thinking level. |
| `timeout` | `number` | No | Seconds; `> 0` through `2,147,483.647`; no default timeout. |

Starts one task-specialized subagent job with the selected tool capabilities and returns its job ID immediately.

The runtime always adds `subagent_send` and `subagent_wait` to the selected tools.

The child inherits the main agent's effective provider and model at spawn time.

Providers registered by a parent extension throw before the job is queued because children disable unrelated extensions.

A process-local runtime API key, including a parent-only `--api-key` value, also throws before queuing.

Use Pi's stored credentials or environment credentials that the child process can read.

Unavailable or extension-only tool names throw before the job is queued.

Throws without launching a child when the session broker is unavailable.

## `subagent_inspect`

No parameters.

## `subagent_cancel`

| Parameter | Type | Required | Constraint / default |
| --- | --- | --- | --- |
| `jobId` | `string` | Yes | Job ID returned by `subagent_spawn`. |

## `subagent_wait`

### Main agent

| Parameter | Type | Required | Constraint / default |
| --- | --- | --- | --- |
| `jobId` | `string` | Yes | Job ID to wait for. |
| `timeout` | `number` | No | Seconds; `> 0` through `2,147,483.647`; no default and does not cancel the job. |

Returns `{ jobId, state, timedOut: false, interrupted: true, reason: "subagent_message" }` without cancelling the job when a child request or response arrives.

### Subagent

| Parameter | Type | Required | Constraint / default |
| --- | --- | --- | --- |
| `requestId` | `string` | Yes | Request ID returned by a child-originated `subagent_send`. |
| `timeout` | `number` | No | Seconds; `> 0` through `2,147,483.647`; no default and does not cancel the request. |

Returns the main agent's response as plain text.

A timeout, caller cancellation, or incoming main-agent request throws and stops only that wait, so the child may wait for the same request again.

The runtime interrupts an active child wait only after Pi RPC accepts the incoming main request for steering.

## `subagent_send`

Main and child processes receive separate provider-visible definitions for their own context.

### Main agent

| Parameter | Type | Required | Constraint / default |
| --- | --- | --- | --- |
| `recipient` | `string` | Conditional | Active job ID for a new request. |
| `requestId` | `string` | Conditional | Pending child request to answer. |
| `message` | `string` | Yes | Plain-text request or response, up to 48 KiB of UTF-8 text and 1,992 lines. |

Provide exactly one of `recipient` or `requestId`.

A new request provides an active queued or running job ID as `recipient` and omits `requestId`.

A response provides `requestId` and omits `recipient`.

### Subagent

| Parameter | Type | Required | Constraint / default |
| --- | --- | --- | --- |
| `requestId` | `string` | No | Pending main-agent request to answer; omit to start a new request to main. |
| `message` | `string` | Yes | Plain-text request or response, up to 48 KiB of UTF-8 text and 1,992 lines. |

A new request omits `requestId` and returns a request ID immediately for an optional `subagent_wait` call.

A response provides the pending main-agent `requestId`.

A main-originated request waits for the child RPC prompt to be accepted and then uses Pi steering to reach the running child.

After steering is queued, the runtime interrupts active child response waits without consuming their original requests.

Caller cancellation before RPC delivery starts rolls the request back.

Once RPC delivery starts, cancellation stops only the caller's wait; the request may still arrive and remains answerable until delivery fails or the job terminates.

A child response arrives asynchronously in the main session and interrupts the next active main-agent `subagent_wait`, including when the response arrived immediately before the wait started.

The first accepted response wins, and repeated responses acknowledge the existing response without replacing it.

Each job may have up to four unresolved or answered-but-not-consumed requests across both directions.

Requests and responses are limited to 1,992 lines so their protocol envelopes fit Pi's 2,000-line model-text bound.

Terminal jobs, unknown requests, cross-job responses, responses from the request originator, and stale session credentials throw.

A successful call returns `{ requestId, accepted, duplicate }`.
