Root-forest desktop control architecture release.

## Features

- Reworked the public desktop flow around root refs, atomic observe snapshots, searchable folded outlines, scoped inspection, and typed helper-owned act transactions.
- Added root delta reporting and adaptive settling so helpers can report appeared, closed, and focused roots without extra bridge-side sleeps.
- Hardened macOS root handling for sheets, dialogs, menus, focused windows, transient root identity, and snapshot-authoritative delta settling.
- Preserved stable macOS helper permissions across rebuilds and releases by avoiding unnecessary helper app replacement.

## Changelog

- fixed release workflow commit validation, changelog generation, and dependency metadata in `9b4e2ee` and `ee81b3d`.
- split the platform backend seam and made observe/act result contracts explicit in `6d4d393`, `f42d47b`, `b497ab8`, `4e342fd`, and `fd76ef4`.
- added the cubench Pi client for behavioral benchmarking in `42a9cb9`.
- moved macOS permission handling behind the platform seam and restored permission constraints in `5ae0945` and `26376f3`.
- removed the ignored `set_text` method parameter in `03822a7`.
- refactored the desktop targeting model from windows to roots in `b1ae46e`.
- completed the root-forest platform seam and macOS helper behavior in `deb29fc`.
- preserved helper TCC grants when the signing identity is unchanged in `2c42013`.
- fixed macOS transient root identity and sheet discovery in `212b74c` and `4c8da3a`.
- added AXObserver-driven root deltas with snapshot fallback in `f179eea`.
- optimized settle behavior when helpers report their own delta source in `d3ae90f`.
- fixed macOS root deltas to use snapshot-authoritative CG-poll early exit in `022a280`.
- chore prepared the v0.4.1 release.

> "The ships hung in the sky in much the same way that bricks don't."
