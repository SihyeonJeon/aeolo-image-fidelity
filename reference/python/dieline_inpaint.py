#!/usr/bin/env python3
"""Generic, role-constrained Nano Banana Pro drawing-to-render lane.

The model receives only the references declared in a structured request. The geometry
drawing is replaced by a 1:1 white-padded copy, while the exact original prompt is
preserved and each input image receives its declared description and role.

The derived silhouette mask is QA-only: it is never uploaded, never supplied to the
model, and never used to alter the returned pixels. No remote call occurs unless
``--run`` is passed explicitly. No intermediate LLM parses or rewrites the request.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw

from dieline_overlay import composite_dieline


WD = Path(__file__).resolve().parent
SOURCE = WD / "refs" / "aeo141" / "dieline-original.png"
DEFAULT_REQUEST = WD / "data" / "aeo141-generic-only-request.json"
PREP_DIR = WD / "refs" / "aeo141" / "prepared"
OUT_DIR = WD / "out" / "aeo141-inpaint"
FINAL_SIZE = 2048
MARKER = (0, 255, 0)


def flatten_white(path: Path) -> Image.Image:
    source = Image.open(path).convert("RGBA")
    white = Image.new("RGBA", source.size, (255, 255, 255, 255))
    white.alpha_composite(source)
    return white.convert("RGB")


def native_square(image: Image.Image) -> tuple[Image.Image, tuple[int, int]]:
    """Pad to a square at native resolution; never resize or stretch the drawing."""
    side = max(image.size)
    offset = ((side - image.width) // 2, (side - image.height) // 2)
    canvas = Image.new("RGB", (side, side), "white")
    canvas.paste(image, offset)
    return canvas, offset


def closed_silhouette(line_canvas: Image.Image) -> Image.Image:
    """Derive the closed exterior region for QA only."""
    flooded = line_canvas.copy()
    ImageDraw.floodfill(flooded, (0, 0), MARKER, thresh=40)
    pixels = flooded.load()
    mask = Image.new("L", flooded.size, 0)
    target = mask.load()
    for y in range(flooded.height):
        for x in range(flooded.width):
            if pixels[x, y] != MARKER:
                target[x, y] = 255
    if mask.getbbox() is None:
        raise ValueError("could not derive a closed silhouette from the dieline")
    return mask


def scale_and_pad(image: Image.Image, resample: Image.Resampling) -> tuple[Image.Image, int, int]:
    """Integer-upscale the native square, then pad to the 2K model canvas."""
    integer_scale = FINAL_SIZE // image.width
    if integer_scale < 1:
        raise ValueError(f"source square {image.width}px exceeds final canvas {FINAL_SIZE}px")
    scaled_side = image.width * integer_scale
    scaled = image.resize((scaled_side, scaled_side), resample)
    offset = (FINAL_SIZE - scaled_side) // 2
    fill = 0 if image.mode == "L" else "white"
    final = Image.new(image.mode, (FINAL_SIZE, FINAL_SIZE), fill)
    final.paste(scaled, (offset, offset))
    return final, integer_scale, offset


def bbox_ratio(box: tuple[int, int, int, int] | None) -> float | None:
    if box is None:
        return None
    return (box[2] - box[0]) / (box[3] - box[1])


def prepare(source: Path = SOURCE) -> dict:
    """Create the padded drawing plus a separate, QA-only silhouette mask."""
    PREP_DIR.mkdir(parents=True, exist_ok=True)
    source = source.resolve()
    original = flatten_white(source)
    square, source_offset = native_square(original)
    native_mask = closed_silhouette(square)
    drawing, integer_scale, canvas_offset = scale_and_pad(square, Image.Resampling.LANCZOS)
    mask, _, _ = scale_and_pad(native_mask, Image.Resampling.NEAREST)

    assets = {
        "padded_drawing": PREP_DIR / "padded-drawing-2k.png",
        "silhouette_mask": PREP_DIR / "silhouette-mask-2k.png",
    }
    drawing.save(assets["padded_drawing"])
    mask.save(assets["silhouette_mask"])

    bbox = mask.getbbox()
    metadata = {
        "source": relative_or_absolute(source),
        "source_size": list(original.size),
        "native_square_size": square.width,
        "source_offset_in_native_square": list(source_offset),
        "integer_scale": integer_scale,
        "scaled_square_offset_in_2k_canvas": canvas_offset,
        "final_size": FINAL_SIZE,
        "target_bbox": list(bbox) if bbox else None,
        "target_ratio": bbox_ratio(bbox),
        "model_inputs": ["padded_drawing"],
        "qa_only_assets": ["silhouette_mask"],
        "assets": {key: str(path.relative_to(WD)) for key, path in assets.items()},
    }
    (PREP_DIR / "metadata.json").write_text(json.dumps(metadata, indent=2) + "\n")
    return metadata


def load_request(path: Path = DEFAULT_REQUEST) -> dict:
    """Load and validate the no-LLM structured request contract."""
    request = json.loads(path.read_text())
    required_top_level = (
        "id",
        "model",
        "prompt",
        "references",
        "aspect_ratio",
        "resolution",
        "output_format",
    )
    missing = [key for key in required_top_level if not request.get(key)]
    if missing:
        raise ValueError(f"request is missing required values: {missing}")
    if not isinstance(request["references"], list):
        raise ValueError("request references must be a list")
    ids: list[str] = []
    for index, reference in enumerate(request["references"], 1):
        missing_ref = [
            key for key in ("id", "kind", "url", "description", "role") if not reference.get(key)
        ]
        if missing_ref:
            raise ValueError(f"reference {index} is missing required values: {missing_ref}")
        if reference["kind"] not in {"geometry", "support"}:
            raise ValueError(f"reference {index} has unsupported kind: {reference['kind']}")
        ids.append(reference["id"])
    if len(ids) != len(set(ids)):
        raise ValueError("reference ids must be unique")
    geometry = [reference for reference in request["references"] if reference["kind"] == "geometry"]
    if len(geometry) != 1:
        raise ValueError(f"expected exactly one geometry reference, got {len(geometry)}")
    if not geometry[0].get("local_asset"):
        raise ValueError("geometry reference must declare local_asset for deterministic preprocessing")
    asset = (WD / geometry[0]["local_asset"]).resolve()
    if not asset.is_file():
        raise ValueError(f"geometry local_asset does not exist: {asset}")
    return request


def geometry_reference(request: dict) -> tuple[int, dict]:
    matches = [
        (index, reference)
        for index, reference in enumerate(request["references"], 1)
        if reference["kind"] == "geometry"
    ]
    if len(matches) != 1:
        raise ValueError(f"expected exactly one geometry reference, got {len(matches)}")
    return matches[0]


def build_role_prompt(request: dict, metadata: dict | None = None) -> tuple[str, list[dict]]:
    """Append generic constraints without parsing or rewriting the original prompt."""
    original = request["prompt"]
    geometry_index, _ = geometry_reference(request)
    roles = [
        {
            "id": item["id"],
            "kind": item["kind"],
            "description": item["description"],
            "role": item["role"],
        }
        for item in request["references"]
    ]

    role_lines = []
    for index, item in enumerate(roles, 1):
        role_lines.extend(
            [
                f"IMAGE {index} — {item['description']}",
                f"Role: {item['role']}",
            ]
        )
    geometry_block = ""
    if metadata:
        left, top, right, bottom = metadata["target_bbox"]
        width = right - left
        height = bottom - top
        geometry_block = f"""
PIXEL GEOMETRY CONTRACT FOR THE 2048 × 2048 OUTPUT:
- The complete visible generated-subject bbox must be x={left}..{right - 1}, y={top}..{bottom - 1} (right/bottom exclusive bbox [{left}, {top}, {right}, {bottom}]).
- Required visible generated-subject width={width}px, height={height}px, W/H={metadata['target_ratio']:.12f}.
- Its topmost and bottommost pixels must stay on those exact rows. All edge antialiasing, highlights, material effects, glow, reflections, and shadows that belong to the generated subject must end inside this bbox.
"""

    prompt = f"""{original}

REFERENCE IMAGE DESCRIPTIONS AND ROLES (same order as the inputs):
{chr(10).join(role_lines)}
{geometry_block}

INPAINT / EDIT INSTRUCTION:
Use IMAGE {geometry_index} as the edit canvas and sole geometry authority. Replace only the appearance inside its closed exterior subject silhouette, while preserving the exact exterior boundary, every internal construction-line position, and the subject's canvas location. Do not move, resize, stretch, crop, expand, or redesign the subject. Render all requested sections together in one coherent edit; do not independently generate, composite, or reposition sections. An internal construction line has semantic meaning only when the ORIGINAL USER PROMPT explicitly maps that line to a section, part, or material boundary; when mapped, preserve that exact line as the boundary. Do not invent a mapping for any unmapped line. Determine all identity, section and part meanings, part relationships, material assignments, colors, text, and branding exclusively from the ORIGINAL USER PROMPT. Reference descriptions and roles only constrain how each reference may influence non-semantic visual properties such as depth, scale, and lighting; they must never introduce or override a section, part, boundary, material, color, text, or branding assignment. Determine background and shadow behavior from the ORIGINAL USER PROMPT, with lighting influenced by a reference only when its declared role permits it. Keep pixels outside the subject silhouette unchanged except where the ORIGINAL USER PROMPT explicitly requests a background change. Supporting references may affect only the properties assigned in their roles. Do not copy an undeclared property from any reference."""
    return prompt, roles


def model_reference_urls(request: dict, padded_drawing_url: str) -> list[str]:
    """Replace only the declared geometry URL, preserving all references and their order."""
    return [
        padded_drawing_url if reference["kind"] == "geometry" else reference["url"]
        for reference in request["references"]
    ]


def upload(path: Path, key: str) -> str:
    result = subprocess.run(
        [
            "curl",
            "-sS",
            "-X",
            "POST",
            "https://kieai.redpandaai.co/api/file-stream-upload",
            "-H",
            f"Authorization: Bearer {key}",
            "-F",
            f"file=@{path}",
            "-F",
            "uploadPath=images/imagegentest/aeo141",
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    response = json.loads(result.stdout)
    data = response.get("data") or {}
    url = data.get("downloadUrl") or data.get("fileUrl")
    if not url:
        raise RuntimeError(f"KIE upload failed: {response.get('msg') or response.get('code')}")
    return url


def binary_mask_from_nonwhite(image: Image.Image, threshold: int = 245) -> Image.Image:
    gray = image.convert("L")
    return gray.point(lambda value: 255 if value < threshold else 0, mode="L")


def count_on(mask: Image.Image) -> int:
    return mask.histogram()[255]


def relative_or_absolute(path: Path) -> str:
    try:
        return str(path.relative_to(WD))
    except ValueError:
        return str(path)


def finalize_role_only(raw_path: Path, name: str, metadata: dict) -> dict:
    """Measure and overlay the untouched model output; never geometry-gate its pixels."""
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    raw = Image.open(raw_path).convert("RGB")
    target = Image.open(WD / metadata["assets"]["silhouette_mask"]).convert("L")
    drawing = Image.open(WD / metadata["assets"]["padded_drawing"]).convert("RGB")
    contract_canvas_size = (metadata["final_size"], metadata["final_size"])
    returned_canvas_matches_contract = raw.size == contract_canvas_size
    target_was_resampled_for_positional_qa = target.size != raw.size
    if target.size != raw.size:
        target = target.resize(raw.size, Image.Resampling.NEAREST)
    if drawing.size != raw.size:
        drawing = drawing.resize(raw.size, Image.Resampling.LANCZOS)

    overlay = composite_dieline(raw, drawing)
    overlay_path = OUT_DIR / f"{name}-dieline-overlay.png"
    overlay.save(overlay_path)

    raw_mask = binary_mask_from_nonwhite(raw)
    target_binary = target.point(lambda value: 255 if value else 0)
    intersection = ImageChops.logical_and(raw_mask.convert("1"), target_binary.convert("1")).convert("L")
    union = ImageChops.logical_or(raw_mask.convert("1"), target_binary.convert("1")).convert("L")
    outside = ImageChops.logical_and(
        raw_mask.convert("1"), ImageChops.invert(target_binary).convert("1")
    ).convert("L")
    target_pixels = count_on(target_binary)

    target_bbox = target.getbbox()
    raw_bbox = raw_mask.getbbox()
    target_ratio_on_returned_canvas = bbox_ratio(target_bbox)
    contract_target_ratio = metadata["target_ratio"]
    raw_ratio = bbox_ratio(raw_bbox)
    report = {
        "raw": relative_or_absolute(raw_path),
        "pixel_modification": "none",
        "dieline_overlay": str(overlay_path.relative_to(WD)),
        "threshold": 245,
        "contract_canvas_size": list(contract_canvas_size),
        "returned_canvas_size": list(raw.size),
        "returned_canvas_matches_contract": returned_canvas_matches_contract,
        "contract_target_bbox": metadata["target_bbox"],
        "contract_target_ratio": contract_target_ratio,
        "positional_qa_target_resampled_to_returned_canvas": target_was_resampled_for_positional_qa,
        "positional_qa_target_bbox": list(target_bbox) if target_bbox else None,
        "positional_qa_target_ratio": target_ratio_on_returned_canvas,
        "raw_bbox": list(raw_bbox) if raw_bbox else None,
        "raw_ratio": raw_ratio,
        "raw_ratio_error_pct": (
            ((raw_ratio / contract_target_ratio) - 1) * 100
            if raw_ratio and contract_target_ratio
            else None
        ),
        "outside_drift_pixels": count_on(outside),
        "inside_coverage": count_on(intersection) / target_pixels if target_pixels else None,
        "silhouette_iou": count_on(intersection) / count_on(union) if count_on(union) else None,
    }
    report_path = OUT_DIR / f"{name}-report.json"
    report_path.write_text(json.dumps(report, indent=2) + "\n")
    return report


def load_key() -> str:
    key = os.environ.get("KIE_API_KEY", "").strip()
    if key:
        return key
    env_path = WD / ".env"
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            if line.startswith("KIE_API_KEY="):
                key = line.split("=", 1)[1].strip()
                if key:
                    return key
    raise ValueError("KIE_API_KEY not found in environment or .env")


def validate_paired_requests(first: dict, second: dict) -> None:
    """Require a controlled comparison where only id and original user prompt may differ."""
    for key in ("model", "references", "aspect_ratio", "resolution", "output_format"):
        if first[key] != second[key]:
            raise ValueError(f"paired requests must have identical {key}")


def create_remote_task(
    request: dict,
    name: str,
    metadata: dict,
    key: str,
    drawing_url: str | None = None,
) -> str:
    sys.path.insert(0, str(WD))
    from kie_generate import create_task

    prompt, roles = build_role_prompt(request, metadata)
    if drawing_url is None:
        drawing_url = upload(WD / metadata["assets"]["padded_drawing"], key)
    refs = model_reference_urls(request, drawing_url)
    response = create_task(
        key,
        request["model"],
        prompt,
        refs,
        request["aspect_ratio"],
        request["resolution"],
        request["output_format"],
    )
    if response.get("code") != 200:
        raise RuntimeError(f"KIE task rejected: {response.get('msg') or response.get('code')}")
    task_id = response["data"]["taskId"]
    receipt = {
        "task_id": task_id,
        "request_id": request["id"],
        "model": request["model"],
        "original_prompt_preserved_as_prefix": request["prompt"],
        "prompt": prompt,
        "input_roles": roles,
        "image_input": refs,
        "qa_only_assets_not_uploaded": [metadata["assets"]["silhouette_mask"]],
        "aspect_ratio": request["aspect_ratio"],
        "resolution": request["resolution"],
        "output_format": request["output_format"],
        "intermediate_llm_calls": 0,
        "semantic_preprocessing": "none",
        "post_generation_pixel_modification": "none",
    }
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / f"{name}-request.json").write_text(
        json.dumps(receipt, ensure_ascii=False, indent=2) + "\n"
    )
    print(f"created KIE Nano Banana Pro task {task_id} for {name}")
    return task_id


def complete_remote_task(task_id: str, name: str, metadata: dict, key: str) -> dict:
    sys.path.insert(0, str(WD))
    from kie_generate import download, poll

    urls = poll(key, task_id, timeout=600)
    if not urls:
        raise RuntimeError("KIE task completed without a result URL")
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    raw_path = OUT_DIR / f"{name}-raw.png"
    download(urls[0], str(raw_path))
    return finalize_role_only(raw_path, name, metadata)


def run(request: dict, task_id: str | None, name: str, metadata: dict) -> dict:
    key = load_key()

    if task_id is None:
        task_id = create_remote_task(request, name, metadata, key)
    else:
        print(f"resuming existing KIE task {task_id}")
    return complete_remote_task(task_id, name, metadata, key)


def run_pair(
    first: dict,
    first_name: str,
    second: dict,
    second_name: str,
    metadata: dict,
) -> dict:
    """Create two controlled-comparison tasks sharing one uploaded geometry URL."""
    validate_paired_requests(first, second)
    key = load_key()
    drawing_url = upload(WD / metadata["assets"]["padded_drawing"], key)
    first_task = create_remote_task(first, first_name, metadata, key, drawing_url)
    second_task = create_remote_task(second, second_name, metadata, key, drawing_url)
    return {
        first_name: complete_remote_task(first_task, first_name, metadata, key),
        second_name: complete_remote_task(second_task, second_name, metadata, key),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run", action="store_true", help="create/poll a KIE Nano Banana Pro task")
    parser.add_argument("--task-id", help="resume an existing KIE task without creating a new one")
    parser.add_argument("--request", type=Path, default=DEFAULT_REQUEST)
    parser.add_argument("--name", default="generic-role-only-smoke")
    parser.add_argument("--compare-request", type=Path, help="second request for a controlled pair")
    parser.add_argument("--compare-name", default="user-mapped-v2")
    parser.add_argument("--finalize", type=Path, help="measure/overlay an untouched downloaded image")
    args = parser.parse_args()

    request = load_request(args.request.resolve())
    _, geometry = geometry_reference(request)
    metadata = prepare((WD / geometry["local_asset"]).resolve())
    print(
        f"prepared padded drawing + QA-only mask: bbox={metadata['target_bbox']} "
        f"W/H={metadata['target_ratio']:.6f}"
    )
    if args.compare_request and (args.task_id or args.finalize):
        parser.error("--compare-request cannot be combined with --task-id or --finalize")
    if args.finalize:
        report = finalize_role_only(args.finalize.resolve(), args.name, metadata)
        print(json.dumps(report, indent=2))
    elif args.run and args.compare_request:
        compare_request = load_request(args.compare_request.resolve())
        _, compare_geometry = geometry_reference(compare_request)
        if compare_geometry["local_asset"] != geometry["local_asset"]:
            parser.error("paired requests must use the same geometry local_asset")
        report = run_pair(
            request,
            args.name,
            compare_request,
            args.compare_name,
            metadata,
        )
        print(json.dumps(report, indent=2))
    elif args.run or args.task_id:
        report = run(request, args.task_id, args.name, metadata)
        print(json.dumps(report, indent=2))
    else:
        message = (
            f"dry run only; validated request {request['id']} with "
            f"{len(request['references'])} references and zero intermediate LLM calls"
        )
        if args.compare_request:
            compare_request = load_request(args.compare_request.resolve())
            validate_paired_requests(request, compare_request)
            message += f"; paired comparison request {compare_request['id']} also validated"
        print(message)


if __name__ == "__main__":
    main()
