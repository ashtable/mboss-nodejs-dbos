FROM node:24.18.0-slim

WORKDIR /app

# The nested sources are the targets of the tsconfig path aliases tsx resolves at run time, so
# they have to be in place before the install layer everything else caches on.
COPY package.json package-lock.json ./
COPY mboss-zod ./mboss-zod
COPY mboss-core ./mboss-core
RUN npm ci

COPY . .

ENTRYPOINT ["./docker-entrypoint.sh"]
