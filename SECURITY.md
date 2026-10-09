# kovi security model

kovi is designed for personal/self-hosted deployments. It intentionally avoids accounts in the MVP, so the web UI should be treated like an administrative interface: do not expose it directly to the public internet without an authenticated reverse proxy or private network such as Tailscale.

The default deployment is therefore unauthenticated: read endpoints, CSV/Markdown exports, and `/api/backup` are reachable by any client that can connect. kovi mitigates abuse — a same-origin CSRF token, a bounded per-source pairing rate limit, explicit request timeouts, a single-flight backup guard, and throttled plugin-ping logging — but none of these authenticate a caller. Network reachability is the access-control boundary.

## Import safety

- Browser database uploads use a raw `PUT` body and are streamed into a unique, mode-0600 temporary file.
- The maximum upload size is enforced while streaming.
- The SQLite magic header, `PRAGMA quick_check`, required table names, and required columns are verified before import.
- The source database is opened read-only.
- Imports are transactional and source-file hashes make exact re-uploads idempotent.
- Temporary uploads are removed in a `finally` path after success or failure.

## Plugin safety

- KOReader devices pair with a one-use code that expires after 10 minutes.
- Pairing attempts are rate limited per client address (30 per 10-minute window), and the in-memory attempt table is bounded, so an unauthenticated client cannot grow it without limit.
- Successful pairing issues a random per-device bearer token; only its SHA-256 hash is stored.
- Tokens are independently revocable from the Devices screen.
- Plugin JSON has strict request-size and row-count limits.
- Missing-cover uploads are authenticated with the same per-device token, require the source book MD5, are capped at 4 MB per image, and are accepted only for a book kovi already knows.
- Highlight/note text is read locally from KOReader book sidecars during an authenticated plugin sync; it is stored only in kovi's local SQLite database.
- Pairing status polling uses a random high-entropy request ID; pairing codes and bearer tokens are not returned by the status endpoint or written to logs.

## Cover safety

- Automatic cover discovery talks to fixed HTTPS Open Library endpoints and the Google Books API. When Calibre identifies a stable Google Books volume id, kovi may fetch the corresponding fixed `books.google.com` cover URL. `GOOGLE_BOOKS_API_KEY` is optional and raises the available Google Books quota. Google-hosted images are accepted only for high-confidence matches and only from allowlisted hosts.
- A paired KOReader may upload the exact embedded ebook cover only when the authenticated server requests missing covers during sync.
- The browser may upload a manual cover only through a same-origin, CSRF-protected book endpoint; uploads are capped at 4 MB and must match an accepted image magic signature.
- Cover downloads/uploads have timeout and size limits.
- Only JPEG, PNG, WebP, and GIF magic signatures are accepted; SVG/HTML are rejected.
- Covers are served locally with `nosniff` and a restrictive Content Security Policy.
- Cover retries and provider outcomes are logged, but downloaded remote URLs are not exposed through a generic proxy endpoint.

## Network boundary

The application does not enable permissive CORS. Browser API access is same-origin. The intentional outbound traffic is automatic cover lookup against Open Library, the Google Books API, Calibre metadata providers, and fixed Google Books cover URLs learned from Calibre identifiers. Plugin cover uploads are inbound, authenticated device requests.

`TRUST_PROXY` is an opt-in integer defaulting to `0`. At `0` — and for any non-numeric value — kovi ignores `X-Forwarded-For` and keys rate limits and log fields on the socket peer, so a spoofed header changes nothing. Set it only to the exact number of reverse-proxy hops you operate; kovi then resolves the client address from `X-Forwarded-For`, validates the selected hop as a literal IP address, and falls back to the socket peer when the chain is too short or the value is not an IP. This changes client-address resolution only; it is not authentication or access control.

## Calibre cover resolver

kovi can invoke Debian's unmodified `fetch-ebook-metadata` and `calibre-debug` executables as separate, non-root subprocesses when native cover sources fail. The second subprocess runs a fixed Calibre cover-downloader command so Calibre's cover-only sources (notably Google Images) can run even when metadata identification fails. Book title/author/ISBN values are passed using Node's `execFile` argument array or fixed environment variables consumed by fixed Python code; kovi does not interpolate ebook metadata into executable source or a shell command. Each invocation has a timeout and output cap, uses a private temporary Calibre configuration directory, and its returned file is independently checked for supported image magic bytes and size before being cached. When Calibre identifies a Google Books ID but cannot download the image itself, kovi may request Calibre's documented fixed Google Books cover URL on `books.google.com`; redirects stay restricted to allowlisted Google Books/Googleusercontent hosts, known Google dummy-cover hashes are rejected, and the same image type/size checks still apply. Set `CALIBRE_COVER_RESOLVER=false` to disable this fallback.
