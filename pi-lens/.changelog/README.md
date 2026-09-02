# Per-entry changelog files

Each user-facing change gets one Markdown file in this directory. The file name
must be `<branch-or-slug>-<short-desc>.md`, for example
`feat-1321-changelog-entries.md`.

Use YAML front matter to select one Keep a Changelog section, followed by one
entry in any of the repository's existing styles:

```markdown
---
section: Fixed
---

- **Short title (closes #1321)** — Explain the user-visible change.
```

`section` must be `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, or
`Security`. The entry may use a `-` or `*` bullet, bold or plain text, and an
em dash, period, or no title separator. Continuation lines and nested bullets
are preserved; each file must contain exactly one top-level entry.

Entry files must land through a PR even though the repository permits direct
pushes for other docs-only changes. At version-bump time,
`npm run changelog:release` folds the populated `Unreleased` section and every
entry file into the new version section, then removes the entry files while
retaining this README. The tag-time release workflow only verifies that this
rollup has already happened.
