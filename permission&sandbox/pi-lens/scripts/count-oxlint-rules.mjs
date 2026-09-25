#!/usr/bin/env node
// Count enabled rules from oxlint's machine-readable --print-config output.
// Malformed or missing evidence returns zero so CI's floor guard fails closed.
import { readFileSync } from "node:fs";

let config;
try {
	config = JSON.parse(readFileSync(0, "utf8"));
} catch {
	console.log("0");
	process.exit(0);
}

const rules = config && typeof config === "object" ? config.rules : undefined;
if (!rules || typeof rules !== "object" || Array.isArray(rules)) {
	console.log("0");
	process.exit(0);
}

const severities = Object.values(rules);
if (
	!severities.every(
		(value) => value === "deny" || value === "warn" || value === "off",
	)
) {
	console.log("0");
	process.exit(0);
}

const enabled = severities.filter((value) => value !== "off").length;
console.log(String(enabled));
