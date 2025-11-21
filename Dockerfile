# Stage 1: Build
FROM node:24-alpine AS builder
RUN apk add --no-cache tzdata
WORKDIR /app

# Enable corepack for yarn
RUN corepack enable

# Copy package files
COPY package.json yarn.lock .yarnrc.yml ./
# COPY .yarn ./.yarn

# Install dependencies
RUN yarn install --immutable

# Copy source code and configuration
COPY tsconfig.json ./
COPY prisma ./prisma
COPY src ./src
COPY tools ./tools

# Build application (generates Prisma Client and compiles TypeScript)
RUN yarn build:openapi
RUN yarn build

# Stage 3: Production
FROM node:24-alpine AS runner
RUN apk add --no-cache tzdata
WORKDIR /app

# Enable corepack for yarn
RUN corepack enable

# Copy package files for production dependencies
COPY package.json yarn.lock .yarnrc.yml ./
# COPY .yarn ./.yarn

# Install production dependencies only
RUN yarn workspaces focus --production

# Copy built application from builder
COPY --from=builder /app/dist ./dist

# Copy prisma schema for runtime
COPY prisma ./prisma

ENV NODE_ENV=production

CMD ["node", "./dist/main.js"]
