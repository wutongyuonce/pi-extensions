import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createLombokJdtlsArgs,
	createLombokJdtlsEnv,
	hasLombokJavaAgent,
	hasLombokProject,
	resolveLombokJar,
} from "../../../clients/lsp/lombok.js";
import { removeTempDirSync } from "../test-utils.js";

let tmpDir: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-lombok-"));
});

afterEach(() => {
	removeTempDirSync(tmpDir);
	vi.restoreAllMocks();
});

function writeFile(relativePath: string, content: string): string {
	const filePath = path.join(tmpDir, relativePath);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content);
	return filePath;
}

describe("Lombok project detection", () => {
	it("detects Maven and Gradle Lombok dependencies", () => {
		writeFile(
			"pom.xml",
			`<project><dependencies><dependency><groupId>org.projectlombok</groupId><artifactId>lombok</artifactId></dependency></dependencies></project>`,
		);
		expect(hasLombokProject(tmpDir)).toBe(true);

		fs.rmSync(path.join(tmpDir, "pom.xml"));
		writeFile(
			"build.gradle.kts",
			`dependencies { compileOnly("org.projectlombok:lombok:1.18.46") annotationProcessor("org.projectlombok:lombok:1.18.46") }`,
		);
		expect(hasLombokProject(tmpDir)).toBe(true);
	});

	it("detects lombok.config without scanning dependencies", () => {
		writeFile("lombok.config", "config.stopBubbling = true\n");
		expect(hasLombokProject(tmpDir)).toBe(true);
	});

	it("does not detect a plain Java project", () => {
		writeFile("pom.xml", "<project><dependencies /></project>");
		expect(hasLombokProject(tmpDir)).toBe(false);
	});
});

describe("Lombok jar resolution", () => {
	it("prefers explicit env jar over local jars", () => {
		const explicit = writeFile("explicit/lombok.jar", "jar");
		writeFile(".lombok/lombok.jar", "local");
		expect(resolveLombokJar(tmpDir, { PI_LENS_LOMBOK_JAR: explicit })).toBe(
			path.resolve(explicit),
		);
	});

	it("finds local project jars", () => {
		const local = writeFile(".lombok/lombok.jar", "jar");
		expect(resolveLombokJar(tmpDir, {})).toBe(local);
	});
});

describe("JDT LS Lombok launch configuration", () => {
	it("creates official jdtls --jvm-arg for Lombok projects", () => {
		writeFile("lombok.config", "config.stopBubbling = true\n");
		const jar = writeFile(".lombok/lombok.jar", "jar");
		expect(createLombokJdtlsArgs(tmpDir, {})).toEqual([
			`--jvm-arg=-javaagent:${jar}`,
		]);
	});

	it("can append -javaagent to JDTLS_JVM_ARGS for wrappers that use env args", () => {
		writeFile("lombok.config", "config.stopBubbling = true\n");
		const jar = writeFile(".lombok/lombok.jar", "jar");
		const env = createLombokJdtlsEnv(tmpDir, {
			JDTLS_JVM_ARGS: "-Xmx2g",
		});
		expect(env?.JDTLS_JVM_ARGS).toBe(`-Xmx2g -javaagent:${jar}`);
	});

	it("does not duplicate an existing Lombok javaagent", () => {
		writeFile("lombok.config", "config.stopBubbling = true\n");
		writeFile(".lombok/lombok.jar", "jar");
		const env = createLombokJdtlsEnv(tmpDir, {
			JDTLS_JVM_ARGS: "-javaagent:/tools/lombok.jar",
		});
		expect(env).toBeUndefined();
		expect(hasLombokJavaAgent("-Xmx1g -javaagent:/tools/lombok.jar")).toBe(
			true,
		);
	});

	it("respects PI_LENS_JAVA_LOMBOK=0", () => {
		writeFile("lombok.config", "config.stopBubbling = true\n");
		writeFile(".lombok/lombok.jar", "jar");
		expect(
			createLombokJdtlsEnv(tmpDir, { PI_LENS_JAVA_LOMBOK: "0" }),
		).toBeUndefined();
	});
});
