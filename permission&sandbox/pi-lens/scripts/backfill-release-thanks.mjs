#!/usr/bin/env node
// Append a "🙏 Thanks" block to GitHub release bodies crediting each release's
// external contributors (merged-PR authors other than the repo owner and bots).
//
// A release's contributors are the PRs merged between the previous version tag
// and its own tag. The maintainer and bots (dependabot, github-actions,
// all-contributors, renovate, any `*[bot]`/`app/*`) are excluded. Idempotent:
// a release that already has a Thanks block is skipped, so re-running only fills
// in newly-created releases.
//
//   node scripts/backfill-release-thanks.mjs            # DRY RUN (default): show plan
//   node scripts/backfill-release-thanks.mjs --apply    # edit release bodies
//   node scripts/backfill-release-thanks.mjs --apply --only v3.8.60,v3.8.61
//   node scripts/backfill-release-thanks.mjs --owner apmantza --repo owner/name --apply
//
// Credits merged-PR authors only — the reliably per-release-attributable signal.
// Issue reporters are not backfilled (which closed issue shipped in which
// release, and by whom, is not cleanly derivable). Requires the `gh` CLI
// authenticated and a local clone with the version tags fetched (`git fetch --tags`).

import { execFileSync } from "node:child_process";

function parseArgs(argv) {
	const args = {
		apply: false,
		repo: undefined,
		owner: undefined,
		only: undefined,
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--apply") args.apply = true;
		else if (a === "--repo") args.repo = argv[++i];
		else if (a === "--owner") args.owner = argv[++i];
		else if (a === "--only") args.only = new Set(argv[++i].split(","));
	}
	return args;
}

const sh = (cmd, cmdArgs, input) =>
	execFileSync(cmd, cmdArgs, {
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
		...(input !== undefined ? { input } : {}),
	});

const gh = (ghArgs, repo, input) =>
	sh("gh", repo ? [...ghArgs, "--repo", repo] : ghArgs, input);

function repoOwner(repo) {
	const out = sh("gh", [
		"repo",
		"view",
		...(repo ? [repo] : []),
		"--json",
		"owner",
		"--jq",
		".owner.login",
	]).trim();
	return out;
}

const isBot = (login, owner) =>
	!login ||
	login === owner ||
	/\[bot\]$/i.test(login) ||
	/^app\//i.test(login) ||
	/dependabot|github-actions|all-contributors|actions-user|renovate/i.test(
		login,
	);

function thanksBlock(byAuthor) {
	const lines = [...byAuthor.entries()]
		.sort((a, b) => a[0].localeCompare(b[0]))
		.map(
			([login, nums]) =>
				`- @${login} — ${nums
					.sort((a, b) => a - b)
					.map((n) => `#${n}`)
					.join(", ")}`,
		);
	return `### 🙏 Thanks\n\nThanks to the external contributors in this release:\n\n${lines.join("\n")}`;
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	const owner = args.owner ?? repoOwner(args.repo);

	const prs = JSON.parse(
		gh(
			[
				"pr",
				"list",
				"--state",
				"merged",
				"--limit",
				"2000",
				"--json",
				"number,author,mergedAt,title",
			],
			args.repo,
		),
	).filter((p) => p.mergedAt);

	const tags = sh("git", [
		"for-each-ref",
		"--sort=creatordate",
		"--format=%(refname:short)|%(creatordate:iso-strict)",
		"refs/tags/v*",
	])
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((l) => {
			const [tag, date] = l.split("|");
			return { tag, date: new Date(date).getTime() };
		});

	let prevDate = 0;
	const plan = [];
	for (const { tag, date } of tags) {
		const inWindow = prs.filter((p) => {
			const t = new Date(p.mergedAt).getTime();
			return t > prevDate && t <= date;
		});
		prevDate = date;
		if (args.only && !args.only.has(tag)) continue;
		const byAuthor = new Map();
		for (const p of inWindow) {
			const login = p.author?.login;
			if (isBot(login, owner)) continue;
			if (!byAuthor.has(login)) byAuthor.set(login, []);
			byAuthor.get(login).push(p.number);
		}
		if (byAuthor.size > 0) plan.push({ tag, byAuthor });
	}

	console.log(
		`Owner (excluded): ${owner}\nPlanned thanks for ${plan.length} release(s):\n`,
	);
	for (const { tag, byAuthor } of plan) {
		console.log(
			`${tag}: ${[...byAuthor.keys()].map((l) => "@" + l).join(", ")}`,
		);
	}

	if (!args.apply) {
		console.log("\n(dry-run — pass --apply to write release bodies)");
		return;
	}

	let edited = 0,
		skipped = 0,
		missing = 0;
	console.log("");
	for (const { tag, byAuthor } of plan) {
		let body;
		try {
			body = JSON.parse(
				gh(["release", "view", tag, "--json", "body"], args.repo),
			).body;
		} catch {
			console.log(`  ${tag}: no GitHub release — skip`);
			missing++;
			continue;
		}
		if (/🙏\s*Thanks/i.test(body) || /###\s*Thanks/i.test(body)) {
			skipped++;
			continue;
		}
		const next = `${body.trimEnd()}\n\n${thanksBlock(byAuthor)}\n`;
		gh(["release", "edit", tag, "--notes-file", "-"], args.repo, next);
		console.log(`  ${tag}: added thanks (${[...byAuthor.keys()].join(", ")})`);
		edited++;
	}
	console.log(
		`\nDone. edited=${edited} skipped(existing)=${skipped} missing-release=${missing}`,
	);
}

main();
