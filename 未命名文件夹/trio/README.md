# Trio for Pi

A single-session planner → executor → reviewer workflow for [pi](https://pi.dev). Trio keeps one shared conversation and working tree while switching models between phases.

<img width="569" height="922" alt="CleanShot 2026-07-13 at 17 31 31" src="https://github.com/user-attachments/assets/d40e376e-b9c9-4478-9cff-e64eaf6a6339" />



## Install

```bash
pi install git:github.com/jnsahaj/trio
```

## Get Started
```bash
pi
/trio setup
```

Configuration is saved to `~/.pi/agent/trio.json`. Run `/trio setup` to choose again, or edit that file to change role models and optional role settings.

Roles accept optional `thinkingLevel` and `systemPrompt` fields. The optional top-level `maxReviewRounds` field sets a review-round cap. A standalone configuration includes a provider and model for all three roles. A project-local `.pi/trio.json` can override fields from a complete global configuration.

Other commands: `/trio status`, `/trio config`, `/trio stop`.
