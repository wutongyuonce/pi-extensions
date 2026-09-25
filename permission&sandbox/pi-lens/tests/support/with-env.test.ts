import { afterEach, describe, expect, it } from "vitest";
import { withEnv } from "./with-env.js";

const KEY = "PI_LENS_WITH_ENV_TEST_VAR";

afterEach(() => {
	delete process.env[KEY];
});

describe("withEnv", () => {
	it("restores the prior value, not a hardcoded default", () => {
		// The #1816 bug shape: two files' `afterEach` hard-restored the literal
		// "1" instead of whatever was ambient before the file ran. Pin a
		// DIFFERENT prior value here so a hardcoded-restore regression is
		// caught rather than accidentally matching by coincidence.
		process.env[KEY] = "ambient-value";

		const restore = withEnv({ [KEY]: "overridden-for-test" });
		expect(process.env[KEY]).toBe("overridden-for-test");

		restore();
		expect(process.env[KEY]).toBe("ambient-value");
	});

	it("deletes the key on restore when it didn't exist beforehand", () => {
		delete process.env[KEY];

		const restore = withEnv({ [KEY]: "1" });
		expect(process.env[KEY]).toBe("1");

		restore();
		expect(process.env[KEY]).toBeUndefined();
		expect(KEY in process.env).toBe(false);
	});

	it("deletes the key during the override when the override value is undefined", () => {
		process.env[KEY] = "was-set";

		const restore = withEnv({ [KEY]: undefined });
		expect(process.env[KEY]).toBeUndefined();

		restore();
		expect(process.env[KEY]).toBe("was-set");
	});

	it("restores multiple keys independently", () => {
		const KEY2 = `${KEY}_2`;
		process.env[KEY] = "a";
		delete process.env[KEY2];

		const restore = withEnv({ [KEY]: "b", [KEY2]: "c" });
		expect(process.env[KEY]).toBe("b");
		expect(process.env[KEY2]).toBe("c");

		restore();
		expect(process.env[KEY]).toBe("a");
		expect(process.env[KEY2]).toBeUndefined();
	});
});
