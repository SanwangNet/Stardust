"""Only regular files and directories are allowed in Stardust archives."""
import os
import shutil
import sys
import tarfile
from pathlib import Path

LIMIT = 8 * 1024**3
COUNT = 250_000
PACKAGE = {"apps", "node_modules", "package.json", "version.json"}
UNSAFE = {".git", ".env", "shared", "backups", "config.toml"}


class BoundedHeader(tarfile.TarInfo):
    def _proc_pax(self, stream):
        if self.size > 32768 or self.type == tarfile.XGLTYPE:
            raise ValueError("UNSAFE_ARCHIVE")
        return super()._proc_pax(stream)

    def _proc_gnulong(self, stream):
        if self.size > 32768:
            raise ValueError("UNSAFE_ARCHIVE")
        return super()._proc_gnulong(stream)

    def _proc_sparse(self, stream):
        raise ValueError("UNSAFE_ARCHIVE")


def extract(archive, destination, kind):
    permitted = PACKAGE if kind == "package" else {"shared", "backup.json"}
    root = Path(destination)
    seen = set()
    total = 0
    with tarfile.open(archive, "r|gz", ignore_zeros=False, tarinfo=BoundedHeader) as source:
        for item in source:
            parts = item.name.split("/")
            if (len(seen) >= COUNT or item.name in seen or parts[0] not in permitted
                    or any(not p or p in {".", ".."} or "\\" in p or ":" in p
                           or any(ord(c) < 32 or ord(c) == 127 for c in p) for p in parts)
                    or not (item.isdir() or item.isreg()) or item.sparse is not None):
                raise ValueError("UNSAFE_ARCHIVE")
            if kind == "package" and (any(p in UNSAFE for p in parts)
                    or (parts[0] == "apps" and parts[:3] not in
                        [["apps"], ["apps", "server"], ["apps", "web"],
                         ["apps", "server", "dist"], ["apps", "web", "dist"]])):
                raise ValueError("UNSAFE_ARCHIVE")
            if (parts[0] in {"shared", "apps", "node_modules"} and len(parts) == 1 and not item.isdir()
                    or parts[0] in {"backup.json", "package.json", "version.json"} and (len(parts) != 1 or not item.isreg())):
                raise ValueError("UNSAFE_ARCHIVE")
            seen.add(item.name)
            total += item.size
            if total > LIMIT or (item.name == "backup.json" and item.size > 32768) or (item.isdir() and item.size):
                raise ValueError("ARCHIVE_LIMIT")
            output = root.joinpath(*parts)
            if item.isdir():
                output.mkdir(parents=True, exist_ok=True)
            else:
                output.parent.mkdir(parents=True, exist_ok=True)
                with output.open("xb") as handle:
                    shutil.copyfileobj(source.extractfile(item), handle, 128 * 1024)
                output.chmod(0o644 if kind == "package" else 0o600)
    if kind == "backup" and not (root / "shared").is_dir():
        raise ValueError("INVALID_BACKUP")
    if kind == "package":
        for folder, dirs, _files in os.walk(root):
            for name in dirs:
                Path(folder, name).chmod(0o755)
        root.chmod(0o755)


def backup(archive, shared, metadata):
    def validate(item):
        source = Path(shared).parent.joinpath(*item.name.split("/"))
        if not (item.isreg() or item.isdir()) or (item.isreg() and source.lstat().st_nlink != 1):
            raise ValueError("UNSAFE_STORAGE")
        return item
    with tarfile.open(archive, "x:gz", compresslevel=3, dereference=False) as output:
        output.add(shared, arcname="shared", filter=validate)
        output.add(metadata, arcname="backup.json", recursive=False)


if __name__ == "__main__":
    try:
        operation, first, second, third = sys.argv[1:]
        if operation == "extract":
            extract(first, second, third)
        elif operation == "backup":
            backup(first, second, third)
        else:
            raise ValueError("INVALID_OPERATION")
    except (OSError, ValueError, tarfile.TarError) as error:
        print(type(error).__name__, str(error), file=sys.stderr)
        sys.exit(1)
