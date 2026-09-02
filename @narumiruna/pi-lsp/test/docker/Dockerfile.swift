FROM node:22.23.1-bookworm-slim AS node
FROM swift:6.1.3-jammy

COPY --from=node /usr/local/ /usr/local/
WORKDIR /smoke
COPY packages/pi-lsp/test/docker/package.json packages/pi-lsp/test/docker/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY packages/pi-lsp ./pi-lsp
ENTRYPOINT ["node", "/smoke/pi-lsp/test/docker/run-smoke.mjs"]
