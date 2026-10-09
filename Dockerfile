FROM node:22-trixie-slim@sha256:154ba2f4d6fec323d28e4f4bb86bba4677f1223391a1979cf521304e03a98dfa

# kovi does not vendor or copy Calibre code. The container installs Debian's
# unmodified Calibre package and calls its fetch-ebook-metadata CLI as a separate
# process for cover resolution. kovi uses both fetch-ebook-metadata and
# calibre-debug's headless cover-source path so Calibre's cover-only Google
# Images source can run when identification fails.
RUN apt-get update \
 && apt-get install -y --no-install-recommends calibre ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Remove npm/Corepack so their bundled dependency trees are not shipped in the
# runtime image and flagged by image scanners.
RUN rm -rf /usr/local/lib/node_modules/npm \
           /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm \
           /usr/local/bin/npx \
           /usr/local/bin/corepack \
           /usr/local/bin/yarn \
           /usr/local/bin/yarnpkg \
           /usr/local/bin/pnpm

WORKDIR /app
COPY package.json server.mjs ./
COPY lib ./lib
COPY public ./public
COPY plugins ./plugins
RUN mkdir -p /app/data/uploads /app/data/covers && chown -R node:node /app
USER node
ENV HOST=0.0.0.0 PORT=3000 DATA_PATH=/app/data TZ=UTC CALIBRE_COVER_RESOLVER=auto
VOLUME ["/app/data"]
EXPOSE 3000
CMD ["node","server.mjs"]
