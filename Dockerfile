FROM node:22-bookworm-slim

WORKDIR /app

# The app has zero runtime dependencies; copy the manifest so npm ci stays a
# reproducible no-op and the container metadata matches the repository.
COPY package.json package-lock.json .nvmrc ./
COPY src ./src
COPY public ./public
COPY policies ./policies
COPY openapi ./openapi
COPY scripts ./scripts
COPY tests ./tests
COPY docs ./docs
COPY postman ./postman
COPY README.md LICENSE ./

RUN npm ci --ignore-scripts --no-audit --no-fund \
  && chown -R node:node /app

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
