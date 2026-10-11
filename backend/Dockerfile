# Pinned Linux amd64 base image used by the tested release.
FROM node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS build
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
# better-sqlite3 has a native addon. Build it locally so image builds do not
# depend on a downloadable prebuilt binary for the target architecture.
ENV npm_config_build_from_source=true
ENV npm_config_jobs=1
# Official Node images already contain matching headers; avoid downloading
# them again from nodejs.org during the native SQLite addon build.
ENV npm_config_nodedir=/usr/local
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
RUN mkdir -p /app/data && chown -R node:node /app
USER node
EXPOSE 8080
CMD ["node", "dist/server.js"]
