# Third-party components

kovi is free software licensed under the GNU General Public License version 3 (see `LICENSE`). The container image also bundles third-party programs under their own licenses.

## Calibre

kovi's container build installs the unmodified Debian `calibre` package and invokes its `fetch-ebook-metadata` and `calibre-debug` commands as separate, unprivileged subprocesses for cover discovery. kovi is itself GPLv3 and Calibre is GPLv3, so shipping Calibre in the same image is license-compatible.

Calibre is Copyright © Kovid Goyal and contributors and is licensed under the GNU General Public License version 3.

- Project: https://calibre-ebook.com/
- Source: https://github.com/kovidgoyal/calibre
- License: GPL-3.0 — https://www.gnu.org/licenses/gpl-3.0.html
- Debian's `calibre` package ships its license and copyright files under `/usr/share/doc/calibre/`, and Debian publishes the corresponding source packages.

When redistributing a prebuilt kovi image, preserve Calibre's license and copyright files inside the image and keep the corresponding source available. Using the unmodified Debian package means Debian's published source packages satisfy the GPLv3 source-availability requirement.
