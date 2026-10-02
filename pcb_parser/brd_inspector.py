from pathlib import Path


ENCODED_SIGNATURE = bytes((0x23, 0xE2, 0x63, 0x28))


def decode_brd(data: bytes) -> bytes:
    out = bytearray(data)

    for i, value in enumerate(out):
        if value in (0, 10, 13):
            continue

        out[i] = (~(((value >> 6) & 3) | (value << 2))) & 0xFF

    return bytes(out)


def inspect_brd(path: Path):
    raw = path.read_bytes()

    encoded = raw[:4] == ENCODED_SIGNATURE

    if encoded:
        decoded = decode_brd(raw)
    else:
        decoded = raw

    text = decoded.decode(
        "latin-1",
        errors="replace"
    )

    lines = text.splitlines()

    print("=" * 70)
    print("BRD STRUCTURE INSPECTOR")
    print("=" * 70)

    print(f"File      : {path.name}")
    print(f"Size      : {len(raw):,} bytes")
    print(f"Encoded   : {encoded}")
    print(f"Text lines: {len(lines):,}")
    print()

    print("-" * 70)
    print("POSSIBLE SECTION HEADERS")
    print("-" * 70)

    headers = []

    for index, line in enumerate(lines):
        stripped = line.strip()

        if not stripped:
            continue

        # Existing known section style
        if (
            stripped.endswith(":")
            or stripped.startswith("Format")
            or stripped.startswith("Parts")
            or stripped.startswith("Pins")
            or stripped.startswith("Nails")
            or stripped.startswith("var_data")
        ):
            headers.append(
                (index + 1, stripped)
            )

    for line_no, header in headers:
        print(
            f"{line_no:>7} : {header}"
        )

    print()
    print("-" * 70)
    print("FIRST 120 DECODED LINES")
    print("-" * 70)

    for index, line in enumerate(lines[:120]):
        print(
            f"{index + 1:>5}: {line}"
        )


if __name__ == "__main__":
    import sys

    if len(sys.argv) != 2:
        print(
            "Usage: python brd_inspector.py sample.brd"
        )
        raise SystemExit(1)

    inspect_brd(
        Path(sys.argv[1])
    )