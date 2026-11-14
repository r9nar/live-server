# syntax=docker/dockerfile:1

# --- build: compile TypeScript (Node >= 22.19 for undici) ---
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY discipline ./discipline
RUN npm run build

# --- runtime: only production deps + dist ---
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
EXPOSE 4000
CMD ["node", "dist/server/main.js"]
