Stable helper permissions and rebuilt observe/act architecture release.

## Features

- Reworked the computer-use flow around atomic `observe` snapshots, searchable folded outlines, scoped inspection, and helper-owned `act` transactions.
- Moved macOS permission attribution to the canonical `/Applications/pi-computer-use.app` helper identity so Accessibility and Screen Recording grants attach to the right app.
- Improved input delivery, grounding, helper-side preflight, execution feedback, and permission recovery guidance.
- Added signed helper release packaging so installs can preserve macOS TCC grants across helper updates.

## Changelog

- added the rewritten computer-use look and act architecture in `c3b1da6`.
- refactored helper app permissioning around the canonical signed app identity in `ed1098e`.
- added improved input delivery and grounding in `d4f4fac`.
- consolidated architecture documentation in `c44a6a6`.
- simplified the computer-use introduction in `d45aabf`.
- hardened CI checks and split the npm audit workflow in `25d85ff`.
- added release staging for the signed helper before npm publication in `f1b22be`.
- moved release publishing through npm trusted publishing in `d6ebbf0`.
- chore prepared the v0.4.0 release in `606a621`.

> "Don't Panic."
