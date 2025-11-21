# Companion Updates API

Updates and metrics collection server for Companion.

Available at: https://updates.companion.free

## Development

```bash
# Install dependencies
yarn install

# Run development server
yarn dev

# Build
yarn build
```

## Database

Uses Prisma for database management.

```bash
# Generate Prisma Client
yarn db:generate

# Push schema changes
yarn db:push
```

## Docker

```bash
# Build image
docker build -t companion-updates-api .

# Run container
docker run -p 3000:3000 companion-updates-api
```
