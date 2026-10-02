from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

ENCODED_SIGNATURE = bytes((0x23, 0xE2, 0x63, 0x28))


def decode_brd(data: bytes) -> bytes:
    """Decode the encoded BRD text representation."""
    out = bytearray(data)

    for i, value in enumerate(out):
        if value in (0, 10, 13):
            continue

        out[i] = (~(((value >> 6) & 3) | (value << 2))) & 0xFF

    return bytes(out)


def find_header(lines: list[str], *names: str) -> int:
    wanted = {name.strip().lower() for name in names}

    for index, line in enumerate(lines):
        if line.strip().lower() in wanted:
            return index

    return -1


def parse_brd(path: Path) -> dict[str, Any]:
    raw = path.read_bytes()

    encoded = raw[:4] == ENCODED_SIGNATURE
    data = decode_brd(raw) if encoded else raw

    lines = data.decode("latin-1", errors="replace").splitlines()

    var_idx = find_header(lines, "var_data:")
    fmt_idx = find_header(lines, "Format:")
    pins1_idx = find_header(lines, "Pins1:")
    pins2_idx = find_header(lines, "Pins2:")
    nails_idx = find_header(lines, "Nails:")

    required = {
        "var_data": var_idx,
        "Format": fmt_idx,
        "Pins1": pins1_idx,
        "Pins2": pins2_idx,
        "Nails": nails_idx,
    }

    missing = [name for name, idx in required.items() if idx < 0]
    if missing:
        raise ValueError(
            "Required BRD sections missing: "
            + ", ".join(missing)
        )

    # -----------------------------
    # Counts from var_data
    # -----------------------------
    count_fields = lines[var_idx + 1].split()

    if len(count_fields) < 6:
        raise ValueError("Invalid var_data counts")

    (
        format_count,
        parts_count,
        pins_count,
        nails_count,
        origin_x,
        origin_y,
    ) = map(int, count_fields[:6])

    # -----------------------------
    # Format / board outline points
    # -----------------------------
    format_points: list[dict[str, int]] = []

    for line in lines[fmt_idx + 1:pins1_idx]:
        fields = line.split()

        if len(fields) < 2:
            continue

        try:
            format_points.append(
                {
                    "x": int(fields[0]),
                    "y": int(fields[1]),
                }
            )
        except ValueError:
            continue

    if format_points:
        board_min_x = min(p["x"] for p in format_points)
        board_max_x = max(p["x"] for p in format_points)
        board_min_y = min(p["y"] for p in format_points)
        board_max_y = max(p["y"] for p in format_points)
    else:
        board_min_x = board_max_x = 0
        board_min_y = board_max_y = 0

    # -----------------------------
    # Pins2: parse first because
    # Parts can be enriched afterwards.
    # -----------------------------
    pins: list[dict[str, Any]] = []

    for sequence, line in enumerate(
        lines[pins2_idx + 1:nails_idx],
        start=1,
    ):
        fields = line.split(maxsplit=4)

        if len(fields) < 5:
            continue

        try:
            x = int(fields[0])
            y = int(fields[1])
            probe = int(fields[2])
            part_id = int(fields[3])
        except ValueError:
            continue

        net = fields[4].strip()

        pins.append(
            {
                "index": sequence,
                "x": x,
                "y": y,
                "probe": probe,
                "part_id": part_id,
                "net": net,
            }
        )

    # -----------------------------
    # Parts / Pins1
    #
    # Pins1's third field is the
    # cumulative end-of-pins index.
    # -----------------------------
    parts: list[dict[str, Any]] = []

    previous_pin_end = 0

    for part_id, line in enumerate(
        lines[pins1_idx + 1:pins2_idx],
        start=1,
    ):
        fields = line.split()

        if len(fields) < 3:
            continue

        name = fields[0]

        try:
            type_layer = int(fields[1])
            end_of_pins = int(fields[2])
        except ValueError:
            continue

        pin_start = previous_pin_end + 1
        pin_end = end_of_pins
        pin_count = max(0, pin_end - previous_pin_end)

        if type_layer & 0xC:
            part_type = "SMD"
        else:
            part_type = "ThroughHole"

        if type_layer == 1 or 4 <= type_layer < 8:
            side = "Top"
        elif type_layer == 2 or type_layer >= 8:
            side = "Bottom"
        else:
            side = "Both"

        parts.append(
            {
                "id": part_id,
                "name": name,
                "type_layer": type_layer,
                "part_type": part_type,
                "mounting_side": side,
                "pin_start": pin_start,
                "pin_end": pin_end,
                "pin_count": pin_count,
            }
        )

        previous_pin_end = end_of_pins

    # -----------------------------
    # Enrich parts from Pins2
    # -----------------------------
    part_map = {part["id"]: part for part in parts}

    pins_by_part: dict[int, list[dict[str, Any]]] = {}

    for pin in pins:
        part_id = pin["part_id"]

        if part_id not in pins_by_part:
            pins_by_part[part_id] = []

        pins_by_part[part_id].append(pin)

    for part in parts:
        part_pins = pins_by_part.get(part["id"], [])

        if not part_pins:
            part["bounds"] = None
            part["center"] = None
            continue

        xs = [pin["x"] for pin in part_pins]
        ys = [pin["y"] for pin in part_pins]

        min_x = min(xs)
        max_x = max(xs)
        min_y = min(ys)
        max_y = max(ys)

        part["bounds"] = {
            "min_x": min_x,
            "max_x": max_x,
            "min_y": min_y,
            "max_y": max_y,
            "width": max_x - min_x,
            "height": max_y - min_y,
        }

        part["center"] = {
            "x": (min_x + max_x) / 2,
            "y": (min_y + max_y) / 2,
        }

        # Zero-based indexes into the global pins array.
        part["pin_indices"] = [
            pin["index"] - 1
            for pin in part_pins
        ]

        part["net_names"] = sorted(
            {
                pin["net"]
                for pin in part_pins
                if pin["net"]
            }
        )

        # Visual pad candidates. The BRD gives center coordinates,
        # not explicit width/height, so this is intentionally metadata only.
        part["pad_centers"] = [
            {
                "x": pin["x"],
                "y": pin["y"],
                "pin_index": pin["index"],
                "net": pin["net"],
                "probe": pin["probe"],
            }
            for pin in part_pins
        ]

    # -----------------------------
    # Nails
    # -----------------------------
    nails: list[dict[str, Any]] = []

    for index, line in enumerate(
        lines[nails_idx + 1:],
        start=1,
    ):
        fields = line.split(maxsplit=4)

        if len(fields) < 5:
            continue

        try:
            probe = int(fields[0])
            x = int(fields[1])
            y = int(fields[2])
            side_value = int(fields[3])
        except ValueError:
            continue

        nails.append(
            {
                "index": index,
                "probe": probe,
                "x": x,
                "y": y,
                "side": "Top" if side_value == 1 else "Bottom",
                "net": fields[4].strip(),
            }
        )

    # -----------------------------
    # Fast net index
    # -----------------------------
    net_index: dict[str, dict[str, Any]] = {}

    for pin in pins:
        net = pin["net"]

        if not net:
            continue

        if net not in net_index:
            net_index[net] = {
                "pin_indices": [],
                "part_ids": set(),
            }

        net_index[net]["pin_indices"].append(
            pin["index"] - 1
        )

        net_index[net]["part_ids"].add(
            pin["part_id"]
        )

    for nail in nails:
        net = nail["net"]

        if not net:
            continue

        if net not in net_index:
            net_index[net] = {
                "pin_indices": [],
                "part_ids": set(),
            }

    # JSON cannot serialize sets.
    for data_item in net_index.values():
        data_item["part_ids"] = sorted(
            data_item["part_ids"]
        )

    nets = sorted(net_index.keys())

    return {
        "schema_version": 3,

        "source_file": path.name,
        "encoded": encoded,

        "source_counts": {
            "format_points": format_count,
            "parts": parts_count,
            "pins": pins_count,
            "nails": nails_count,
            "origin_x": origin_x,
            "origin_y": origin_y,
        },

        "counts_parsed": {
            "format_points": len(format_points),
            "parts": len(parts),
            "pins": len(pins),
            "nails": len(nails),
            "unique_pin_nets": len(nets),
        },

        "board_bounds": {
            "min_x": board_min_x,
            "max_x": board_max_x,
            "min_y": board_min_y,
            "max_y": board_max_y,
            "width": board_max_x - board_min_x,
            "height": board_max_y - board_min_y,
        },

        "format_points": format_points,
        "parts": parts,
        "pins": pins,
        "nails": nails,
        "nets": nets,
        "net_index": net_index,
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Parse a BoardView BRD file into indexed JSON."
    )

    parser.add_argument(
        "file",
        type=Path,
        help="Path to BRD file",
    )

    parser.add_argument(
        "--json",
        type=Path,
        default=Path("output/board.json"),
        help="Output JSON path",
    )

    args = parser.parse_args()

    if not args.file.exists():
        raise SystemExit(
            f"BRD file not found: {args.file}"
        )

    result = parse_brd(args.file)

    args.json.parent.mkdir(
        parents=True,
        exist_ok=True,
    )

    args.json.write_text(
        json.dumps(
            result,
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )

    print()
    print("=" * 70)
    print("BRD parser v3 successful")
    print("=" * 70)
    print(f"File: {result['source_file']}")
    print(f"Encoded: {result['encoded']}")
    print()

    print("Counts:")
    for key, value in result["counts_parsed"].items():
        print(f"  {key}: {value}")

    print()
    print("Board bounds:")
    for key, value in result["board_bounds"].items():
        print(f"  {key}: {value}")

    print()
    print("Example enriched components:")

    for part in result["parts"][:5]:
        print(
            f"  {part['name']}: "
            f"side={part['mounting_side']}, "
            f"type={part['part_type']}, "
            f"pins={part['pin_count']}"
        )

    print()
    print("UF000 check:")

    uf000 = next(
        (part for part in result["parts"] if part["name"] == "UF000"),
        None,
    )

    if uf000:
        print(
            f"  id={uf000['id']}, "
            f"pins={uf000['pin_count']}, "
            f"nets={len(uf000.get('net_names', []))}, "
            f"pin_range={uf000['pin_start']}..{uf000['pin_end']}"
        )
    else:
        print("  UF000 not found")

    print()
    print(f"JSON written to: {args.json.resolve()}")


if __name__ == "__main__":
    main()
