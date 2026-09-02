import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { getSharedTreeSitterClient } from "../../clients/tree-sitter-shared.js";
import { TreeSitterQueryLoader } from "../../clients/tree-sitter-query-loader.js";
import { removeTempDirSync } from "./test-utils.js";

const tmpDirs: string[] = [];

function writeTempFile(ext: string, contents: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-sec-gap-"));
	tmpDirs.push(dir);
	const filePath = path.join(dir, `sample.${ext}`);
	fs.writeFileSync(filePath, contents, "utf-8");
	return filePath;
}

async function getQuery(id: string) {
	const loader = new TreeSitterQueryLoader();
	const queries = await loader.loadQueries(process.cwd());
	for (const langQueries of queries.values()) {
		const found = langQueries.find((q) => q.id === id);
		if (found) return found;
	}
	throw new Error(`missing query ${id}`);
}

afterAll(() => {
	for (const dir of tmpDirs) {
		removeTempDirSync(dir);
	}
});

describe("tree-sitter security gap rules", () => {
	it("matches python ssrf sink", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("python-ssrf");
		const filePath = writeTempFile(
			"py",
			`import requests\nrequests.get(user_url)\n`,
		);
		const matches = await client.runQueryOnFile(query, filePath, "python");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("does not match safe python literal URL request", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("python-ssrf");
		const filePath = writeTempFile(
			"py",
			`import requests\nrequests.get("https://example.com")\n`,
		);
		const matches = await client.runQueryOnFile(query, filePath, "python");
		expect(matches.length).toBe(0);
	});

	it("matches python path traversal sink", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("python-path-traversal");
		const filePath = writeTempFile("py", `open(base + user_path)\n`);
		const matches = await client.runQueryOnFile(query, filePath, "python");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("does not match static python file path", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("python-path-traversal");
		const filePath = writeTempFile("py", `open("/tmp/safe.txt")\n`);
		const matches = await client.runQueryOnFile(query, filePath, "python");
		expect(matches.length).toBe(0);
	});

	it("matches python sql injection sink", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("python-sql-injection");
		const filePath = writeTempFile(
			"py",
			`cursor.execute("SELECT * FROM users WHERE id = " + user_id)\n`,
		);
		const matches = await client.runQueryOnFile(query, filePath, "python");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("does not match parameterized python sql", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("python-sql-injection");
		const filePath = writeTempFile(
			"py",
			`cursor.execute("SELECT * FROM users WHERE id=%s", (user_id,))\n`,
		);
		const matches = await client.runQueryOnFile(query, filePath, "python");
		expect(matches.length).toBe(0);
	});

	it("does not match SQLAlchemy session.execute(stmt)", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("python-sql-injection");
		const filePath = writeTempFile(
			"py",
			`from sqlalchemy import select\nstmt = select(MyModel).where(MyModel.id == 42)\nresult = await session.execute(stmt)\n`,
		);
		const matches = await client.runQueryOnFile(query, filePath, "python");
		expect(matches.length).toBe(0);
	});

	it("does not match SQLAlchemy expression-builder execute calls", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("python-sql-injection");
		const filePath = writeTempFile(
			"py",
			`result = conn.execute(select(MyModel).where(MyModel.id == user_id))\n`,
		);
		const matches = await client.runQueryOnFile(query, filePath, "python");
		expect(matches.length).toBe(0);
	});

	it("matches raw cursor.execute(sql_identifier)", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("python-sql-injection");
		const filePath = writeTempFile("py", `cursor.execute(sql)\n`);
		const matches = await client.runQueryOnFile(query, filePath, "python");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("matches python insecure deserialization sink", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("python-insecure-deserialization");
		const filePath = writeTempFile(
			"py",
			`import pickle\npickle.loads(payload)\n`,
		);
		const matches = await client.runQueryOnFile(query, filePath, "python");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("does not match safe python json deserialization", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("python-insecure-deserialization");
		const filePath = writeTempFile("py", `import json\njson.loads(payload)\n`);
		const matches = await client.runQueryOnFile(query, filePath, "python");
		expect(matches.length).toBe(0);
	});

	it("matches python weak hash usage and exposes metadata", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("python-weak-hash");
		expect(query.cwe).toContain("CWE-327");
		expect(query.owasp).toContain("A02");
		expect(query.confidence).toBe("high");

		const filePath = writeTempFile("py", `import hashlib\nhashlib.md5(data)\n`);
		const matches = await client.runQueryOnFile(query, filePath, "python");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("matches go sql injection sink", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("go-sql-injection");
		const filePath = writeTempFile(
			"go",
			`package main\nimport "fmt"\nfunc run(db DB, userID string){ db.Query(fmt.Sprintf("SELECT * FROM users WHERE id=%s", userID)) }\n`,
		);
		const matches = await client.runQueryOnFile(query, filePath, "go");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("does not match parameterized go sql", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("go-sql-injection");
		const filePath = writeTempFile(
			"go",
			`package main\nfunc run(db DB, id string){ db.Query("SELECT * FROM users WHERE id=$1", id) }\n`,
		);
		const matches = await client.runQueryOnFile(query, filePath, "go");
		expect(matches.length).toBe(0);
	});

	it("matches typescript ssrf sink", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("ts-ssrf");
		const filePath = writeTempFile("ts", `await fetch(userUrl);\n`);
		const matches = await client.runQueryOnFile(query, filePath, "typescript");
		expect(matches.length).toBeGreaterThan(0);
	});

	// Regression coverage for #963: naming convention alone (e.g.
	// SCREAMING_SNAKE_CASE) must never be trusted as proof of a fixed URL.
	// Only a provably literal-initialized `const` in the same file is exempt.
	it("does not flag fetch of a const initialized with a string literal (#963)", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("ts-ssrf");
		const filePath = writeTempFile(
			"ts",
			`const OPENAI_URL = "https://api.openai.com/v1";\nawait fetch(OPENAI_URL);\n`,
		);
		const matches = await client.runQueryOnFile(query, filePath, "typescript");
		expect(matches.length).toBe(0);
	});

	it("does not flag fetch of a lowercase const initialized with a string literal", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("ts-ssrf");
		const filePath = writeTempFile(
			"ts",
			`const targetUrl = "https://example.com/api";\nawait fetch(targetUrl);\n`,
		);
		const matches = await client.runQueryOnFile(query, filePath, "typescript");
		expect(matches.length).toBe(0);
	});

	it("does not flag fetch of a const initialized with a substitution-free template literal", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("ts-ssrf");
		const filePath = writeTempFile(
			"ts",
			"const OPENAI_URL = `https://api.openai.com/v1`;\nawait fetch(OPENAI_URL);\n",
		);
		const matches = await client.runQueryOnFile(query, filePath, "typescript");
		expect(matches.length).toBe(0);
	});

	it("still flags fetch of an all-caps identifier assigned from tainted input (#963 regression this rework must not repeat)", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("ts-ssrf");
		const filePath = writeTempFile(
			"ts",
			`const TARGET_URL = req.query.url;\nawait fetch(TARGET_URL);\n`,
		);
		const matches = await client.runQueryOnFile(query, filePath, "typescript");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("still flags fetch of an all-caps identifier assigned from a function call", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("ts-ssrf");
		const filePath = writeTempFile(
			"ts",
			`const TARGET_URL = getUserSuppliedUrl();\nawait fetch(TARGET_URL);\n`,
		);
		const matches = await client.runQueryOnFile(query, filePath, "typescript");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("still flags fetch of an all-caps identifier assigned from a member expression", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("ts-ssrf");
		const filePath = writeTempFile(
			"ts",
			`const TARGET_URL = settings.remoteEndpoint;\nawait fetch(TARGET_URL);\n`,
		);
		const matches = await client.runQueryOnFile(query, filePath, "typescript");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("still flags fetch of an all-caps identifier that is a function parameter", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("ts-ssrf");
		const filePath = writeTempFile(
			"ts",
			`async function callWebhook(WEBHOOK_URL) {\n  await fetch(WEBHOOK_URL);\n}\n`,
		);
		const matches = await client.runQueryOnFile(query, filePath, "typescript");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("still flags fetch of a member expression (unchanged broad net)", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("ts-ssrf");
		const filePath = writeTempFile("ts", `await fetch(settings.endpoint);\n`);
		const matches = await client.runQueryOnFile(query, filePath, "typescript");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("still flags fetch of a const reassigned after a literal initializer", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("ts-ssrf");
		const filePath = writeTempFile(
			"ts",
			`let TARGET_URL = "https://example.com";\nTARGET_URL = req.query.url;\nawait fetch(TARGET_URL);\n`,
		);
		const matches = await client.runQueryOnFile(query, filePath, "typescript");
		expect(matches.length).toBeGreaterThan(0);
	});

	// #1000: fixed outbound endpoints built with `new URL(literal, fixedBase)`
	// must not be reported. Origin+path are fully fixed; dynamic query params
	// added via `searchParams.set(...)` do not control the destination.
	it("does not flag fetch of a new URL(literal, file-local const base).toString() (#1000)", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("ts-ssrf");
		const filePath = writeTempFile(
			"ts",
			'const BASE = "https://api.example.com";\n' +
				'const authUrl = new URL("auth/authorize", `${BASE}/`);\n' +
				'authUrl.searchParams.set("callback_url", cb);\n' +
				"await fetch(authUrl.toString());\n",
		);
		const matches = await client.runQueryOnFile(query, filePath, "typescript");
		expect(matches.length).toBe(0);
	});

	it("does not flag fetch of a new URL(literal, imported base).toString() with an aliased URL ctor (#1000)", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("ts-ssrf");
		const filePath = writeTempFile(
			"ts",
			'import { URL as NodeURL } from "node:url";\n' +
				'import { BASE_URL_CLINE } from "../../constants.ts";\n' +
				'const authUrl = new NodeURL("auth/authorize", `${BASE_URL_CLINE}/`);\n' +
				'authUrl.searchParams.set("callback_url", cb);\n' +
				"await fetch(authUrl.toString());\n",
		);
		const matches = await client.runQueryOnFile(query, filePath, "typescript");
		expect(matches.length).toBe(0);
	});

	it("does not flag fetch of a single-arg new URL(literal).href (#1000)", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("ts-ssrf");
		const filePath = writeTempFile(
			"ts",
			'const u = new URL("https://api.example.com/v1/userinfo");\n' +
				"await fetch(u.href);\n",
		);
		const matches = await client.runQueryOnFile(query, filePath, "typescript");
		expect(matches.length).toBe(0);
	});

	// The exemption must NOT neuter real SSRF detection. Each case below MUST
	// still fire — they fail if the new-URL exemption is broadened past "literal
	// path + provably-fixed base".
	it("still flags fetch of new URL(literal, base-from-function-param).toString() (#1000)", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("ts-ssrf");
		const filePath = writeTempFile(
			"ts",
			"function f(base) {\n" +
				'  const u = new URL("auth", `${base}/`);\n' +
				"  return fetch(u.toString());\n" +
				"}\n",
		);
		const matches = await client.runQueryOnFile(query, filePath, "typescript");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("still flags fetch of new URL(tainted-path, fixed-base).toString() (#1000)", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("ts-ssrf");
		const filePath = writeTempFile(
			"ts",
			'const u = new URL(req.query.next, "https://api.example.com");\n' +
				"await fetch(u.toString());\n",
		);
		const matches = await client.runQueryOnFile(query, filePath, "typescript");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("still flags fetch of new URL(literal, env-derived const base).toString() (#1000 over-exempt guard)", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("ts-ssrf");
		const filePath = writeTempFile(
			"ts",
			"const BASE = process.env.API_BASE;\n" +
				'const u = new URL("auth", `${BASE}/`);\n' +
				"await fetch(u.toString());\n",
		);
		const matches = await client.runQueryOnFile(query, filePath, "typescript");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("still flags fetch of new URL(user-controlled redirect/location).toString() (#1000)", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("ts-ssrf");
		const filePath = writeTempFile(
			"ts",
			"const u = new URL(resp.headers.location);\n" +
				"await fetch(u.toString());\n",
		);
		const matches = await client.runQueryOnFile(query, filePath, "typescript");
		expect(matches.length).toBeGreaterThan(0);
	});

	// #1008 (BUG 1 — regression the #1000 exemption introduced): mutating the
	// URL receiver's origin/host/path/href AFTER construction re-taints the
	// destination. `new URL(literal, fixedBase)` is only fixed until someone
	// writes `u.host = …`; the const-clean gate must treat any such property or
	// subscript write to the bound receiver as a reassignment and fail closed.
	it("still flags fetch of a new URL const whose host is mutated after construction (#1008)", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("ts-ssrf");
		const filePath = writeTempFile(
			"ts",
			'const u = new URL("/x", "https://fixed");\n' +
				"u.host = req.query.h;\n" +
				"await fetch(u.toString());\n",
		);
		const matches = await client.runQueryOnFile(query, filePath, "typescript");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("still flags fetch of a new URL const whose href is mutated after construction (#1008)", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("ts-ssrf");
		const filePath = writeTempFile(
			"ts",
			'const u = new URL("/x", "https://fixed");\n' +
				"u.href = req.query.u;\n" +
				"await fetch(u.toString());\n",
		);
		const matches = await client.runQueryOnFile(query, filePath, "typescript");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("still flags fetch of a new URL const whose host is mutated via subscript write (#1008)", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("ts-ssrf");
		const filePath = writeTempFile(
			"ts",
			'const u = new URL("/x", "https://fixed");\n' +
				'u["host"] = req.query.h;\n' +
				"await fetch(u.toString());\n",
		);
		const matches = await client.runQueryOnFile(query, filePath, "typescript");
		expect(matches.length).toBeGreaterThan(0);
	});

	// #1008 (BUG 2 — scope-blind base resolution): a request-tainted function
	// PARAMETER base must not be exempted just because an unrelated same-named
	// module-level `const` literal exists. The param shadows the const at the
	// sink, so the base is attacker-controlled and the sink must fire.
	it("still flags fetch of new URL(literal, param base) shadowing an unrelated same-named file-level const (#1008)", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("ts-ssrf");
		const filePath = writeTempFile(
			"ts",
			'const base = "https://api.example.com";\n' +
				"function proxy(base) {\n" +
				'  const u = new URL("/x", `${base}/`);\n' +
				"  return fetch(u.toString());\n" +
				"}\n",
		);
		const matches = await client.runQueryOnFile(query, filePath, "typescript");
		expect(matches.length).toBeGreaterThan(0);
	});

	// Guard against over-correction: query-string-only mutation does not change
	// the origin/host/path, so it must STAY exempt.
	it("does not flag fetch of a new URL const with query-only searchParams mutation (#1008)", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("ts-ssrf");
		const filePath = writeTempFile(
			"ts",
			'const u = new URL("/x", "https://fixed");\n' +
				'u.searchParams.set("q", req.query.q);\n' +
				"await fetch(u.toString());\n",
		);
		const matches = await client.runQueryOnFile(query, filePath, "typescript");
		expect(matches.length).toBe(0);
	});

	// Guard against over-correction of BUG 2: a legitimate fixed base `const` in
	// the same (module) scope as the sink, with no shadowing param, must STAY
	// exempt.
	it("does not flag fetch of new URL(literal, same-scope fixed const base) (#1008)", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("ts-ssrf");
		const filePath = writeTempFile(
			"ts",
			'const base = "https://api.example.com";\n' +
				'const u = new URL("/x", base);\n' +
				"await fetch(u.toString());\n",
		);
		const matches = await client.runQueryOnFile(query, filePath, "typescript");
		expect(matches.length).toBe(0);
	});

	it("matches go path traversal sink", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("go-path-traversal");
		const filePath = writeTempFile(
			"go",
			`package main\nimport "os"\nfunc run(base string, userPath string){ os.ReadFile(base + userPath) }\n`,
		);
		const matches = await client.runQueryOnFile(query, filePath, "go");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("matches go insecure random usage", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("go-insecure-random");
		const filePath = writeTempFile(
			"go",
			`package main\nimport "math/rand"\nfunc run(){ _ = rand.Intn(10) }\n`,
		);
		const matches = await client.runQueryOnFile(query, filePath, "go");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("matches typescript weak hash usage", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getQuery("ts-weak-hash");
		const filePath = writeTempFile(
			"ts",
			`import crypto from "crypto";\ncrypto.createHash("md5").update(data);\n`,
		);
		const matches = await client.runQueryOnFile(query, filePath, "typescript");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("loads ruby insecure deserialization rule", async () => {
		const query = await getQuery("ruby-insecure-deserialization");
		expect(query.language).toBe("ruby");
		expect(query.id).toBe("ruby-insecure-deserialization");
	});

	it("loads ruby weak hash and insecure random rules", async () => {
		const weakHash = await getQuery("ruby-weak-hash");
		expect(weakHash.cwe).toContain("CWE-327");
		const weakRandom = await getQuery("ruby-insecure-random");
		expect(weakRandom.cwe).toContain("CWE-330");
	});
});
