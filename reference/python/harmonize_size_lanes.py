#!/usr/bin/env python3
"""Two server-light, drift-free cutout compositing lanes.

Lane A requires a physical product height. Lane B accepts only a product
description/role and resolves a coarse form-factor size, falling back to 10 cm.
Both lanes generate an empty background with KIE/Nano Banana Pro, then place the
canonical RGBA cutout locally with one uniform scale and a detected support-plane
contact point. No product pixels are generated, warped, recolored, or inpainted.

Runtime dependencies: Python, Pillow, numpy. No GPU, OpenCV, SAM, rembg, or torch.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import shutil
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

from harmonize_pipeline import (
    DEFAULT_PRODUCT,
    Placement,
    SCENES,
    _direction_words,
    analyze_cutout,
    background_camera_contract,
    composite,
    generate_backgrounds,
    procedural_shadow,
    qa_metrics,
)


ROOT = Path(__file__).resolve().parent
DEFAULT_OUT = ROOT / "out" / "harmonize-v2-two-size-lanes"
SOURCE_USER_PROMPT = SCENES["neutral-stilllife"]["source_user_prompt"]

PRODUCT_DESCRIPTION = (
    "Canonical transparent-background front-view cutout of a compact packaged product "
    "with its original geometry, color, markings, and edges."
)
PRODUCT_REFERENCE_ROLE = (
    "LOCAL-ONLY canonical foreground pixels, silhouette, aspect ratio, color, label, and broad lighting-analysis source. "
    "The image is not sent to the background generator and must never be regenerated."
)


@dataclass(frozen=True)
class SizeResolution:
    height_cm: float
    source: str
    confidence: str
    size_class: str
    explanation: str


@dataclass(frozen=True)
class FramingProfile:
    name: str
    vertical_span_cm_at_landing_plane: float
    min_height_fraction: float
    max_height_fraction: float
    surface_depth_fraction: float


@dataclass(frozen=True)
class SupportPlane:
    back_y: int
    front_y: int
    contact_y: int
    confidence: str
    confidence_scope: str
    method: str
    back_score: float
    front_score: float


@dataclass(frozen=True)
class CameraCompatibility:
    projection_class: str
    product_center_y_fraction: float
    optical_axis_offset_fraction: float
    support_band_depth_fraction: float
    back_anchor_tilt_degrees: float
    front_anchor_tilt_degrees: float
    confidence: str
    passed: bool
    rejection_reasons: tuple[str, ...]
    analysis_note: str


CONTEXTUAL_STILL_LIFE = FramingProfile(
    name="contextual_still_life",
    vertical_span_cm_at_landing_plane=32.0,
    min_height_fraction=0.18,
    max_height_fraction=0.42,
    surface_depth_fraction=0.56,
)


# Coarse package/object priors, not brand-specific measurements. The resolver is
# deliberately replaceable by catalog metadata or a cached text resolver later.
SEMANTIC_SIZE_RULES: tuple[tuple[str, float, str], ...] = (
    (r"\b(solid applicator|stick package|compact applicator)\b", 10.0, "compact_handheld_stick"),
    (r"\b(lipstick|lip balm|balm stick)\b", 9.0, "small_handheld_stick"),
    (r"\b(compact|palette)\b", 8.0, "small_compact"),
    (r"\bjar\b", 7.0, "small_jar"),
    (r"\b(dropper|serum bottle)\b", 11.0, "small_bottle"),
    (r"\btube\b", 14.0, "handheld_tube"),
    (r"\b(pump|spray bottle|bottle)\b", 18.0, "medium_bottle"),
    (r"\b(can|aerosol)\b", 15.0, "medium_can"),
    (r"\b(carton|box)\b", 20.0, "medium_carton"),
    (r"\b(phone|smartphone)\b", 15.0, "handheld_device"),
    (r"\b(mug|cup)\b", 10.0, "tabletop_vessel"),
    (r"\b(shoe|sneaker)\b", 12.0, "footwear_height"),
    (r"\b(backpack|rucksack)\b", 42.0, "large_bag"),
)


def resolve_size(
    lane: str,
    product_description: str,
    physical_height_cm: float | None = None,
    fallback_height_cm: float = 10.0,
) -> SizeResolution:
    """Resolve physical height without requiring a product-specific schema."""
    if lane == "measured":
        if physical_height_cm is None or not math.isfinite(physical_height_cm) or physical_height_cm <= 0:
            raise ValueError("measured lane requires a positive physical_height_cm")
        return SizeResolution(
            height_cm=float(physical_height_cm),
            source="explicit_user_or_catalog_dimension",
            confidence="declared",
            size_class="measured",
            explanation="Caller-supplied physical package height; 10 cm is an explicit smoke-test assumption here.",
        )
    if lane != "semantic":
        raise ValueError(f"unsupported lane: {lane}")

    normalized = product_description.lower()
    for pattern, height_cm, size_class in SEMANTIC_SIZE_RULES:
        if re.search(pattern, normalized):
            return SizeResolution(
                height_cm=height_cm,
                source="generic_form_factor_prior",
                confidence="medium",
                size_class=size_class,
                explanation=(
                    "Estimated from generic product form-factor language in the supplied description/role; "
                    "not a brand-specific measurement."
                ),
            )
    return SizeResolution(
        height_cm=float(fallback_height_cm),
        source="generic_default_fallback",
        confidence="low",
        size_class="unknown",
        explanation="No recognized form factor; used the configured 10 cm fallback.",
    )


def projected_height_fraction(size: SizeResolution, framing: FramingProfile = CONTEXTUAL_STILL_LIFE) -> float:
    """Map real height to pixels through an explicit shot-framing calibration."""
    raw = size.height_cm / framing.vertical_span_cm_at_landing_plane
    return float(np.clip(raw, framing.min_height_fraction, framing.max_height_fraction))


def build_background_prompt(
    lane: str,
    size: SizeResolution,
    analysis: dict[str, Any],
    framing: FramingProfile = CONTEXTUAL_STILL_LIFE,
    user_prompt: str = SOURCE_USER_PROMPT,
    product_description: str = PRODUCT_DESCRIPTION,
    product_reference_role: str = PRODUCT_REFERENCE_ROLE,
) -> str:
    light = analysis["lighting"]
    light_quality = "soft diffused" if light["soft"] else "defined directional"
    projected_fraction = projected_height_fraction(size, framing)
    projected_percent = round(projected_fraction * 100)
    # A frontal cutout should straddle the image optical axis. Derive the
    # contact row from its projected height instead of placing it arbitrarily low.
    contact_fraction = float(np.clip(0.5 + projected_fraction / 2.0, 0.60, 0.76))
    rear_fraction = float(np.clip(contact_fraction - 0.07, 0.48, 0.69))
    front_fraction = float(np.clip(contact_fraction + 0.07, 0.68, 0.84))
    if lane == "measured":
        scale_contract = (
            f"The future canonical foreground is declared to be {size.height_cm:.1f} cm tall. "
            f"At its landing depth it should read at approximately {projected_percent}% of frame height under the "
            f"{framing.name} framing profile. Calibrate nearby props and the surface perspective to that real-world scale."
        )
    else:
        scale_contract = (
            "No numeric product dimension is available. Infer natural real-world scale only from the supplied product "
            "description: it is a compact handheld packaged object and must read as a small supporting object, "
            "not an oversized hero object. Calibrate nearby props and the surface perspective accordingly."
        )

    return (
        "The following is the customer's exact original creative brief. Use it for topic, mood, palette, and editorial intent.\n"
        "--- ORIGINAL USER PROMPT ---\n"
        f"{user_prompt}\n"
        "--- END ORIGINAL USER PROMPT ---\n\n"
        "The following reference metadata describes the foreground that will be composited locally after generation.\n"
        f"DESCRIPTION: {product_description}\n"
        f"ROLE: {product_reference_role}\n\n"
        "Create only an EMPTY photorealistic 16:9 background plate. Automatically choose a scene that satisfies the "
        "customer brief; do not copy or depend on any prior generated shot. Include two or three scene-appropriate, "
        "recognizable context props near the outer thirds so relative scale can be judged, while keeping the central "
        "landing area empty and unobstructed.\n"
        f"SCALE CONTRACT: {scale_contract}\n"
        "SUPPORT-PLANE CONTRACT: Provide one broad, flat, physically usable support surface in the lower half. Rear-side "
        "and front-side horizontal cues on that plane (such as seams, junctions, or a rim) should be visually readable "
        "across the empty central landing zone. The future object must "
        "land around the middle depth of that top surface, on the same plane and at the same scale as nearby props. Do not "
        "put the landing point below the front rim.\n"
        f"LIGHTING CONTRACT: {light_quality} key light from the {_direction_words(light['direction'])}, "
        f"{light['white_balance']} white balance, bright natural exposure, gentle contrast, realistic surface falloff.\n"
        f"CAMERA COMPATIBILITY CONTRACT: {background_camera_contract(analysis)}.\n"
        f"OPTICAL-AXIS / SURFACE GEOMETRY CONTRACT: The future foreground is {projected_percent}% of frame height. "
        f"Put its physical contact row at approximately {round(contact_fraction * 100)}% of frame height so the "
        "center of its frontal face aligns with the image optical axis. Keep the support surface's distinct rear "
        f"junction around {round(rear_fraction * 100)}% and its front rim around {round(front_fraction * 100)}% of "
        "frame height. The visible top surface must remain a shallow band between those cues, not a broad tabletop.\n"
        "No product, no bottle, no applicator, no tube, no package, no proxy object, no placeholder, "
        "no person, no hands, no typography, no logo, no watermark, no frame, and no pre-rendered product shadow."
    )


def _smooth(values: np.ndarray, radius: int = 5) -> np.ndarray:
    if radius <= 1:
        return values
    kernel_x = np.arange(1, radius + 1, dtype=np.float64)
    kernel = np.concatenate([kernel_x, kernel_x[-2::-1]])
    kernel /= kernel.sum()
    return np.convolve(values, kernel, mode="same")


def _best_peak(scores: np.ndarray, low: int, high: int) -> tuple[int, float]:
    low = max(1, low)
    high = min(len(scores) - 1, high)
    if high <= low:
        return low, 0.0
    index = int(low + np.argmax(scores[low:high]))
    return index, float(scores[index])


def detect_support_plane(
    background: Image.Image,
    framing: FramingProfile = CONTEXTUAL_STILL_LIFE,
) -> SupportPlane:
    """Detect two horizontal anchors within the central landing surface.

    The generated-plate contract makes these two horizontal cues readable.
    Detection uses only central-strip row color gradients. Fixed ratios are used
    only as an explicit low-confidence fallback when the plate violates contract.
    """
    rgb = np.asarray(background.convert("RGB"), dtype=np.float64)
    height, width = rgb.shape[:2]
    x0, x1 = round(width * 0.26), round(width * 0.74)
    strip = rgb[:, x0:x1]
    row_color = np.median(strip, axis=1)
    color_delta = np.linalg.norm(np.diff(row_color, axis=0), axis=1)
    scores = _smooth(np.pad(color_delta, (1, 0)), radius=max(3, round(height * 0.006)))

    back_y, back_score = _best_peak(scores, round(height * 0.48), round(height * 0.73))
    front_y, front_score = _best_peak(scores, max(back_y + round(height * 0.07), round(height * 0.70)), round(height * 0.91))

    sample = scores[round(height * 0.45) : round(height * 0.92)]
    median = float(np.median(sample))
    spread = float(np.std(sample))
    threshold = median + 0.55 * spread
    back_ok = back_score >= threshold
    front_ok = front_score >= threshold
    separated = front_y - back_y >= round(height * 0.07)

    fallbacks: list[str] = []
    if not back_ok:
        back_y = round(height * 0.62)
        fallbacks.append("back")
    if not front_ok or not separated:
        front_y = round(height * 0.84)
        fallbacks.append("front")
    if front_y <= back_y + 2:
        back_y, front_y = round(height * 0.62), round(height * 0.84)
        fallbacks = ["back", "front"]

    contact_y = round(back_y + (front_y - back_y) * framing.surface_depth_fraction)
    confidence = "high" if not fallbacks else "medium" if len(fallbacks) == 1 else "low"
    method = "central_row_color_gradient" + (f"+fallback_{'_'.join(fallbacks)}" if fallbacks else "")
    return SupportPlane(
        back_y=back_y,
        front_y=front_y,
        contact_y=contact_y,
        confidence=confidence,
        confidence_scope="horizontal_edge_strength_only; not semantic surface/rim classification",
        method=method,
        back_score=back_score,
        front_score=front_score,
    )


def _horizontal_anchor_tilt(background: Image.Image, anchor_y: int) -> float:
    """Measure whether a declared horizontal support cue stays level across frame."""
    rgb = np.asarray(background.convert("RGB"), dtype=np.float64)
    height, width = rgb.shape[:2]
    radius = max(5, round(height * 0.025))
    centers: list[float] = []
    peaks: list[float] = []
    for low, high in ((0.20, 0.36), (0.42, 0.58), (0.64, 0.80)):
        x0, x1 = round(width * low), round(width * high)
        row_color = np.median(rgb[:, x0:x1], axis=1)
        delta = _smooth(np.pad(np.linalg.norm(np.diff(row_color, axis=0), axis=1), (1, 0)), radius=3)
        y0, y1 = max(1, anchor_y - radius), min(height - 1, anchor_y + radius + 1)
        peak_y = int(y0 + np.argmax(delta[y0:y1]))
        centers.append((x0 + x1 - 1) / 2.0)
        peaks.append(float(peak_y))
    slope = float(np.polyfit(np.asarray(centers), np.asarray(peaks), 1)[0])
    return float(math.degrees(math.atan(slope)))


def assess_camera_compatibility(
    background: Image.Image,
    placement: Placement,
    surface: SupportPlane,
    analysis: dict[str, Any],
) -> CameraCompatibility:
    """Reject plates whose camera geometry would require warping the cutout.

    This is a compatibility gate, not focal-length recovery. It uses the product
    projection class plus measurable plate geometry promised by the background
    prompt: level rear/front cues, a shallow landing band, and an optical axis
    near the center of a frontal product.
    """
    width, height = background.size
    view = analysis.get("view_geometry") or {}
    projection = str(view.get("projection_class") or "unknown")
    product_center = (placement.y + placement.height / 2.0) / max(height, 1)
    axis_offset = abs(product_center - 0.5)
    band_depth = (surface.front_y - surface.back_y) / max(height, 1)
    back_tilt = _horizontal_anchor_tilt(background, surface.back_y)
    front_tilt = _horizontal_anchor_tilt(background, surface.front_y)

    if projection == "frontal_low_perspective":
        # Vertical composition is not focal length: a frontal object may sit below
        # frame center while remaining perspective-compatible. Keep only an extreme
        # off-axis guard; support depth/tilt are the actual camera-geometry gate.
        max_axis_offset = 0.15
        max_band_depth = 0.18
        confidence = "medium"
    elif projection == "roughly_frontal":
        max_axis_offset = 0.18
        max_band_depth = 0.25
        confidence = "low"
    else:
        max_axis_offset = 0.0
        max_band_depth = 0.0
        confidence = "manual_required"

    reasons: list[str] = []
    if projection not in {"frontal_low_perspective", "roughly_frontal"}:
        reasons.append("cutout_view_requires_explicit_camera_metadata")
    if axis_offset > max_axis_offset:
        reasons.append("product_center_too_far_from_optical_axis")
    if band_depth > max_band_depth:
        reasons.append("support_plane_reads_too_top_down")
    if abs(back_tilt) > 2.0 or abs(front_tilt) > 2.0:
        reasons.append("support_horizontal_cues_are_not_level")
    if surface.confidence != "high":
        reasons.append("support_plane_detection_not_high_confidence")

    return CameraCompatibility(
        projection_class=projection,
        product_center_y_fraction=product_center,
        optical_axis_offset_fraction=axis_offset,
        support_band_depth_fraction=band_depth,
        back_anchor_tilt_degrees=back_tilt,
        front_anchor_tilt_degrees=front_tilt,
        confidence=confidence,
        passed=not reasons,
        rejection_reasons=tuple(reasons),
        analysis_note=(
            "Heuristic CPU-only plate compatibility gate. It does not recover focal length; it rejects camera geometry "
            "that would require perspective-warping a frontal canonical cutout."
        ),
    )


def prepare_surface_placed_product(
    product_path: Path,
    background: Image.Image,
    size: SizeResolution,
    surface: SupportPlane,
    center_x_fraction: float = 0.52,
    framing: FramingProfile = CONTEXTUAL_STILL_LIFE,
) -> tuple[Image.Image, Placement]:
    product = Image.open(product_path).convert("RGBA")
    alpha = np.asarray(product.getchannel("A"))
    ys, xs = np.where(alpha > 0)
    source_bbox = (int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1)
    crop = product.crop(source_bbox)
    target_h = max(1, round(background.height * projected_height_fraction(size, framing)))
    source_ratio = crop.width / crop.height
    candidates: list[tuple[float, int, int, int]] = []
    for candidate_h in range(max(1, target_h - 3), target_h + 4):
        candidate_w = max(1, round(candidate_h * source_ratio))
        ratio_error = abs(candidate_w / candidate_h / source_ratio - 1)
        candidates.append((ratio_error, abs(candidate_h - target_h), candidate_w, candidate_h))
    _, _, desired_w, desired_h = min(candidates)
    layer = crop.resize((desired_w, desired_h), Image.Resampling.LANCZOS)
    x = round(background.width * center_x_fraction - desired_w / 2)
    y = surface.contact_y - desired_h
    if x < 0 or y < 0 or x + desired_w > background.width or surface.contact_y > background.height:
        raise ValueError("resolved product placement falls outside the background")
    return layer, Placement(
        x=x,
        y=y,
        width=desired_w,
        height=desired_h,
        source_bbox=source_bbox,
        scale=desired_h / crop.height,
    )


def render_surface_overlay(
    final: Image.Image,
    placement: Placement,
    surface: SupportPlane,
    out_path: Path,
) -> None:
    overlay = final.convert("RGB")
    draw = ImageDraw.Draw(overlay)
    line_width = max(2, round(final.width / 700))
    draw.line([(0, surface.back_y), (final.width, surface.back_y)], fill=(255, 220, 0), width=line_width)
    draw.line([(0, surface.front_y), (final.width, surface.front_y)], fill=(255, 0, 210), width=line_width)
    draw.line([(0, surface.contact_y), (final.width, surface.contact_y)], fill=(0, 255, 255), width=line_width)
    draw.rectangle(
        [placement.x, placement.y, placement.x + placement.width - 1, placement.y + placement.height - 1],
        outline=(255, 35, 35),
        width=line_width,
    )
    font = ImageFont.load_default()
    draw.text((8, max(4, surface.back_y - 17)), "landing back anchor", fill=(255, 220, 0), font=font)
    draw.text((8, max(4, surface.front_y - 17)), "landing front anchor", fill=(255, 0, 210), font=font)
    draw.text((8, max(4, surface.contact_y - 17)), "product contact", fill=(0, 255, 255), font=font)
    draw.text((placement.x + 6, max(4, placement.y - 17)), "canonical bbox", fill=(255, 35, 35), font=font)
    overlay.save(out_path)


def run_lane(
    lane: str,
    task: dict[str, Any],
    product_path: Path,
    out_dir: Path,
    analysis: dict[str, Any],
    size: SizeResolution,
) -> dict[str, Any]:
    lane_dir = out_dir / lane
    lane_dir.mkdir(parents=True, exist_ok=True)
    background_path = Path(task["local_path"])
    background = Image.open(background_path).convert("RGB")
    support = detect_support_plane(background)
    layer, placement = prepare_surface_placed_product(product_path, background, size, support)
    shadowed = procedural_shadow(background, layer, placement, analysis["lighting"], "upright")
    final = composite(shadowed, layer, placement)

    layer_path = lane_dir / "placed-canonical.png"
    final_path = lane_dir / "final.png"
    overlay_path = lane_dir / "qa-overlay.png"
    qa_path = lane_dir / "qa.json"
    layer.save(layer_path)
    final.save(final_path)
    render_surface_overlay(final, placement, support, overlay_path)

    qa = qa_metrics(final, layer, placement, float(analysis["cutout_width_height_ratio"]))
    qa["size_resolution"] = asdict(size)
    qa["framing_profile"] = asdict(CONTEXTUAL_STILL_LIFE)
    qa["projected_height_fraction"] = placement.height / background.height
    qa["support_plane"] = asdict(support)
    camera = assess_camera_compatibility(background, placement, support, analysis)
    qa["camera_compatibility"] = asdict(camera)
    qa["placement_bottom_matches_contact"] = placement.y + placement.height == support.contact_y
    qa["contact_inside_landing_band"] = support.back_y < support.contact_y < support.front_y
    qa["product_does_not_cross_front_anchor"] = placement.y + placement.height <= support.front_y
    qa["pass"] = bool(
        qa["pass"]
        and qa["placement_bottom_matches_contact"]
        and qa["contact_inside_landing_band"]
        and qa["product_does_not_cross_front_anchor"]
        and camera.passed
    )
    qa_path.write_text(json.dumps(qa, ensure_ascii=False, indent=2) + "\n")
    return {
        "lane": lane,
        "task_id": task["task_id"],
        "background": str(background_path),
        "placed_canonical": str(layer_path),
        "final": str(final_path),
        "overlay": str(overlay_path),
        "size_resolution": asdict(size),
        "support_plane": asdict(support),
        "camera_compatibility": asdict(camera),
        "placement": asdict(placement),
        "qa": qa,
    }


def make_contact_sheet(results: list[dict[str, Any]], out_path: Path) -> None:
    rows: list[Image.Image] = []
    for result in results:
        images = [
            Image.open(result["background"]).convert("RGB"),
            Image.open(result["final"]).convert("RGB"),
            Image.open(result["overlay"]).convert("RGB"),
        ]
        thumb_w = 560
        thumb_h = round(images[0].height * thumb_w / images[0].width)
        band_h = 40
        row = Image.new("RGB", (thumb_w * 3, thumb_h + band_h), "white")
        labels = ["EMPTY KIE PLATE", "FINAL CANONICAL COMPOSITE", "SUPPORT / CONTACT QA"]
        draw = ImageDraw.Draw(row)
        size = result["size_resolution"]
        for index, (image, label) in enumerate(zip(images, labels)):
            row.paste(image.resize((thumb_w, thumb_h), Image.Resampling.LANCZOS), (index * thumb_w, band_h))
            draw.text((index * thumb_w + 8, 6), label, fill=(20, 20, 20), font=ImageFont.load_default())
        draw.text(
            (8, 22),
            f"{result['lane']} | {size['height_cm']:.1f}cm | {size['source']} | task {result['task_id']}",
            fill=(20, 20, 20),
            font=ImageFont.load_default(),
        )
        rows.append(row)
    sheet = Image.new("RGB", (rows[0].width, sum(row.height for row in rows)), (230, 230, 230))
    y = 0
    for row in rows:
        sheet.paste(row, (0, y))
        y += row.height
    sheet.save(out_path, quality=92)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--product", type=Path, default=DEFAULT_PRODUCT)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--measured-height-cm", type=float, required=True)
    parser.add_argument("--semantic-fallback-height-cm", type=float, default=10.0)
    parser.add_argument("--product-description", default=PRODUCT_DESCRIPTION)
    parser.add_argument("--product-role", default=PRODUCT_REFERENCE_ROLE)
    parser.add_argument("--source-user-prompt-file", type=Path)
    parser.add_argument("--skip-generate", action="store_true")
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    user_prompt = args.source_user_prompt_file.read_text().strip() if args.source_user_prompt_file else SOURCE_USER_PROMPT

    input_dir = args.out / "input"
    input_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy2(args.product, input_dir / "product-reference.png")
    (input_dir / "source-user-prompt.txt").write_text(user_prompt + "\n")
    (input_dir / "reference-description-and-role.json").write_text(
        json.dumps({"description": args.product_description, "role": args.product_role}, ensure_ascii=False, indent=2) + "\n"
    )

    analysis = analyze_cutout(args.product, args.product_description)
    (args.out / "cutout-analysis.json").write_text(json.dumps(analysis, ensure_ascii=False, indent=2) + "\n")
    measured = resolve_size("measured", args.product_description, args.measured_height_cm)
    semantic = resolve_size("semantic", args.product_description, fallback_height_cm=args.semantic_fallback_height_cm)
    sizes = {"measured": measured, "semantic": semantic}
    prompts = {
        lane: build_background_prompt(
            lane,
            size,
            analysis,
            user_prompt=user_prompt,
            product_description=args.product_description,
            product_reference_role=args.product_role,
        )
        for lane, size in sizes.items()
    }
    (args.out / "compiled-background-prompts.json").write_text(json.dumps(prompts, ensure_ascii=False, indent=2) + "\n")

    manifest_path = args.out / "kie-background-tasks.json"
    if args.skip_generate:
        tasks = json.loads(manifest_path.read_text())
    else:
        tasks = generate_backgrounds(prompts, args.out, candidates_per_scene=1)
        manifest_path.write_text(json.dumps(tasks, ensure_ascii=False, indent=2) + "\n")
    tasks_by_lane = {task["scene"]: task for task in tasks}
    results = [run_lane(lane, tasks_by_lane[lane], args.product, args.out, analysis, size) for lane, size in sizes.items()]
    (args.out / "results.json").write_text(json.dumps(results, ensure_ascii=False, indent=2) + "\n")
    make_contact_sheet(results, args.out / "contact-sheet.jpg")
    print(json.dumps({"sizes": {key: asdict(value) for key, value in sizes.items()}, "results": results}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
