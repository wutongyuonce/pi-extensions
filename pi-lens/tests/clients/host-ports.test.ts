import { describe, expect, it } from "vitest";
import {
	createDefaultHostPorts,
	type HostPorts,
} from "../../clients/host-ports.js";

describe("HostPorts contract (#1358 S2)", () => {
	it("preserves absent-host feature-detection defaults", async () => {
		const ports = createDefaultHostPorts();
		expect(ports.trust.isProjectTrusted()).toBe("unknown");
		expect(ports.mode.current()).toBe("unknown");
		expect(ports.mode.supportsTuiWidget()).toBe(true);
		expect(ports.mode.suppressesUserNotify()).toBe(false);
		expect(ports.spawn.abortSignal()).toBeUndefined();
		expect(ports.spawn.isAllowed("test")).toBe(true);
		expect(ports.workspace.cwd()).toBeUndefined();
		expect(ports.workspace.projectRoot()).toBeUndefined();
		expect(ports.session.id()).toBeUndefined();
		expect(ports.flags.get("x")).toBeUndefined();
		expect(await ports.tools.has("x")).toBe(false);
		expect(ports.tools.getActive()).toEqual([]);
		expect(() => {
			ports.notify.user("x");
			ports.log.extension({ subsystem: "test", message: "x" });
			ports.log.debug("x");
			ports.log.sink("test")({ x: 1 });
			ports.emit.bus("x", {});
			ports.status.set("x", "y");
			ports.render.invalidate();
			ports.tools.setActive(["x"]);
		}).not.toThrow();
	});

	it("lets a fake drive every capability group", async () => {
		const called: string[] = [];
		const fake: HostPorts = createDefaultHostPorts({
			notify: { user: () => called.push("notify") },
			trust: { isProjectTrusted: () => "trusted" },
			mode: {
				current: () => "rpc",
				supportsTuiWidget: () => false,
				suppressesUserNotify: () => false,
			},
			log: {
				extension: () => called.push("extension"),
				debug: () => called.push("debug"),
				sink: () => () => called.push("sink"),
			},
			emit: { bus: () => called.push("bus") },
			status: { set: () => called.push("status") },
			spawn: { abortSignal: () => AbortSignal.abort(), isAllowed: () => false },
			render: { invalidate: () => called.push("render") },
			session: { id: () => "s1" },
			workspace: { cwd: () => "/cwd", projectRoot: () => "/root" },
			flags: { get: () => true },
			tools: {
				has: async () => true,
				getActive: () => ["read"],
				setActive: () => called.push("tools"),
			},
		});
		fake.notify.user("x");
		fake.log.extension({ subsystem: "x", message: "x" });
		fake.log.debug("x");
		fake.log.sink("x")({});
		fake.emit.bus("x", {});
		fake.status.set("x", "x");
		fake.render.invalidate();
		fake.tools.setActive([]);
		expect(fake.trust.isProjectTrusted()).toBe("trusted");
		expect(fake.mode.current()).toBe("rpc");
		expect(fake.spawn.abortSignal()?.aborted).toBe(true);
		expect(fake.spawn.isAllowed("x")).toBe(false);
		expect(fake.session.id()).toBe("s1");
		expect(fake.workspace.cwd()).toBe("/cwd");
		expect(fake.workspace.projectRoot()).toBe("/root");
		expect(fake.flags.get("x")).toBe(true);
		expect(await fake.tools.has("x")).toBe(true);
		expect(fake.tools.getActive()).toEqual(["read"]);
		expect(called).toEqual([
			"notify",
			"extension",
			"debug",
			"sink",
			"bus",
			"status",
			"render",
			"tools",
		]);
	});

	// #1367 review: parity must be proven against the REAL adapter fed an
	// absent-capability host, not against the defaults referencing themselves.
	it(
		"live adapter over an absent-capability host matches the defaults",
		{ timeout: 30_000 },
		async () => {
			const { createHostPorts } = await import("../../index.js");
			const bare = createHostPorts({} as never, {
				getContext: () => undefined,
			});
			const defaults = createDefaultHostPorts();
			expect(bare.trust.isProjectTrusted()).toBe(
				defaults.trust.isProjectTrusted(),
			);
			expect(bare.mode.current()).toBe(defaults.mode.current());
			expect(bare.mode.supportsTuiWidget()).toBe(
				defaults.mode.supportsTuiWidget(),
			);
			expect(bare.mode.suppressesUserNotify()).toBe(
				defaults.mode.suppressesUserNotify(),
			);
			expect(bare.session.id()).toBe(defaults.session.id());
			expect(bare.workspace.cwd()).toBe(defaults.workspace.cwd());
			// notify on a ctx-less host must be a safe no-op, like the default
			expect(() => bare.notify.user("x", "info")).not.toThrow();
		},
	);

	// #1367 review: nothing previously exercised the ports-backed notifier
	// delivery -- a no-op mutation of notify.user stayed green. This reaches
	// wireUserNotifier(ports) end to end.
	it(
		"ports-backed notifier delivers degradations to the live host ctx",
		{ timeout: 30_000 },
		async () => {
			const { createHostPorts } = await import("../../index.js");
			const { wireUserNotifier, notifyUserDegradation, resetUserNotifier } =
				await import("../../clients/user-notify.js");
			const delivered: string[] = [];
			const ctx = {
				mode: "tui",
				ui: { notify: (message: string) => delivered.push(message) },
			};
			const ports = createHostPorts({} as never, { getContext: () => ctx });
			wireUserNotifier(ports);
			try {
				notifyUserDegradation("grammar unavailable", "warning");
				expect(delivered).toEqual(["grammar unavailable"]);
				// print mode suppresses via the same port
				(ctx as { mode: string }).mode = "print";
				notifyUserDegradation("hidden in print", "warning");
				expect(delivered).toEqual(["grammar unavailable"]);
			} finally {
				resetUserNotifier();
			}
		},
	);
});
