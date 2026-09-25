# Security Policy

## Reporting a vulnerability

Please do **not** report security vulnerabilities in public issues.

Use GitHub's private vulnerability reporting for this repository if it is enabled,
or contact a maintainer privately with:

- A short description of the vulnerability
- Steps to reproduce or a proof of concept
- The affected version/commit
- Any known workaround

We will acknowledge the report as soon as practical, investigate, and coordinate
a fix and disclosure timeline with the reporter.

## Scope

Security reports are in scope when they affect pi-lens itself, including:

- Unsafe execution of project code or external tools
- Incorrect handling of secrets, tokens, or credentials
- Dangerous GitHub Actions / release workflow behavior
- Vulnerabilities in bundled rules or installed-tool bootstrap paths

For vulnerabilities in third-party tools that pi-lens invokes, please also report
the issue upstream to the tool maintainers.
