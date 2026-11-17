// An isolated provider-boundary process for the SIGKILL recovery test; no credentials or network.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { makeBudgetController } from "../src/ext/budget.ts";

const context = BACKGROUND_CONTEXT;
const budget = makeBudgetController({ limits: { modelAdmissions: 2 } });
const faux = fauxProvider();
const models = createModels(); models.setProvider(faux.provider);
const registry = createRegistry(); registry.install(budget.extension);
const harness = await Harness.open(await openNodeSqliteStorage(process.argv[2]!), { models, registry }, context);
await budget.attach(harness);
const conversation = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: "faux", modelId: "faux-1" } } }, context);
faux.setResponses([async () => {
	process.send?.({ boundary: "provider", conversationId: conversation.id });
	await new Promise(() => {});
	return fauxAssistantMessage("unreachable");
}]);
await conversation.submit({ type: "input", content: "crash boundary", requestId: "crash-budget" }, context);
// An unresolved promise alone does not keep Node alive; the IPC channel stays referenced until SIGKILL.
process.on("message", () => {});
