#!/usr/bin/env python3
"""Extract the exact two-file TUI producer handoff under strict bounds."""

from __future__ import annotations

import argparse
import os
import pathlib
import re
import stat
import sys
import zipfile


MAX_ZIP_BYTES = 64 * 1024 * 1024
MAX_TARBALL_BYTES = 64 * 1024 * 1024
MAX_MANIFEST_BYTES = 1 * 1024 * 1024
MAX_TOTAL_BYTES = 65 * 1024 * 1024
MAX_ENTRIES = 2
CHUNK_BYTES = 64 * 1024
MANIFEST_NAME = "release-package-manifest.json"
TARBALL_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*\.tgz$")


def fail(message: str) -> "NoReturn":
    raise SystemExit(f"unsafe producer archive: {message}")


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", required=True, type=pathlib.Path)
    parser.add_argument("--output", required=True, type=pathlib.Path)
    return parser.parse_args()


def regular_entry(entry: zipfile.ZipInfo) -> None:
    if entry.is_dir():
        fail(f"directories are not allowed: {entry.filename}")
    if entry.flag_bits & 0x1:
        fail(f"encrypted entry: {entry.filename}")
    if entry.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
        fail(f"unsupported compression: {entry.filename}")
    file_type = (entry.external_attr >> 16) & stat.S_IFMT(0o170000)
    if file_type not in (0, stat.S_IFREG):
        fail(f"non-regular entry: {entry.filename}")


def allowed_name(name: str, names: set[str]) -> int:
    if "\x00" in name or "/" in name or "\\" in name:
        fail(f"unsafe entry name: {name!r}")
    if name == MANIFEST_NAME:
        limit = MAX_MANIFEST_BYTES
    elif TARBALL_NAME.fullmatch(name):
        limit = MAX_TARBALL_BYTES
    else:
        fail(f"unexpected entry: {name!r}")
    folded = name.casefold()
    if folded in {value.casefold() for value in names}:
        fail(f"duplicate entry: {name!r}")
    names.add(name)
    return limit


def copy_entry(archive: zipfile.ZipFile, entry: zipfile.ZipInfo, target: pathlib.Path, limit: int) -> None:
    if entry.file_size < 0 or entry.file_size > limit:
        fail(f"entry exceeds size limit: {entry.filename}")
    target_fd = os.open(
        target,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0),
        0o600,
    )
    written = 0
    try:
        with archive.open(entry, "r") as source, os.fdopen(target_fd, "wb") as destination:
            target_fd = -1
            while True:
                chunk = source.read(min(CHUNK_BYTES, limit - written + 1))
                if not chunk:
                    break
                written += len(chunk)
                if written > limit or written > entry.file_size:
                    fail(f"entry expanded beyond declared size: {entry.filename}")
                destination.write(chunk)
            if written != entry.file_size:
                fail(f"truncated entry: {entry.filename}")
    finally:
        if target_fd != -1:
            os.close(target_fd)


def main() -> None:
    options = arguments()
    archive_path = options.archive
    output_path = options.output
    if archive_path.is_symlink() or not archive_path.is_file():
        fail("archive is not a regular file")
    if output_path.exists() and output_path.is_symlink():
        fail("output must not be a symlink")
    archive = archive_path.resolve()
    output = output_path.resolve()
    archive_size = archive.stat().st_size
    if archive_size > MAX_ZIP_BYTES:
        fail("ZIP exceeds size limit")
    if output.exists():
        if output.is_symlink() or not output.is_dir():
            fail("output is not a directory")
        if any(output.iterdir()):
            fail("output must be empty")
    else:
        output.mkdir(mode=0o700, parents=True)
    os.chmod(output, 0o700)

    names: set[str] = set()
    total_declared = 0
    try:
        with zipfile.ZipFile(archive) as value:
            entries = value.infolist()
            if len(entries) != MAX_ENTRIES:
                fail(f"expected exactly {MAX_ENTRIES} files, got {len(entries)}")
            for entry in entries:
                regular_entry(entry)
                limit = allowed_name(entry.filename, names)
                if entry.compress_size < 0 or entry.compress_size > MAX_ZIP_BYTES:
                    fail(f"compressed entry exceeds size limit: {entry.filename}")
                total_declared += entry.file_size
                if total_declared > MAX_TOTAL_BYTES:
                    fail("expanded archive exceeds total size limit")
                copy_entry(value, entry, output / entry.filename, limit)
    except zipfile.BadZipFile as error:
        fail(f"invalid ZIP: {error}")
    except (OSError, RuntimeError, zipfile.LargeZipFile) as error:
        fail(str(error))

    if MANIFEST_NAME not in names or not any(TARBALL_NAME.fullmatch(name) for name in names):
        fail("manifest and tarball are required")
    print(f"extracted {len(names)} producer files")


if __name__ == "__main__":
    main()
