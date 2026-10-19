FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3002

WORKDIR /app

COPY --chown=node:node package.json ./package.json
COPY --chown=node:node server.js ./server.js
COPY --chown=node:node public ./public
RUN mkdir -p /app/data && chown -R node:node /app

USER node
EXPOSE 3002

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server.js"]
