# ---- build ----
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- runtime ----
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV NODE_OPTIONS=--max-old-space-size=384
# Out-of-the-box defaults for local runs and registry introspection sandboxes (e.g. Glama):
# talk to the public SoloWay API and accept any Host header. Production deployments MUST
# pin EXPECTED_HOST to their public hostname (our prod compose sets mcp.soloway.com.ua)
# and point BACKEND_BASE_URL at the internal backend.
ENV BACKEND_BASE_URL=https://soloway.com.ua
ENV EXPECTED_HOST=*
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
RUN chown -R node:node /app
USER node
EXPOSE 8088
# Node global fetch (no BusyBox wget flag drift). Probe /readyz so the container is only
# "healthy" when the backend is reachable too (503 -> unhealthy).
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8088/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
