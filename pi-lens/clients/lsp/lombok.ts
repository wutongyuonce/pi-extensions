import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const LOMBOK_ENV_KEYS = ["PI_LENS_LOMBOK_JAR", "LOMBOK_JAR"] as const;
const LOMBOK_PROJECT_FILES = [
	"lombok.config",
	"pom.xml",
	"build.gradle",
	"build.gradle.kts",
	path.join("gradle", "libs.versions.toml"),
] as const;

function fileExists(filePath: string | undefined): filePath is string {
	if (!filePath) return false;
	try {
		return fs.statSync(filePath).isFile();
	} catch {
		return false;
	}
}

function readTextIfSmall(filePath: string, maxBytes = 512 * 1024): string {
	try {
		const stat = fs.statSync(filePath);
		if (!stat.isFile() || stat.size > maxBytes) return "";
		return fs.readFileSync(filePath, "utf-8");
	} catch {
		return "";
	}
}

function containsLombokDependency(text: string): boolean {
	return (
		/\borg\.projectlombok\b/i.test(text) ||
		/<artifactId>\s*lombok\s*<\/artifactId>/i.test(text) ||
		/\b(annotationProcessor|compileOnly|testCompileOnly|testAnnotationProcessor)\b[^\n]*\blombok\b/i.test(
			text,
		)
	);
}

export function hasLombokProject(root: string): boolean {
	const lombokConfig = path.join(root, "lombok.config");
	if (fileExists(lombokConfig)) return true;

	for (const name of LOMBOK_PROJECT_FILES) {
		if (name === "lombok.config") continue;
		const text = readTextIfSmall(path.join(root, name));
		if (text && containsLombokDependency(text)) return true;
	}
	return false;
}

function envJarCandidate(env: NodeJS.ProcessEnv): string | undefined {
	for (const key of LOMBOK_ENV_KEYS) {
		const value = env[key]?.trim();
		if (fileExists(value)) return path.resolve(value);
	}
	return undefined;
}

function localJarCandidates(root: string): string[] {
	return [
		path.join(root, "lombok.jar"),
		path.join(root, ".lombok", "lombok.jar"),
		path.join(root, "lib", "lombok.jar"),
		path.join(root, "libs", "lombok.jar"),
	];
}

function newestExistingJar(candidates: string[]): string | undefined {
	let best: { filePath: string; mtimeMs: number } | undefined;
	for (const candidate of candidates) {
		try {
			const stat = fs.statSync(candidate);
			if (!stat.isFile()) continue;
			if (!best || stat.mtimeMs > best.mtimeMs) {
				best = { filePath: candidate, mtimeMs: stat.mtimeMs };
			}
		} catch {
			// missing candidate
		}
	}
	return best?.filePath;
}

function mavenLocalLombokJar(home = os.homedir()): string | undefined {
	const base = path.join(
		home,
		".m2",
		"repository",
		"org",
		"projectlombok",
		"lombok",
	);
	let versions: string[] = [];
	try {
		versions = fs.readdirSync(base);
	} catch {
		return undefined;
	}
	return newestExistingJar(
		versions.map((version) =>
			path.join(base, version, `lombok-${version}.jar`),
		),
	);
}

function gradleCacheLombokJar(home = os.homedir()): string | undefined {
	const base = path.join(
		home,
		".gradle",
		"caches",
		"modules-2",
		"files-2.1",
		"org.projectlombok",
		"lombok",
	);
	const candidates: string[] = [];
	let versions: string[] = [];
	try {
		versions = fs.readdirSync(base);
	} catch {
		return undefined;
	}
	for (const version of versions) {
		const versionDir = path.join(base, version);
		let hashes: string[] = [];
		try {
			hashes = fs.readdirSync(versionDir);
		} catch {
			continue;
		}
		for (const hash of hashes) {
			candidates.push(path.join(versionDir, hash, `lombok-${version}.jar`));
		}
	}
	return newestExistingJar(candidates);
}

export function resolveLombokJar(
	root: string,
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	const explicit = envJarCandidate(env);
	if (explicit) return explicit;
	return (
		newestExistingJar(localJarCandidates(root)) ??
		mavenLocalLombokJar() ??
		gradleCacheLombokJar()
	);
}

export function hasLombokJavaAgent(jvmArgs: string | undefined): boolean {
	return /(^|\s)-javaagent:(?:"[^"]*lombok[^"]*\.jar"|\S*lombok\S*\.jar)/i.test(
		jvmArgs ?? "",
	);
}

function appendJvmArg(existing: string | undefined, next: string): string {
	const trimmed = existing?.trim();
	return trimmed ? `${trimmed} ${next}` : next;
}

function resolveLombokJavaAgentArg(
	root: string,
	baseEnv: NodeJS.ProcessEnv = process.env,
): string | undefined {
	if (baseEnv.PI_LENS_JAVA_LOMBOK === "0") return undefined;
	if (hasLombokJavaAgent(baseEnv.JDTLS_JVM_ARGS)) return undefined;

	const explicitJar = envJarCandidate(baseEnv);
	if (!explicitJar && !hasLombokProject(root)) return undefined;

	const jar = explicitJar ?? resolveLombokJar(root, baseEnv);
	return jar ? `-javaagent:${jar}` : undefined;
}

export function createLombokJdtlsArgs(
	root: string,
	baseEnv: NodeJS.ProcessEnv = process.env,
): string[] {
	const javaAgent = resolveLombokJavaAgentArg(root, baseEnv);
	return javaAgent ? [`--jvm-arg=${javaAgent}`] : [];
}

export function createLombokJdtlsEnv(
	root: string,
	baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv | undefined {
	const javaAgent = resolveLombokJavaAgentArg(root, baseEnv);
	if (!javaAgent) return undefined;
	return {
		...baseEnv,
		JDTLS_JVM_ARGS: appendJvmArg(baseEnv.JDTLS_JVM_ARGS, javaAgent),
	};
}
