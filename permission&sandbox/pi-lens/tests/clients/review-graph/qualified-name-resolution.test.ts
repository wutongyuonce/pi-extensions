/**
 * refs #655 phase 2: qualified (owner-chain) symbol display names, and two
 * additional `resolution` tiers ("import", "receiver-type") beyond phase 1's
 * bare "exact"/"name-only".
 */
import { afterEach, describe, expect, it } from "vitest";
import { FactStore } from "../../../clients/dispatch/fact-store.js";
import {
	moduleReport,
	readSymbol,
	type ModuleReport,
} from "../../../clients/module-report.js";
import {
	buildOrUpdateGraph,
	clearReviewGraphWorkspaceCache,
} from "../../../clients/review-graph/builder.js";
import { createTempFile, setupTestEnvironment } from "../test-utils.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length) cleanups.pop()?.();
	clearReviewGraphWorkspaceCache();
});

function makeEnv(prefix = "pi-lens-qualname-") {
	const env = setupTestEnvironment(prefix);
	cleanups.push(env.cleanup);
	return env;
}

async function warmGraph(cwd: string): Promise<void> {
	await buildOrUpdateGraph(cwd, [], new FactStore());
}

function findMember(
	report: ModuleReport,
	className: string,
	methodName: string,
) {
	const cls = report.api.find((e) => e.name === className);
	return cls?.members?.find((m) => m.name === methodName);
}

describe("qualified symbol names in usedBy (refs #655 phase 2)", () => {
	it("renders `ClassName.method` for two same-file, same-named methods on different classes", async () => {
		const env = makeEnv();
		createTempFile(
			env.tmpDir,
			"service.ts",
			[
				"export class Alpha {",
				"  run(): number {",
				"    return 1;",
				"  }",
				"}",
				"",
				"export class Beta {",
				"  run(): number {",
				"    return 2;",
				"  }",
				"}",
				"",
				"export function useBoth(a: Alpha, b: Beta): number {",
				"  return a.run() + b.run();",
				"}",
			].join("\n"),
		);

		await warmGraph(env.tmpDir);
		const report = await moduleReport("service.ts", env.tmpDir);
		expect(report.available).toBe(true);

		const alphaRun = findMember(report, "Alpha", "run");
		const betaRun = findMember(report, "Beta", "run");
		expect(alphaRun).toBeDefined();
		expect(betaRun).toBeDefined();

		// Both `run` methods must be independently resolvable via read_symbol
		// using the SAME dotted qualifier convention module-report would render.
		const alphaBody = await readSymbol(
			`${env.tmpDir}/service.ts`,
			"Alpha.run",
			env.tmpDir,
		);
		const betaBody = await readSymbol(
			`${env.tmpDir}/service.ts`,
			"Beta.run",
			env.tmpDir,
		);
		expect(alphaBody.found).toBe(true);
		expect(betaBody.found).toBe(true);
		expect(alphaBody.startLine).toBe(alphaRun?.startLine);
		expect(betaBody.startLine).toBe(betaRun?.startLine);
	});

	it("a rendered qualified usedBy `symbol` string is a valid read_symbol input for the right method", async () => {
		const env = makeEnv();
		createTempFile(
			env.tmpDir,
			"owners.ts",
			[
				"export class UserService {",
				"  run(): number {",
				"    return 1;",
				"  }",
				"}",
				"",
				"export class AdminService {",
				"  run(): number {",
				"    return 2;",
				"  }",
				"}",
				"",
				"export function useUser(svc: UserService): number {",
				"  return svc.run();",
				"}",
			].join("\n"),
		);

		await warmGraph(env.tmpDir);
		const report = await moduleReport("owners.ts", env.tmpDir);
		const userRun = findMember(report, "UserService", "run");
		expect(userRun?.usedBy?.length ?? 0).toBeGreaterThan(0);
		const hit = userRun?.usedBy?.[0];
		expect(hit).toBeDefined();
		// The caller symbol string module-report renders for a qualified symbol
		// MUST be `Owner.method`, and pasting it into read_symbol must land on
		// the SAME method that made the call (useUser), not some unrelated
		// same-named symbol.
		expect(hit?.symbol).toBe("useUser");
		// Cross-check the callEE side: the graph node's OWN qualifiedName (what
		// `usedBy`/`blastRadius` would show for the target if it were itself
		// listed as a caller elsewhere) resolves correctly through read_symbol.
		const resolved = await readSymbol(
			`${env.tmpDir}/owners.ts`,
			"UserService.run",
			env.tmpDir,
		);
		expect(resolved.found).toBe(true);
		expect(resolved.startLine).toBe(userRun?.startLine);
		expect(resolved.endLine).toBe(userRun?.endLine);
	});
});

describe('"import" resolution tier (refs #655 phase 2)', () => {
	it('upgrades a bare-name callee to "import" when the caller\'s import names exactly which file it comes from', async () => {
		const env = makeEnv();
		createTempFile(
			env.tmpDir,
			"service.ts",
			"export function run(): number {\n  return 1;\n}\n",
		);
		// A same-named decoy in a DIFFERENT, non-imported file — without the
		// import hint this callee would be graph-wide ambiguous ("name-only").
		createTempFile(
			env.tmpDir,
			"decoy.ts",
			"export function run(): number {\n  return 2;\n}\n",
		);
		createTempFile(
			env.tmpDir,
			"caller.ts",
			[
				'import { run } from "./service.js";',
				"export function useIt(): number {",
				"  return run();",
				"}",
			].join("\n"),
		);

		const facts = new FactStore();
		const graph = await buildOrUpdateGraph(
			env.tmpDir,
			[
				`${env.tmpDir}/service.ts`,
				`${env.tmpDir}/decoy.ts`,
				`${env.tmpDir}/caller.ts`,
			],
			facts,
		);

		const callEdges = graph.edges.filter(
			(e) => e.kind === "calls" && e.metadata?.unresolvedName === "run",
		);
		expect(callEdges.length).toBeGreaterThan(0);
		const edge = callEdges[0];
		expect(edge.resolution).toBe("import");
		const target = graph.nodes.get(edge.to);
		expect(target?.filePath?.endsWith("service.ts")).toBe(true);
	});

	it('stays "name-only" when the import hint\'s own target file is itself ambiguous', async () => {
		const env = makeEnv();
		// The imported-from file has TWO exports named `run` (a same-file
		// collision) — narrowing to the file isn't enough to pick one.
		createTempFile(
			env.tmpDir,
			"multi.ts",
			[
				"export class Alpha {",
				"  static run(): number {",
				"    return 1;",
				"  }",
				"}",
				"export function run(): number {",
				"  return 2;",
				"}",
			].join("\n"),
		);
		createTempFile(
			env.tmpDir,
			"caller.ts",
			[
				'import { run } from "./multi.js";',
				"export function useIt(): number {",
				"  return run();",
				"}",
			].join("\n"),
		);

		const facts = new FactStore();
		const graph = await buildOrUpdateGraph(
			env.tmpDir,
			[`${env.tmpDir}/multi.ts`, `${env.tmpDir}/caller.ts`],
			facts,
		);

		const edge = graph.edges.find(
			(e) => e.kind === "calls" && e.metadata?.unresolvedName === "run",
		);
		expect(edge).toBeDefined();
		// Two same-named candidates even after file-narrowing: must not upgrade.
		expect(edge?.resolution).toBe("name-only");
	});
});

describe('"receiver-type" resolution tier (refs #655 phase 2)', () => {
	it("resolves obj.method() to the exact class method for a `new ClassName()`-assigned receiver", async () => {
		const env = makeEnv();
		createTempFile(
			env.tmpDir,
			"svc.ts",
			[
				"export class UserService {",
				"  run(): number {",
				"    return 1;",
				"  }",
				"}",
				"",
				"export class AdminService {",
				"  run(): number {",
				"    return 2;",
				"  }",
				"}",
				"",
				"export function useIt(): number {",
				"  const svc = new UserService();",
				"  return svc.run();",
				"}",
			].join("\n"),
		);

		const facts = new FactStore();
		const graph = await buildOrUpdateGraph(
			env.tmpDir,
			[`${env.tmpDir}/svc.ts`],
			facts,
		);

		const edge = graph.edges.find(
			(e) => e.kind === "calls" && e.metadata?.unresolvedName === "svc.run",
		);
		expect(edge).toBeDefined();
		expect(edge?.resolution).toBe("receiver-type");
		const target = graph.nodes.get(edge!.to);
		expect(target?.qualifiedName).toBe("UserService.run");
	});

	it("resolves obj.method() via a typed parameter receiver", async () => {
		const env = makeEnv();
		createTempFile(
			env.tmpDir,
			"svc2.ts",
			[
				"export class Widget {",
				"  render(): number {",
				"    return 1;",
				"  }",
				"}",
				"",
				"export function draw(w: Widget): number {",
				"  return w.render();",
				"}",
			].join("\n"),
		);

		const facts = new FactStore();
		const graph = await buildOrUpdateGraph(
			env.tmpDir,
			[`${env.tmpDir}/svc2.ts`],
			facts,
		);

		const edge = graph.edges.find(
			(e) => e.kind === "calls" && e.metadata?.unresolvedName === "w.render",
		);
		expect(edge).toBeDefined();
		expect(edge?.resolution).toBe("receiver-type");
		const target = graph.nodes.get(edge!.to);
		expect(target?.qualifiedName).toBe("Widget.render");
	});

	it("stays name-only when the receiver's class has 2+ same-named methods (ambiguous even once the type is known)", async () => {
		const env = makeEnv();
		createTempFile(
			env.tmpDir,
			"dup.ts",
			[
				// Two `run` declarations under the SAME class name in the same file:
				// a syntactically-valid-to-tree-sitter overload/duplicate shape.
				"export class Flaky {",
				"  run(): number {",
				"    return 1;",
				"  }",
				"}",
				"export class Flaky {",
				"  run(): number {",
				"    return 2;",
				"  }",
				"}",
				"",
				"export function useIt(f: Flaky): number {",
				"  return f.run();",
				"}",
			].join("\n"),
		);

		const facts = new FactStore();
		const graph = await buildOrUpdateGraph(
			env.tmpDir,
			[`${env.tmpDir}/dup.ts`],
			facts,
		);

		const edge = graph.edges.find(
			(e) => e.kind === "calls" && e.metadata?.unresolvedName === "f.run",
		);
		expect(edge).toBeDefined();
		// Ambiguous owner+name pair — must never guess one of the 2 candidates.
		expect(edge?.resolution).toBe("name-only");
	});

	it("does NOT resolve (no resolution tag) when the receiver's type can't be determined", async () => {
		const env = makeEnv();
		createTempFile(
			env.tmpDir,
			"unknown-receiver.ts",
			[
				"export class Thing {",
				"  run(): number {",
				"    return 1;",
				"  }",
				"}",
				"",
				// `x` has no type annotation and no `new` assignment in scope —
				// conservatively must NOT guess a receiver-type match.
				"export function useIt(x): number {",
				"  return x.run();",
				"}",
			].join("\n"),
		);

		const facts = new FactStore();
		const graph = await buildOrUpdateGraph(
			env.tmpDir,
			[`${env.tmpDir}/unknown-receiver.ts`],
			facts,
		);

		const edge = graph.edges.find(
			(e) => e.kind === "calls" && e.metadata?.unresolvedName === "x.run",
		);
		expect(edge).toBeDefined();
		expect(edge?.resolution).toBeUndefined();
		const target = graph.nodes.get(edge!.to);
		expect(target?.kind).toBe("external");
	});
});
