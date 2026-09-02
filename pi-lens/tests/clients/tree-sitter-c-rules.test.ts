import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { getSharedTreeSitterClient } from "../../clients/tree-sitter-shared.js";
import { TreeSitterQueryLoader } from "../../clients/tree-sitter-query-loader.js";
import { removeTempDirSync } from "./test-utils.js";

const tmpDirs: string[] = [];

function writeTempCFile(contents: string): string {
	// pi-lens-ignore: ts-path-traversal — test-owned temp directory from os.tmpdir()
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-c-rules-"));
	tmpDirs.push(dir);
	// pi-lens-ignore: ts-path-traversal — test fixture filename is hardcoded
	const filePath = path.join(dir, "sample.c");
	// pi-lens-ignore: ts-path-traversal — test writes controlled fixture data to temp dir
	fs.writeFileSync(filePath, contents, "utf-8");
	return filePath;
}

async function getCQuery(id: string) {
	const loader = new TreeSitterQueryLoader();
	const queries = await loader.loadQueries(process.cwd());
	const cQueries = queries.get("c") ?? [];
	const query = cQueries.find((q) => q.id === id);
	expect(query, `missing query ${id}`).toBeTruthy();
	return query!;
}

afterAll(() => {
	for (const dir of tmpDirs) {
		removeTempDirSync(dir);
	}
});

describe("tree-sitter C rules", () => {
	it("matches memset-sensitive-data only on sensitive args", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getCQuery("memset-sensitive-data");

		const positivePath = writeTempCFile(`
void erase_password(char* password) {
    memset(password, 0, 32);
}
`);
		const positive = await client.runQueryOnFile(query, positivePath, "c");
		expect(positive.length).toBeGreaterThan(0);

		const negativePath = writeTempCFile(`
void clear_buffer(char* buf) {
    memset(buf, 0, 32);
}
`);
		const negative = await client.runQueryOnFile(query, negativePath, "c");
		expect(negative.length).toBe(0);
	});

	it("matches noreturn-returns when return is present", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getCQuery("noreturn-returns");
		const filePath = writeTempCFile(`
__attribute__((noreturn)) void fatal() {
    printf("error\\n");
    return;
}
`);
		const matches = await client.runQueryOnFile(query, filePath, "c");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("matches no-octal-literals", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getCQuery("no-octal-literals");
		const filePath = writeTempCFile(`
int x = 010;
int y = 0x10;
`);
		const matches = await client.runQueryOnFile(query, filePath, "c");
		expect(matches.length).toBe(1);
		expect(matches[0].captures.NUM).toBe("010");
	});

	it("matches no-reserved-identifiers", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getCQuery("no-reserved-identifiers");
		const filePath = writeTempCFile(`
int _Reserved = 1;
int __internal = 2;
int normal = 3;
`);
		const matches = await client.runQueryOnFile(query, filePath, "c");
		expect(matches.length).toBe(2);
		const names = matches.map((m) => m.captures.NAME);
		expect(names).toContain("_Reserved");
		expect(names).toContain("__internal");
	});

	it("matches no-stdlib-name-as-id", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getCQuery("no-stdlib-name-as-id");
		const filePath = writeTempCFile(`
int malloc = 10;
int my_size = 20;
`);
		const matches = await client.runQueryOnFile(query, filePath, "c");
		expect(matches.length).toBe(1);
		expect(matches[0].captures.NAME).toBe("malloc");
	});

	it("matches no-bit-fields", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getCQuery("no-bit-fields");
		const filePath = writeTempCFile(`
struct Flags {
    int flag1 : 1;
    int flag2 : 3;
};
`);
		const matches = await client.runQueryOnFile(query, filePath, "c");
		expect(matches.length).toBe(2);
	});

	it("matches no-redundant-pointer-ops", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getCQuery("no-redundant-pointer-ops");
		const filePath = writeTempCFile(`
void test() {
    int x = 5;
    int y = *&x;
    int *p = &x;
    int *q = &*p;
}
`);
		const matches = await client.runQueryOnFile(query, filePath, "c");
		expect(matches.length).toBe(2);
	});

	it("matches no-pointer-arithmetic-array-access", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getCQuery("no-pointer-arithmetic-array-access");
		const filePath = writeTempCFile(`
void test() {
    int arr[10];
    int val = *(arr + 3);
}
`);
		const matches = await client.runQueryOnFile(query, filePath, "c");
		expect(matches.length).toBeGreaterThan(0);
	});

	it("matches c-hardcoded-secrets", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getCQuery("c-hardcoded-secrets");
		const filePath = writeTempCFile(`
const char* api_key = "sk-1234567890abcdef";
const char* msg = "hello";
`);
		const matches = await client.runQueryOnFile(query, filePath, "c");
		expect(matches.length).toBe(1);
		expect(matches[0].captures.VARNAME).toBe("api_key");
	});

	it("matches non-case-label-in-switch", async () => {
		const client = getSharedTreeSitterClient()!;
		const query = await getCQuery("non-case-label-in-switch");
		const filePath = writeTempCFile(`
void test(int x) {
    switch (x) {
        case 1:
            break;
        cleanup:
            break;
    }
}
`);
		const matches = await client.runQueryOnFile(query, filePath, "c");
		expect(matches.length).toBeGreaterThan(0);
		expect(matches[0].captures.LABEL).toBe("cleanup");
	});
});
