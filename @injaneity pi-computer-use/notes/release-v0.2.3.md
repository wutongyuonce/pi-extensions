Stronger AX-only semantic targeting and smoother macOS setup recovery.

## Features

- Added richer AX extraction diagnostics for inspecting semantic target coverage against the underlying AX tree.
- Added SSH-aware setup handling to guide remote sessions toward the GUI helper path when macOS permissions cannot apply to SSH-spawned helpers.

## Resolved issues

- Resolved [#10](https://github.com/injaneity/pi-computer-use/issues/10), where SSH-launched helpers could not satisfy macOS Accessibility/Screen Recording checks despite manual grants, by detecting SSH sessions and routing setup through the GUI helper path.
- Resolved [#9](https://github.com/injaneity/pi-computer-use/issues/9) with clearer setup and recovery guidance for Screen Recording and Accessibility permission grants.

## Changelog

- Added model benchmark matrix artifacts and reporting in `273aedf`.
- Added improved permission-granting setup UX in `dae7a24`.
- Added SSH connection detection that launches the GUI helper instead of relying on the SSH helper in `17c1eb7`.
- Fixed sparse AX target fallback so strong semantic text targets can remain image-free in `e38e6c8`.
- Fixed Firefox and other browser address-bar targeting by treating `AXComboBox` as a browser text field in `e38e6c8`.
- Refactored native AX target diagnostics, scoring, and text-input classification in `e38e6c8`.
- Chore improved setup onboarding copy in `5c01578`.

> “Time is an illusion. Lunchtime doubly so.”
