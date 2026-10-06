FROM node:24-alpine
WORKDIR /app
COPY package.docker.json ./package.json
COPY opencode2dsh-api-server.mjs ./
RUN npm install --omit=dev --no-audit --no-fund
ENV OPENCODE2DSH_API_HOST=0.0.0.0 \
    OPENCODE2DSH_API_PORT=8791 \
    OPENCODE2DSH_LOG_DIR=/data/api-logs
EXPOSE 8791
VOLUME ["/data"]
CMD ["node", "opencode2dsh-api-server.mjs"]
