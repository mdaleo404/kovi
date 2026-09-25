FROM node:22-trixie-slim@sha256:b26b04c123d9ff8ab646ceb18b9d75a1173acf64b9a401094b906d27b29338d4

# kovi does not vendor or copy Calibre code. The container installs Debian's
# unmodified Calibre package and calls its fetch-ebook-metadata CLI as a separate
# process for cover resolution. kovi uses both fetch-ebook-metadata and
# calibre-debug's headless cover-source path so Calibre's cover-only Google
# Images source can run when identification fails.
RUN apt-get update \
 && apt-get install -y --no-install-recommends calibre ca-certificates \
 && rm -rf /var/lib/apt/lists/*

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
