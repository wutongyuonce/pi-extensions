import type { Mock } from "vitest";

export async function loadProvider(): Promise<Response> {
	vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
		new Response(JSON.stringify({ cached: true })),
	);
	const fetchMock = globalThis.fetch as Mock;
	return fetchMock("https://example.test/provider");
}
