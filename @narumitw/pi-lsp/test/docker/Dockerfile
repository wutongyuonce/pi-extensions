FROM nixos/nix:2.28.4

ARG NIXPKGS_REV=e2587caef70cea85dd97d7daab492899902dbf5d
ARG NIX_PACKAGES
ARG SETUP_COMMAND_B64
ENV NIX_CONFIG="experimental-features = nix-command flakes"

RUN nix profile install "github:NixOS/nixpkgs/${NIXPKGS_REV}#nodejs_22"
RUN if [ -n "${NIX_PACKAGES}" ]; then \
      for package in ${NIX_PACKAGES}; do \
        nix profile install "github:NixOS/nixpkgs/${NIXPKGS_REV}#${package}"; \
      done; \
    fi
RUN if [ -n "${SETUP_COMMAND_B64}" ]; then \
      printf '%s' "${SETUP_COMMAND_B64}" | base64 -d | bash -eu; \
    fi

WORKDIR /smoke
COPY extensions/pi-lsp/test/docker/package.json extensions/pi-lsp/test/docker/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY extensions/pi-lsp ./pi-lsp

ENTRYPOINT ["node", "/smoke/pi-lsp/test/docker/run-smoke.mjs"]
