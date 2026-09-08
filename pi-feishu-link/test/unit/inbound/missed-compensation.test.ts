import test from "node:test";
import assert from "node:assert/strict";
import {
	MissedMessageCompensation,
	type CompensationOptions,
} from "../../../src/inbound/missed-compensation.ts";
import type { FeishuInboundMessage } from "../../../src/common/types.ts";

function rawMsg(
	id: string,
	sender = "user",
	chatType = "p2p",
): Record<string, unknown> {
	return {
		message_id: id,
		chat_id: `oc_${id}`,
		chat_type: chatType,
		message_type: "text",
		content: JSON.stringify({ text: `msg ${id}` }),
		sender: { sender_type: sender, sender_id: { open_id: `ou_${id}` } },
		create_time: String(Date.now()),
	};
}

function makeCompensation(
	overrides: Partial<
		ConstructorParameters<typeof MissedMessageCompensation>[1]
	> = {},
) {
	let now = 1_000_000;
	const admitted = new Set<string>();
	const injected: string[] = [];
	const comp = new MissedMessageCompensation(
		{
			listChatMessages: async (_chatId, _opts) => [],
			knownChatIds: () => [],
			admitMessage: (id) => {
				if (admitted.has(id)) return false;
				admitted.add(id);
				return true;
			},
			onMessage: async (msg) => {
				injected.push(msg.messageId);
			},
			normalize: (raw) => {
				const m = raw as {
					message_id?: string;
					chat_id?: string;
					sender?: { sender_type?: string };
				};
				if (!m.message_id) return undefined;
				return {
					messageId: m.message_id,
					chatId: m.chat_id ?? "",
					chatType: "p2p",
					chatMode: "p2p",
					senderOpenId: "ou_x",
					senderType: m.sender?.sender_type ?? "user",
					msgType: "text",
					content: "",
					timestamp: Date.now(),
				} satisfies FeishuInboundMessage;
			},
			now: () => now,
		},
		{ ...overrides },
	);
	return {
		comp,
		injected,
		admitted,
		advance: (ms: number) => {
			now += ms;
		},
	};
}

test("disabled compensation does nothing", async () => {
	const { comp, injected } = makeCompensation({ enabled: false });
	assert.equal(await comp.compensate(60_000), 0);
	assert.equal(injected.length, 0);
});

test("short outage below minOutageMs is skipped", async () => {
	const { comp } = makeCompensation({ minOutageMs: 10_000 });
	assert.equal(await comp.compensate(3_000), 0);
});

test("recovers unseen messages and skips seen ones", async () => {
	const { comp, admitted, injected } = makeCompensation();
	// Pre-admit msg-2 so it is treated as already seen.
	admitted.add("om_2");
	comp["deps"].listChatMessages = async (_chatId, opts) => {
		assert.ok(opts.startTimeMs, "lookback window passed");
		return [rawMsg("om_1"), rawMsg("om_2"), rawMsg("om_3")];
	};
	comp["deps"].knownChatIds = () => ["oc_1", "oc_2"];
	const recovered = await comp.compensate(30_000);
	assert.equal(recovered, 2);
	assert.deepEqual(injected.sort(), ["om_1", "om_3"]);
});

test("bot-originated messages are never injected", async () => {
	const { comp, injected } = makeCompensation();
	comp["deps"].listChatMessages = async () => [rawMsg("om_bot", "bot")];
	comp["deps"].knownChatIds = () => ["oc_1"];
	const recovered = await comp.compensate(30_000);
	assert.equal(recovered, 0);
	assert.equal(injected.length, 0);
});

test("list failure is caught and counted as zero for that chat", async () => {
	const { comp, injected } = makeCompensation();
	comp["deps"].listChatMessages = async () => {
		throw new Error("api 403");
	};
	comp["deps"].knownChatIds = () => ["oc_1"];
	assert.equal(await comp.compensate(30_000), 0);
	assert.equal(injected.length, 0);
});

test("malformed items are skipped", async () => {
	const { comp, injected } = makeCompensation();
	comp["deps"].listChatMessages = async () => [
		{ no_message_id: true },
		rawMsg("om_ok"),
	];
	comp["deps"].knownChatIds = () => ["oc_1"];
	assert.equal(await comp.compensate(30_000), 1);
	assert.deepEqual(injected, ["om_ok"]);
});

test("C2: injected messages carry skipDedupe so the pipeline does not drop them", async () => {
	const injected: Array<{ msg: string; skipDedupe?: boolean }> = [];
	const opts: CompensationOptions = {
		enabled: true,
		lookbackMs: 60_000,
		maxPerChat: 5,
		minOutageMs: 0,
	};
	const comp = new MissedMessageCompensation(
		{
			listChatMessages: async () => [
				{ message_id: "m1", sender: { sender_type: "user" } },
			],
			knownChatIds: () => ["oc_1"],
			admitMessage: () => true,
			onMessage: async (msg, o) => {
				injected.push({ msg: msg.messageId, skipDedupe: o?.skipDedupe });
			},
			normalize: (raw) =>
				({
					messageId: String(raw.message_id),
					chatId: "oc_1",
					chatType: "p2p",
					chatMode: "p2p",
					senderOpenId: "ou_1",
					senderType: "user",
					msgType: "text",
					content: "",
					timestamp: 0,
				}) as FeishuInboundMessage,
		},
		opts,
	);
	const n = await comp.compensate(60_000);
	assert.equal(n, 1);
	assert.equal(injected[0]?.skipDedupe, true);
});
