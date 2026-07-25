Windows root-forest bridge and release-pipeline support.

## Features

- Added first-class Windows support: a Rust UIA bridge, TypeScript Windows backend/helper integration, root-forest observation, screenshot capture, UIA grounding, act dispatch, and scoped root deltas.
- Added Windows native build and install flow, including `build-native.mjs --platform windows`, postinstall prebuilt installation, optional source-build fallback, and release-pipeline injection of `prebuilt/windows/windows-bridge.exe`.
- Kept the platform seam neutral while aligning macOS and Windows around `find_roots`, `observe_ui`, and `act_ui` root-forest contracts.
- Expanded Windows documentation, troubleshooting, development notes, and README coverage.

## Changelog

- refactored platform contracts and call sites for a platform-neutral root-forest seam across `src/platform/*`, `src/bridge.ts`, `src/contract.ts`, and `extensions/computer-use.ts` in `ec6395c`.
- fixed CI invariants for the simplified seam and bounded macOS semantic-tree walking in `ebfc888` and `4cf8b41`.
- renamed public tools from `find`, `observe`, and `act` to `find_roots`, `observe_ui`, and `act_ui` across extension schemas, docs, and bridge code in `41b6f5b`.
- added the Windows Rust bridge crate, protocol/state/ref tests, UIA traversal, capture, input dispatch, and window helpers under `native/windows/bridge-rs` in `8f429f3`, `c903522`, and `c04bb4f`.
- wired Windows backend selection, helper spawning, setup/install behavior, build scripts, and static platform checks in `96664eb`, `0c9ec73`, `84743d5`, and `2f3f47b`.
- fixed Windows UIA occlusion, ancestor comparison, delta scoping, ref lookup performance, seam annotations, and grounding metadata in `d8d7b41`, `174ad69`, and `495b4be`.
- documented Windows root-forest acceptance, live UIA acceptance, configuration, troubleshooting, and README support in `b34f987`, `8e8ed9b`, and `3984f04`.
- updated release validation and packaging so docs/perf commits are accepted, Rust build artifacts stay out of npm, and the release pipeline publishes `windows-bridge.exe` alongside macOS helper assets in `c563352`, `8877f00`, and `2f3f47b`.

> "Don't Panic."
