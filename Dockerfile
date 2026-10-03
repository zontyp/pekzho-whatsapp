# 📲 pekzho — node:24 runs our .ts straight from src/ (type stripping, no build).
# Small image: pi-agent-core + pi-ai + pg are the only runtime deps (boot-volume friendly 💾).
FROM node:24-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY src ./src

ENV NODE_ENV=production PORT=3000
EXPOSE 3000

# 🙅 run as the image's built-in non-root user
USER node
CMD ["node", "src/server.ts"]
