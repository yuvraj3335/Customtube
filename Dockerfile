# Custom Tube: one self-contained image with the app, the data export and the search model,
# so a container starts serving (with semantic search) in a couple of seconds.
#
#   docker build -t customtube .
#   docker run -p 8080:8080 customtube
#
# The data export (ODC-By 1.0, ~18 MB) and the model (~34 MB) are downloaded during the build.

FROM node:22.23.4-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends curl unzip ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build \
 && sh scripts/fetch-data.sh \
 && node scripts/fetch-model.js \
 && npm prune --omit=dev

FROM node:22.23.4-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080
WORKDIR /app
COPY --from=build /app /app
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
# 256 MB of heap keeps the whole process near 400 MB, inside 512 MB free tiers.
CMD ["node", "--max-old-space-size=256", "src/server.js"]
