FROM node:22-alpine AS base
WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci

# Copy source
COPY . .

# Development stage
FROM base AS development
CMD ["npm", "run", "start:dev"]

# Build stage
FROM base AS build
RUN npm run build

# Production stage
FROM node:22-alpine AS production
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY --from=build /app/dist ./dist
RUN mkdir -p /app/logs && chown node:node /app/logs
USER node
EXPOSE 3000
CMD ["node", "dist/main"]
