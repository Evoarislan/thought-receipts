FROM node:20-slim

WORKDIR /app

# Install deps (dev deps needed for the TS build).
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY public ./public
COPY data ./data
RUN npm run build

# Drop dev dependencies for the runtime image.
RUN npm prune --omit=dev

ENV PORT=3003
EXPOSE 3003

CMD ["node", "dist/server.js"]
