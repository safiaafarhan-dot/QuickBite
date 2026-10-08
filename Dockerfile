# QuickBite — single-stage image. The app has no build step: Express serves the
# static front end directly, and SQLite is Node's built-in module.
FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# Install only production dependencies, using the lockfile.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server ./server
COPY public ./public
COPY scripts ./scripts

# The database lives on a volume so it survives container replacement.
# Without this mount, every redeploy starts from an empty database.
RUN mkdir -p /app/data && chown -R node:node /app
VOLUME ["/app/data"]
ENV DB_FILE=/app/data/quickbite.db

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=4s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Migrations run before the server accepts traffic.
CMD ["sh", "-c", "node scripts/migrate.js && node server/index.js"]
