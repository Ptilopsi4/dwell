// Synthetic failure boundaries for local startup and shutdown acceptance tests.
import "./telegram-main-hook.ts";
import { TelegramBot } from "../src/telegram.ts";

const transport = globalThis.fetch;
const scenario = process.env.DWELL_TEST_OPS;
globalThis.fetch = async (input, init) => {
	const method = new URL(typeof input === "string" || input instanceof URL ? input : input.url).pathname.split("/").at(-1);
	if (scenario === "handshake-wait" && method === "getMe") {
		await new Promise<void>((resolve) => {
			const release = (message: { kind?: string }) => {
				if (message.kind !== "ops-release") return;
				process.removeListener("message", release);
				resolve();
			};
			process.on("message", release);
			process.send?.({ kind: "checkpoint", method: "ops.handshake-waiting", body: {} });
		});
	}
	if ((scenario === "handshake-fatal" && method === "getMe") || (scenario === "poll-fatal" && method === "getUpdates")) {
		process.send?.({ kind: "checkpoint", method: "ops.fatal-response", body: { method } });
		return Response.json({ ok: false, error_code: 401, description: "SYNTHETIC_PRIVATE_DESCRIPTION" }, { status: 401 });
	}
	return transport(input, init);
};

if (scenario === "stalled-close") {
	TelegramBot.prototype.close = async function () {
		process.send?.({ kind: "checkpoint", method: "ops.close-stalled", body: {} });
		await new Promise<void>(() => {});
	};
}
