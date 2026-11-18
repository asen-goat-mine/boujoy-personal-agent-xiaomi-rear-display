FROM node:24-alpine
WORKDIR /app
COPY deploy/relay/package.json deploy/relay/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY src/remote ./src/remote
COPY scripts/run-relay.mjs ./scripts/run-relay.mjs
USER node
ENV PORT=18843 BOUJOY_RELAY_HOST=0.0.0.0 BOUJOY_RELAY_ROUTES=/run/secrets/routes.json
CMD ["node", "scripts/run-relay.mjs"]
