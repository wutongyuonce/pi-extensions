/**
 * #1826: every file-scoped navigation chokepoint must re-check the capability
 * advertised by the resolved client. The tool layer normally performs the
 * first check; these direct service calls bypass it to prove the second layer.
 */

import { describe, expect, it, vi } from "vitest";
import type { LSPOperationSupport } from "../../../clients/lsp/client.js";
import { LSPService } from "../../../clients/lsp/index.js";

const FILE = "C:/repo/main.ts";
const EMPTY_SUPPORT: LSPOperationSupport = {
	definition: false,
	typeDefinition: false,
	declaration: false,
	references: false,
	hover: false,
	signatureHelp: false,
	documentSymbol: false,
	workspaceSymbol: false,
	codeAction: false,
	codeActionResolve: false,
	rename: false,
	willRenameFiles: false,
	didRenameFiles: false,
	implementation: false,
	callHierarchy: false,
};

type Operation = Exclude<keyof LSPOperationSupport, "workspaceSymbol">;

const CASES: ReadonlyArray<{
	operation: Operation | "prepareCallHierarchy";
	capability: Operation;
	args: readonly unknown[];
	empty: unknown;
}> = [
	{
		operation: "definition",
		capability: "definition",
		args: [FILE, 0, 1],
		empty: [],
	},
	{
		operation: "typeDefinition",
		capability: "typeDefinition",
		args: [FILE, 0, 1],
		empty: [],
	},
	{
		operation: "declaration",
		capability: "declaration",
		args: [FILE, 0, 1],
		empty: [],
	},
	{
		operation: "references",
		capability: "references",
		args: [FILE, 0, 1, true],
		empty: [],
	},
	{ operation: "hover", capability: "hover", args: [FILE, 0, 1], empty: null },
	{
		operation: "signatureHelp",
		capability: "signatureHelp",
		args: [FILE, 0, 1],
		empty: null,
	},
	{
		operation: "documentSymbol",
		capability: "documentSymbol",
		args: [FILE],
		empty: [],
	},
	{
		operation: "codeAction",
		capability: "codeAction",
		args: [FILE, 0, 1, 0, 2],
		empty: [],
	},
	{
		operation: "rename",
		capability: "rename",
		args: [FILE, 0, 1, "next"],
		empty: null,
	},
	{
		operation: "implementation",
		capability: "implementation",
		args: [FILE, 0, 1],
		empty: [],
	},
	{
		operation: "prepareCallHierarchy",
		capability: "callHierarchy",
		args: [FILE, 0, 1],
		empty: [],
	},
];

function harness(capability: Operation, supported: boolean, empty: unknown) {
	const dispatch = vi.fn().mockResolvedValue(empty);
	const client = {
		getOperationSupport: () => ({
			...EMPTY_SUPPORT,
			[capability]: supported,
		}),
		[capability === "callHierarchy" ? "prepareCallHierarchy" : capability]:
			dispatch,
	};
	const service = new LSPService();
	service.getClientForFile = vi.fn().mockResolvedValue({ client, info: {} });
	return { service, dispatch };
}

describe.each(CASES)(
	"LSPService $operation capability gate (#1826)",
	(testCase) => {
		it("returns the unsupported discriminator without dispatching", async () => {
			const { service, dispatch } = harness(
				testCase.capability,
				false,
				testCase.empty,
			);
			const invoke = (
				service as unknown as Record<
					string,
					(...args: unknown[]) => Promise<unknown>
				>
			)[testCase.operation].bind(service);

			await expect(invoke(...testCase.args)).rejects.toThrow(
				`__UNSUPPORTED__ Active LSP server does not advertise support for ${testCase.operation}`,
			);
			expect(dispatch).not.toHaveBeenCalled();
		});

		it("preserves a supported server's clean empty result", async () => {
			const { service, dispatch } = harness(
				testCase.capability,
				true,
				testCase.empty,
			);
			const invoke = (
				service as unknown as Record<
					string,
					(...args: unknown[]) => Promise<unknown>
				>
			)[testCase.operation].bind(service);

			await expect(invoke(...testCase.args)).resolves.toEqual(testCase.empty);
			expect(dispatch).toHaveBeenCalledWith(...testCase.args);
		});
	},
);
