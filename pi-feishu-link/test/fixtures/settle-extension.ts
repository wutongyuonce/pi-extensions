// Test fixture: exits the pi process shortly after session_start so CLI
// smoke tests don't require a model/API key.
export default function settle(pi: unknown) {
	const api = pi as { on(event: string, handler: () => void): void };
	api.on("session_start", () => {
		setTimeout(() => process.exit(0), 500);
	});
}
