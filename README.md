[![Licence](https://img.shields.io/badge/GPL--3.0--only-orange?label=Licence)](https://git.sysmd.uk/mdaleo404/kovi/src/branch/main/LICENSE)
[![Gitea Release](https://img.shields.io/gitea/v/release/mdaleo404/kovi?gitea_url=https%3A%2F%2Fgit.sysmd.uk%2F&style=flat&color=orange&logo=gitea)](https://git.sysmd.uk/mdaleo404/kovi/releases)
[![Node.js](https://img.shields.io/badge/Node.js-22%2B-339933?logo=node.js&logoColor=white&style=flat)](https://nodejs.org/)

# kovi

<div align="center">
  <img src="https://git.sysmd.uk/mdaleo404/kovi/raw/branch/main/public/kovi-logo.png" alt="kovi logo" width="256" />
</div>

**Your KOReader history, beautifully understood.**

kovi is a local-first, self-hosted reading dashboard for KOReader. It keeps the two deliberately simple ingestion methods—manual upload of KOReader's statistics SQLite database and a KOReader plugin—while making the import path defensive, device sync authenticated, and cover enrichment automatic.

## Features

- Manual drag-and-drop of `statistics.sqlite` / `statistics.sqlite3`
- Streamed unique temporary uploads; no shared upload filename
- SQLite header, integrity, table and column validation
- Read-only source DB and transactional/idempotent import
- Automatic exclusion of the KOReader user guide/manual
- Cover-first library and dedicated `/books/:id` book pages
- Persisted library sorting plus unread, in-progress, and completed filters
- Explicit read/unread status that preserves actual document progress, with KOReader sidecar sync and manual kovi overrides
- Date-range Books read metric counting books both first started and completed within the selected range
- Real highlight/note text after KOReader plugin sync
- Filterable, no-scroll reading rhythm heatmap (last week/month/3 months/6 months/year or custom dates)
- Interactive daily reading-time line graph with hover/tap values using the same date range as the heatmap
- Dedicated `/calendar` page with month navigation and per-day book/time details
- Exact embedded ebook covers uploaded from paired KOReader devices when online matching is missing
- ISBN-first cover matching when KOReader sidecar metadata exposes an ISBN
- Parallel Open Library + Google Books cover discovery with local caching and transient-network retries
- Calibre-backed multi-source cover fallback in the container (Google Books, Google Images, Amazon, Open Library, and other configured Calibre sources)
- Edition-aware and language-aware cover matching, including Italian titles
- Per-book and global cover retry actions, with durable queued/running/completed job state
- Cover manager with online alternatives, cover history/revert, and manual upload
- Incremental KOReader plugin sync: full first sync, then a one-day reading-stat overlap plus changed annotation sidecars only
- KOReader plugin sync for books, reading sessions and annotation sidecars
- 10-minute one-use pairing codes + per-device bearer tokens
- Browser pairing state that updates automatically when the reader pairs
- Device list and token revocation
- Status page with recent sync/import diagnostics and local storage totals
- One-click `.tar.gz` backup plus CSV and Markdown exports
- Structured, human-readable server logs for imports, pairing, syncs, covers and failures
- Responsive light/dark interface, including the theme switch on mobile
- One-process / one-SQLite deployment; no Redis or external database

## Run it

Requires Node.js 22+ (kovi uses Node's built-in SQLite module, which currently emits an experimental-module warning in Node 22).

```bash
npm start
```

Open `http://localhost:3000` and import your KOReader database.

### Docker

The default `docker-compose.yml` uses a container-managed named volume so the app can stay non-root without host-directory UID or SELinux issues.

The container installs Debian's unmodified Calibre package (GPLv3; see `THIRD_PARTY_NOTICES.md`). kovi first uses `fetch-ebook-metadata` for Calibre's normal identify→cover flow and, if identification returns nothing, runs `calibre-debug`'s cover-only downloader so sources such as Google Images still get a chance. The image is larger because it ships Calibre, but the cover logic stays maintained by Calibre rather than duplicating its provider scrapers in kovi.

```bash
docker compose up --build -d
```

The application DB and cached covers live in the `kovi-data` named volume. Removing/recreating the container does **not** remove that volume. Do not use `down -v` unless you intentionally want to delete kovi's data.

To follow kovi's event log:

```bash
docker compose logs -f kovi
```

You will see useful events such as `import.sqlite.start`, `import.sqlite.complete`, `plugin.pair.success`, `plugin.sync.complete`, `cover.retry.book`, `cover.lookup.matched`, `cover.download.rejected`, `cover.calibre.start`, `cover.calibre.attempt`, `cover.calibre.matched`, `cover.embedded.saved`, and `cover.lookup.none`. Sensitive pairing codes and bearer tokens are not logged.

## Manual import

1. Copy KOReader's statistics database from the reader's settings directory to your computer. Depending on KOReader version/device it is normally named `statistics.sqlite3`.
2. Open kovi and choose **Import KOReader data**.
3. Drop the database file onto the importer.
4. kovi validates/imports it, excludes the KOReader user guide, and queues cover matching.

The original database is never modified. The temporary upload is deleted after the import attempt.

### Highlights and manual imports

KOReader's statistics database contains highlight/note **counts**, but the actual highlighted text is stored in each book's `.sdr` sidecar metadata. Therefore:

- manual SQLite upload can show that a book has highlights;
- the kovi plugin sync brings the actual highlight/note text into kovi;
- book pages show the synced passages instead of a recent-session list.

## KOReader plugin

Copy the entire `plugins/kovi.koplugin` directory to:

```text
KOReader/plugins/kovi.koplugin
```

Restart KOReader. In kovi open **Devices → Pair a KOReader** and generate a code. On the reader open **Tools → kovi → Pair / change server**, enter a URL that the reader can actually reach (normally the kovi server's LAN address, such as `http://192.168.1.23:3000`) and the code.

**Do not use `localhost`, `127.0.0.1`, or `0.0.0.0` on the reader.** Those point at the reader itself or are not a routable destination.

When pairing succeeds, the Devices page detects it automatically, closes the pairing dialog and refreshes the device list.

### Pairing / LAN diagnostics

Use **Tools → kovi → Test server connection**. A TCP failure means the reader cannot open the kovi host/port; an HTTP failure means TCP worked but the HTTP exchange failed; an API error means kovi was reached and returned an application response.

From another device on the same network, this should return kovi JSON:

```text
http://YOUR-KOVI-LAN-IP:3000/api/plugin/ping
```

Only expose kovi on a trusted/private network, or place it behind appropriate access control.

## Incremental KOReader sync

The first sync is deliberately conservative: it sends the full KOReader statistics history and all annotation sidecars. After kovi commits that import, it returns a high-water cursor which the reader stores locally. Subsequent syncs query `page_stat_data` from one day before that cursor, so normal sync cost no longer grows with years of reading history while the overlap protects against ordering/clock edge cases. kovi's existing event fingerprint keeps the overlap idempotent.

Annotation sync is incremental independently. The plugin stores each sidecar's modification-time/size signature and book MD5, opens/transmits only changed sidecars, and sends an empty tombstone once when a previously synced sidecar disappears so removed annotations are also removed server-side. If the reader cannot provide filesystem signatures, the plugin safely falls back to opening sidecars as before. Re-pairing resets both cursors, forcing a complete safety sync.

The dashboard's range-aware **Books read** metric counts a book only when its earliest tracked reading session and effective completion date are both inside the selected range. KOReader completion uses the sidecar's status-modified date, manual completion uses the time it was marked read in kovi, and statistics-only imports fall back to the earliest session reaching 100%. Manual Read overrides without a completion timestamp fall back to the book’s latest tracked session.

The **Status** page shows each device's last sync mode/cursor, rows sent, new sessions, changed annotation books, recent manual imports, and local storage usage.

## Automatic covers

kovi uses a layered resolver. The important design is that **Calibre handles the hard cases instead of kovi trying to recreate Calibre's provider logic**.

1. **ISBN lookup** — when KOReader sidecar metadata provides a valid ISBN, kovi tries the direct Open Library cover endpoint first, then a deterministic Google Books ISBN query if needed.
2. **Fast native Open Library search** — edition-aware translated title + author, title-only, simplified/series-stripped title variants, and language normalization (`ita`, `it`, `it-IT` → `it`).
3. **Parallel native catalogue search** — Open Library and Google Books are queried together for title/author and translated-title variants; the strongest candidate across both is tried first. An API key is optional and only improves Google quota.
4. **Calibre metadata-source federation** — if the native lookup misses, kovi runs Calibre as the unprivileged container user. If Calibre identifies the book but cannot download an image, kovi preserves the returned Google Books ID/ISBN and tries deterministic Google Books/Open Library cover URLs rather than discarding that useful metadata.
5. **Calibre cover-only sources** — Google Images and other cover-only sources get a separate chance, but failures there no longer erase successful bibliographic identification.
6. **Exact KOReader embedded cover** — paired devices get first chance to upload the exact ebook cover during sync before network fallback begins. Local covers keep priority during normal background enrichment.

Network lookups retry transient 429/5xx failures briefly, and the background resolver handles two books concurrently by default so library-wide discovery does not become a long serial queue.

The Calibre call is isolated: kovi invokes a fixed executable with an argument array (`execFile`), **never through a shell**, so a malicious title/author cannot become a command. Each invocation has a time limit, output limit, a private temporary Calibre config directory, and runs as the same non-root `node` user as kovi. Temporary files are removed after every attempt.

Calibre-style query relaxation is also used: ISBN/title/author first when available, then title+author without ISBN, then title-only. This mirrors Calibre's documented advice to make metadata searches less specific when an exact query fails.

If Calibre returns no usable image, kovi keeps the typographic placeholder rather than assigning a likely-wrong cover. Use **Retry covers** globally to re-run missing books. **Find online replacement** is an explicit override: it can try online providers even when the book already has a KOReader embedded or manually uploaded cover, while the current cover remains visible until the job finishes. Cover work has its own durable SQLite job state, so a good book cover is never temporarily abused as a queue marker. A failed lookup keeps the current image.

The book-page **Cover manager** can search several native catalogue candidates and cache up to six useful alternatives for visual selection. Every selected KOReader, online, or browser-uploaded cover is retained in cover history, so an older choice can be restored later. **Upload cover** accepts a local JPEG, PNG, WebP, or GIF up to 4 MB; browser-uploaded covers remain highest priority during normal automatic/KOReader enrichment. Cover files use immutable names, avoiding stale browser-cache results and allowing history to reference old images safely.

The Dockerfile installs Calibre from Debian at image-build time. If you run kovi directly with `npm start`, Calibre is optional: install Calibre with both `fetch-ebook-metadata` and `calibre-debug` available on the host, or kovi will continue with its native sources when the resolver is unavailable. Set `CALIBRE_COVER_RESOLVER=false` to disable the Calibre subprocess explicitly.


### Backup and export

The **Status → Backup & export** panel provides three local downloads:

- **kovi backup** — a gzip-compressed tar containing a transactionally consistent `kovi.sqlite` snapshot, `manifest.json`, and all current/historical cover files referenced by the database.
- **Books CSV** — a spreadsheet-friendly library summary with human-readable reading durations and last-opened dates.
- **Highlights Markdown** — book-grouped highlight/note text suitable for notes apps and plain-text archives.

The backup is created in a private temporary file and removed after the response finishes.

### Reading-time totals and charts

The dashboard’s **Reading time** card uses KOReader’s all-time per-book `total_read_time` total. The heatmap and line graph use dated `page_stat_data` session rows for the selected range, so a one-year chart can legitimately be lower than the all-time card. kovi labels those scopes explicitly.

kovi also deduplicates identical page-stat events across manual SQLite imports and paired-device syncs. Startup deduplicates existing page-stat rows and enforces a unique event index so importing the same KOReader history through both paths does not double-count chart time.

## Logs

kovi logs state-changing operations and enrichment work to stdout with timestamp, level, event name and contextual fields. Examples:

```text
[2026-08-30T08:12:00.000Z] [kovi] INFO import.sqlite.start — Manual KOReader database upload started. {"filename":"statistics.sqlite3","bytes":421888}
[2026-08-30T08:12:00.420Z] [kovi] INFO import.sqlite.complete — Manual KOReader database import completed. {"booksSeen":84,"newBooks":3,"excludedBooks":1}
[2026-08-30T08:12:01.531Z] [kovi] INFO cover.lookup.matched — Cover matched and cached. {"title":"L'amica geniale","language":"it","matchedTitle":"L'amica geniale","score":0.98}
[2026-08-30T08:12:06.100Z] [kovi] INFO cover.calibre.start — Asking Calibre metadata sources for a cover. {"title":"Il ladro linguanera","plans":["title-author","title-only"]}
[2026-08-30T08:12:09.500Z] [kovi] INFO cover.calibre.matched — Accepted Calibre-selected cover. {"title":"Il ladro linguanera","mime":"image/jpeg"}
[2026-08-30T08:15:14.881Z] [kovi] INFO plugin.sync.complete — KOReader sync completed. {"deviceId":"...","annotationsStored":127}
```

The logger intentionally redacts fields that look like tokens, authorization values or pairing codes.

## Configuration

| Variable | Default | Meaning |
|---|---:|---|
| `HOST` | `127.0.0.1` | Listen address (Docker sets `0.0.0.0`) |
| `PORT` | `3000` | HTTP port |
| `DATA_PATH` | `./data` | Persistent data directory |
| `TZ` | system zone (`UTC` in containers) | IANA time zone used for dashboard and calendar dates, for example `Europe/Rome` |
| `MAX_FILE_SIZE_MB` | `100` | Maximum manual SQLite upload size |
| `MAX_JSON_MB` | `20` | Maximum KOReader plugin JSON request size |
| `CALIBRE_COVER_RESOLVER` | `auto` | Use Calibre's identify and cover-only resolvers after native cover lookup misses; set `false` to disable |
| `CALIBRE_FETCH_BIN` | `fetch-ebook-metadata` | Override the Calibre CLI path for non-container installations |
| `CALIBRE_DEBUG_BIN` | `calibre-debug` | Override the Calibre cover-only CLI path for non-container installations |
| `GOOGLE_BOOKS_API_KEY` | empty | Optional Google Books API key for higher/identified quota; native Google Books discovery also works without one |
| `COVER_WORKER_CONCURRENCY` | `2` | Number of books resolved concurrently (clamped to 1–4) |

## Tests

```bash
npm test
npm run fixture -- /tmp/fixture-statistics.sqlite3
```

The suite covers incremental sync cursors/overlap, changed-sidecar/tombstone plumbing, sync diagnostics, cover job/history/candidate behavior, backup archive contents, SQLite validation/idempotence, KOReader-manual filtering, pairing state, authenticated sync, annotation replacement/deletion behavior, multilingual/series-title cover matching, ISBN enrichment, bad-image fallback, embedded-cover plumbing, Calibre CLI argument safety, Calibre identify fallback, direct cover-only/Google Images fallback, preservation of Calibre Google/ISBN identifiers, deterministic Google Books ID cover recovery, Calibre cover acceptance behavior, outdated-plugin warnings, browser CSRF handling, dedicated book routing, live pairing polling, the filterable heatmap and reading-time trend graph, cross-source reading-session deduplication, and plugin network diagnostics.

## Architecture

```text
Browser ──raw SQLite PUT──▶ kovi HTTP server ─▶ validated read-only import
                                  │
KOReader plugin ─Bearer JSON──────┤──▶ app SQLite (`data/kovi.sqlite`)
      │        incremental cursor  │        ├── sync runs / diagnostics
      │        + sidecar versions  │        └── durable cover jobs/history
      │                           │
      ├──── `.sdr` annotations ───┤
      └──── requested ebook cover ┤──▶ validated exact-edition cover cache
                                  │
                                  ├──▶ ISBN ─▶ Open Library Covers ─────────────┐
                                  ├──▶ Open Library edition search ───────────────┤
                                  ├──▶ Calibre metadata-source federation ────────┤
                                  ├──▶ Calibre IDs ─▶ Google Books cover URL ─────┤──▶ validated local cover cache
                                  └──▶ optional direct Google Books API fallback ─┘
```

The frontend is plain semantic HTML/CSS/ES modules and the kovi backend itself uses Node core modules. Calibre is installed as a separate third-party runtime command in the container solely for difficult cover lookups; see `THIRD_PARTY_NOTICES.md`.

## Security note

kovi does not implement web user accounts. Keep the web UI on a trusted LAN/private network, or place it behind an authenticated reverse proxy. Device plugin endpoints are separately authenticated with revocable tokens. See [SECURITY.md](SECURITY.md).

## Acknowledgements

kovi is inspired by [KoInsight](https://github.com/Ko-Insight/KoInsight), an MIT-licensed self-hosted KOReader statistics project, and by KOReader's own statistics model. It preserves the useful manual-SQLite + KOReader-plugin workflow while using a fresh application architecture and UX.

## License

kovi is released under the GNU General Public License v3.0; see [LICENSE](LICENSE). The container image also bundles Debian's unmodified `calibre` package (GPLv3); see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
