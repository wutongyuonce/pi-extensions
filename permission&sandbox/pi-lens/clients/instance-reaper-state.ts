/** Directory boundary for the backstop lock and cooldown stamp. Production
 * shares the machine home; the test harness isolates only this state without
 * relocating the registry, installed tools, or other machine-wide stores.
 */
export function resolveBackstopStateDir(machineHome: string): string {
	return machineHome;
}
