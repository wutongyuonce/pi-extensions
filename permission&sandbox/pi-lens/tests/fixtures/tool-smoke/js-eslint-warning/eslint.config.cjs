// Tool-smoke fixture config (#1954). Modern @eslint/js recommended ships
// every rule at "error" (no rule defaults to "warn" anymore), so the
// realistic exit-0-with-findings shape is a project config that downgrades
// a rule to "warn" — what this file does. languageOptions keeps the ESM
// sample parseable instead of exiting 2 on a config/parse error.
module.exports = [
	{
		languageOptions: { ecmaVersion: 2022, sourceType: "module" },
		rules: { "no-unused-vars": "warn" },
	},
];
