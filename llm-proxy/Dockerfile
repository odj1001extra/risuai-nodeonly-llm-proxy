FROM node:20-slim

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev
COPY src/ ./src/

ENV PORT=6100
ENV BUFFER_TTL_MINUTES=30
ENV MAX_CONCURRENT_REQUESTS=200
ENV MAX_BUFFER_SIZE_MB=512
ENV MAX_REQUEST_BODY_MB=10
ENV RELAY_TIMEOUT_SECONDS=300
ENV RELAY_MAX_RETRIES=2
ENV LOG_LEVEL=info
# Webhook notifications (optional)
ENV WEBHOOK_URL=
ENV WEBHOOK_SECRET=
ENV WEBHOOK_EVENTS=completed,failed,cancelled
# Redis for multi-instance shared state (optional)
ENV REDIS_URL=
ENV REDIS_KEY_PREFIX=llm-proxy
# Custom model pricing JSON (optional)
ENV COST_PRICING_JSON=

EXPOSE 6100

CMD ["node", "src/index.js"]
