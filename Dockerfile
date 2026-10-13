# QuickBite — single-stage image. The app has no build step: Express serves the
# static front end directly, and the data lives in PostgreSQL.
FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# Install only production dependencies, using the lockfile.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server ./server
COPY public ./public
COPY scripts ./scripts

# No volume and no VOLUME declaration any more. The database is a managed
# PostgreSQL reached over the network, so this container holds no state at all
# and can be replaced, scaled or moved without losing an order. DATABASE_URL is
# supplied at run time and never baked into the image.
RUN chown -R node:node /app

USER node
EXPOSE 3000

# Render and most platforms inject PORT; the server honours it and falls back
# to 3000. The health check must use the same value rather than a hard-coded one.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Migrations run before the server accepts traffic. They are idempotent and
# take a PostgreSQL advisory lock, so two containers starting together is safe.
CMD ["sh", "-c", "node scripts/migrate.js && node server/index.js"]
