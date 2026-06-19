# Review Room — Fly.io image.
# One long-lived Node process: Express + /ws (Hocuspocus collab) + /mcp.
# Mirrors `npm run serve` (tsx server/index.ts). See the implementation guide:
# "Fly.io Migration Plan".

FROM node:20-slim

WORKDIR /app

ARG GIT_COMMIT_SHA
ARG BUILD_RELEASE_DATE

# Build toolchain for better-sqlite3's native addon.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Install deps first for layer caching. NODE_ENV is intentionally left unset here
# so devDependencies (vite for the build, tsx for `npm run serve`) are installed.
COPY package*.json ./
RUN npm ci

# App source. node_modules, dist, snapshots, and *.db* are excluded via .dockerignore.
COPY . .

# Produces dist/ plus .proof-build-info.json for /health build metadata.
RUN npm run build

ENV NODE_ENV=production \
    PORT=8080 \
    PROOF_BUILD_SHA=$GIT_COMMIT_SHA
EXPOSE 8080

CMD ["npm", "run", "serve"]
