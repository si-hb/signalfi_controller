FROM node:22-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

FROM node:22-alpine
WORKDIR /app
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
COPY --from=deps /app/node_modules ./node_modules
COPY server/ ./server/
COPY public/ ./public/
RUN mkdir -p /app/data /app/audio /app/firmware
RUN chown -R appuser:appgroup /app
USER appuser
EXPOSE 3000
ENTRYPOINT ["node", "server/server.js"]
