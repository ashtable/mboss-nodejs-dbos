FROM node:24.18.0-slim

WORKDIR /app

# git, to clone the two nested repos below.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# The nested repos are submodules here, and they
# are cloned rather than copied from the build
# context. Railway initialises no submodules and
# ships no .git, so there both paths arrive as
# empty directories — and nothing says so. They
# are the targets of the tsconfig path aliases tsx
# resolves at run time, so the build stays green
# and the worker throws on the first workflow that
# reaches an import.
#
# .dockerignore excludes both so that a local
# build takes this same path. One image, built the
# same way everywhere, is worth more than picking
# up uncommitted edits to a nested repo — which
# the deployed image could never have seen anyway.
#
# Pinned to the exact commits the gitlinks name,
# so the image is as reproducible as the
# submodules are; a branch would move underneath
# it. Move each REF in the same commit that moves
# its submodule.
ARG MBOSS_ZOD_REF=8f1ee5053aa564d1ce0d246c387ab86ea2002de7
ARG MBOSS_CORE_REF=5bb3239f9a6d77f2cead6e29a36fccbf1a4044b2
RUN git clone https://github.com/ashtable/mboss-zod.git mboss-zod \
  && git -C mboss-zod checkout --quiet "${MBOSS_ZOD_REF}" \
  && rm -rf mboss-zod/.git \
  && git clone https://github.com/ashtable/mboss-core.git mboss-core \
  && git -C mboss-core checkout --quiet "${MBOSS_CORE_REF}" \
  && rm -rf mboss-core/.git

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

ENTRYPOINT ["./docker-entrypoint.sh"]
