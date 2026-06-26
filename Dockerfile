# Multi-stage build for efficiency

# Stage 1: Build
FROM node:26.4-alpine AS builder

WORKDIR /app

# Enable pnpm via corepack (pinned by the packageManager field).
# Node 26 images no longer bundle corepack, so install it first.
RUN npm install -g corepack@latest && corepack enable

# Copy package files and pnpm config
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# Install ALL dependencies (including devDependencies for build)
RUN pnpm install --frozen-lockfile

# Copy source code
COPY tsconfig.json tsconfig.app.json ./
COPY src ./src
COPY migrations ./migrations
COPY scripts ./scripts

# Build TypeScript
RUN pnpm run build

# Prune to production-only dependencies for the runtime image
RUN pnpm prune --prod

# Stage 2: Production
FROM node:26.4-alpine

WORKDIR /app

# Enable pnpm via corepack (pinned by the packageManager field).
# Node 26 images no longer bundle corepack, so install it first.
RUN npm install -g corepack@latest && corepack enable

# Copy package files and pnpm config
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# Create non-root user first
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Copy production dependencies and built application from builder
COPY --from=builder --chown=nodejs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nodejs:nodejs /app/dist ./dist
COPY --from=builder --chown=nodejs:nodejs /app/migrations ./migrations

USER nodejs

# Expose port
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:8080/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Start application
CMD ["node", "dist/index.js"]
