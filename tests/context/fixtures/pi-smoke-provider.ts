import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const faux = fauxProvider({
	provider: "pi-session-smoke",
	api: "pi-session-smoke",
	models: [
		{
			id: "smoke-model",
			name: "Pi Session Smoke Model",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 1_024,
		},
	],
});
faux.setResponses([fauxAssistantMessage("smoke response")]);

export default function (pi: ExtensionAPI): void {
	pi.registerProvider(faux.provider);
}
