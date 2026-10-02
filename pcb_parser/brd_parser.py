from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

ENCODED_SIGNATURE = bytes((0x23, 0xE2, 0x63, 0x28))


def decode_brd(data: bytes) -> bytes:
    """Decode the encoded BRD text representation used by this BRD family."""
    out = bytearray(data)

    for i, value in enumerate(out):
        if value in (0, 10, 13):
            continue

        out[i] = (~(((value >> 6) & 3) | (value << 2))) & 0xFF

    return bytes(out)


def find_header(lines: list[str], *names: str) -> int:
    wanted = {name.lower() for name in names}

    for index, line in enumerate(lines):
        if line.strip().lower() in wanted:
            return index

    return -1


def decode_part_type(type_layer: int) -> tuple[str, str]:
    """Decode the BRD type/layer value used by OpenBoardView's BRD reader."""
    part_type = "SMD" if (type_layer & 0xC) else "ThroughHole"

    if type_layer == 1 or 4 <= type_layer < 8:
        side = "Top"
    elif type_layer == 2 or type_layer >= 8:
        side = "Bottom"
    else:
        side = "Unknown"

    return part_type, side


def parse_brd(path: Path) -> dict[str, Any]:
    raw = path.read_bytes()
    encoded = raw[:4] == ENCODED_SIGNATURE
    decoded = decode_brd(raw) if encoded else raw
    lines = decoded.decode("latin-1", errors="replace").splitlines()

    var_idx = find_header(lines, "var_data:")
    fmt_idx = find_header(lines, "Format:", "format:")
    parts_idx = find_header(lines, "Parts:", "Pins1:")
    pins_idx = find_header(lines, "Pins:", "Pins2:")
    nails_idx = find_header(lines, "Nails:")

    required = {
        "var_data": var_idx,
        "Format": fmt_idx,
        "Parts/Pins1": parts_idx,
        "Pins/Pins2": pins_idx,
        "Nails": nails_idx,
    }

    missing = [name for name, idx in required.items() if idx < 0]
    if missing:
        raise ValueError(
            "Required BRD sections not found: " + ", ".join(missing)
        )

    counts = lines[var_idx + 1].split()
    if len(counts) < 4:
        raise ValueError("var_data section does not contain expected counts")

    num_format, num_parts, num_pins, num_nails = map(int, counts[:4])

    # -----------------------------
    # Board format / outline points
    # -----------------------------
    format_points: list[dict[str, int]] = []
    for line in lines[fmt_idx + 1:parts_idx]:
        fields = line.split()
        if len(fields) >= 2:
            format_points.append({
                "x": int(fields[0]),
                "y": int(fields[1]),
            })

    # -----------------------------
    # Parts
    # -----------------------------
    parts: list[dict[str, Any]] = []
    for line in lines[parts_idx + 1:pins_idx]:
        fields = line.split()
        if len(fields) < 3:
            continue

        name = fields[0]
        type_layer = int(fields[1])
        end_of_pins = int(fields[2])
        part_type, mounting_side = decode_part_type(type_layer)

        parts.append({
            "id": len(parts) + 1,
            "name": name,
            "type_layer": type_layer,
            "part_type": part_type,
            "mounting_side": mounting_side,
            "end_of_pins": end_of_pins,
        })

    if len(parts) != num_parts:
        raise ValueError(
            f"Part count mismatch: file={num_parts}, parsed={len(parts)}"
        )

    # -----------------------------
    # Pins
    # BRD layout: x y probe part_id net
    # The 3rd field is probe/test id, not a conventional pad number.
    # -----------------------------
    pins: list[dict[str, Any]] = []
    for line in lines[pins_idx + 1:nails_idx]:
        fields = line.split(maxsplit=4)
        if len(fields) < 5:
            continue

        pins.append({
            "x": int(fields[0]),
            "y": int(fields[1]),
            "probe_id": int(fields[2]),
            "part_id": int(fields[3]),
            "net": fields[4].strip(),
        })

    if len(pins) != num_pins:
        raise ValueError(
            f"Pin count mismatch: file={num_pins}, parsed={len(pins)}"
        )

    # -----------------------------
    # Nails
    # BRD layout: probe x y side net
    # -----------------------------
    nails: list[dict[str, Any]] = []
    for line in lines[nails_idx + 1:]:
        fields = line.split(maxsplit=4)
        if len(fields) < 5:
            continue

        nails.append({
            "probe_id": int(fields[0]),
            "x": int(fields[1]),
            "y": int(fields[2]),
            "side": "Top" if int(fields[3]) == 1 else "Bottom",
            "net": fields[4].strip(),
        })

    if len(nails) != num_nails:
        raise ValueError(
            f"Nail count mismatch: file={num_nails}, parsed={len(nails)}"
        )

    # -----------------------------
    # Enrich each component with a pin range and geometry derived from its pins
    # -----------------------------
    previous_end = 0
    for part in parts:
        end = part["end_of_pins"]

        if end < previous_end or end > len(pins):
            raise ValueError(
                f"Invalid pin range for part {part['name']}: {previous_end} -> {end}"
            )

        start = previous_end + 1 if end > previous_end else None
        subset = pins[previous_end:end]

        part["start_of_pins"] = start
        part["pin_start_index"] = previous_end
        part["pin_end_index"] = end
        part["pin_count"] = len(subset)

        if subset:
            xs = [pin["x"] for pin in subset]
            ys = [pin["y"] for pin in subset]

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
                "x": sum(xs) / len(xs),
                "y": sum(ys) / len(ys),
            }
        else:
            part["bounds"] = None
            part["center"] = None

        previous_end = end

    # Add per-part pin position within that component.
    # This is a local sequence, NOT a claimed manufacturer pad number.
    for part in parts:
        start_index = part["pin_start_index"]
        end_index = part["pin_end_index"]

        for local_index, pin_index in enumerate(
            range(start_index, end_index), start=1
        ):
            pins[pin_index]["part_pin_index"] = local_index

    # -----------------------------
    # Nets
    # -----------------------------
    nets = sorted({pin["net"] for pin in pins if pin["net"]})

    # Fast lookup structures for the future web viewer.
    net_to_pin_indices: dict[str, list[int]] = {}
    for index, pin in enumerate(pins):
        net = pin["net"]
        if not net:
            continue
        net_to_pin_indices.setdefault(net, []).append(index)

    part_to_pin_indices: dict[str, list[int]] = {}
    for part in parts:
        indices = list(
            range(part["pin_start_index"], part["pin_end_index"])
        )
        part_to_pin_indices[str(part["id"])] = indices

    board_bounds = None
    if format_points:
        fx = [point["x"] for point in format_points]
        fy = [point["y"] for point in format_points]
        board_bounds = {
            "min_x": min(fx),
            "max_x": max(fx),
            "min_y": min(fy),
            "max_y": max(fy),
            "width": max(fx) - min(fx),
            "height": max(fy) - min(fy),
        }

    return {
        "source_file": path.name,
        "format": "BRD",
        "encoded": encoded,
        "counts_from_file": {
            "format_points": num_format,
            "parts": num_parts,
            "pins": num_pins,
            "nails": num_nails,
        },
        "counts_parsed": {
            "format_points": len(format_points),
            "parts": len(parts),
            "pins": len(pins),
            "nails": len(nails),
            "unique_pin_nets": len(nets),
        },
        "board": {
            "bounds": board_bounds,
        },
        "format_points": format_points,
        "parts": parts,
        "pins": pins,
        "nails": nails,
        "nets": nets,
        "indexes": {
            "net_to_pin_indices": net_to_pin_indices,
            "part_to_pin_indices": part_to_pin_indices,
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Parse a supported BRD BoardView file"
    )
    parser.add_argument("file", type=Path)
    parser.add_argument(
        "--json",
        type=Path,
        default=Path("output/board.json"),
    )
    args = parser.parse_args()

    result = parse_brd(args.file)

    args.json.parent.mkdir(parents=True, exist_ok=True)
    args.json.write_text(
        json.dumps(result, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    print()
    print("======================================")
    print("BRD parser v2 test successful")
    print("======================================")
    print(f"File: {result['source_file']}")
    print(f"Encoded: {result['encoded']}")
    print()
    print("Counts:")
    for key, value in result["counts_parsed"].items():
        print(f"  {key}: {value}")

    print()
    print("Example enriched components:")
    wanted = {"R0500", "R0501", "CR812", "UF000"}
    shown = 0
    for part in result["parts"]:
        if part["name"] in wanted:
            print(
                f"  {part['name']}: "
                f"side={part['mounting_side']}, "
                f"type={part['part_type']}, "
                f"pins={part['pin_count']}, "
                f"bounds={part['bounds']}"
            )
            shown += 1
        if shown == len(wanted):
            break

    print()
    print(f"JSON written to: {args.json.resolve()}")


if __name__ == "__main__":
    main()
