import fs from "node:fs";
import path from "node:path";

const [, barrier, root] = process.argv.slice(2);
while (!fs.existsSync(barrier)) await new Promise((resolve) => setTimeout(resolve, 1));
const { registerInstance } = await import("../../clients/instance-registry.js");
await registerInstance(root);
process.stdout.write("registered\n");
