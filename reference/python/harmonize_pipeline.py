#!/usr/bin/env python3
"""Server-light, drift-free product compositing experiment.

The generated model is used only for empty background plates. Product pixels come
from one canonical RGBA cutout and are placed with a deterministic uniform scale.
The default shadow is procedural and rendered behind the canonical product.

Runtime dependencies: Python, Pillow, numpy. No OpenCV, SAM, rembg, torch, or GPU.
The production implementation maps directly to Sharp raw buffers + typed arrays.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
import time
import urllib.request
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont


ROOT = Path(__file__).resolve().parent
DEFAULT_PRODUCT = ROOT / "fixtures" / "canonical-cutout.png"
DEFAULT_OUT = ROOT / "out" / "harmonize-v1"
KIE_BASE = "https://api.kie.ai"


GENERIC_STYLE = """Creative direction:
- Clean editorial product photography with a coherent palette and natural scale.
- Bright, even illumination with soft shadows and sufficient negative space.
- No text overlay, watermark, logo, product proxy, or placeholder object."""


SCENES: dict[str, dict[str, Any]] = {
    "neutral-stilllife": {
        "source_user_prompt": (
            "Create a premium 16:9 editorial still life with a clear focal area, realistic scale, "
            "professional lighting, and a cohesive neutral palette.\n\n" + GENERIC_STYLE
        ),
        "description": "Generic bright neutral still-life background.",
        "camera": "eye-level camera, natural 50mm lens, no wide-angle distortion",
        "surface": "a clean warm off-white stone shelf across the lower third",
        "details": "two understated context props near the outer thirds and generous unobstructed center space",
        "placement_mode": "upright",
        "product_height_fraction": 0.32,
        "center_x_fraction": 0.52,
        "bottom_y_fraction": 0.78,
    },
    "minimal-interior": {
        "source_user_prompt": (
            "Create a premium 16:9 architectural still life with a stable horizontal support plane, "
            "realistic prop scale, and a clean central landing area.\n\n" + GENERIC_STYLE
        ),
        "description": "Generic minimal interior background.",
        "camera": "low eye-level product camera, natural 50mm lens, no wide-angle distortion",
        "surface": "a pale matte shelf spanning the lower third",
        "details": "two simple context props at the far edges and an unobstructed landing area near the center",
        "placement_mode": "upright",
        "product_height_fraction": 0.30,
        "center_x_fraction": 0.50,
        "bottom_y_fraction": 0.78,
    },
}


@dataclass(frozen=True)
class Placement:
    x: int
    y: int
    width: int
    height: int
    source_bbox: tuple[int, int, int, int]
    scale: float


def _weighted_centroid(weights: np.ndarray) -> tuple[float, float]:
    ys, xs = np.indices(weights.shape, dtype=np.float64)
    total = float(weights.sum())
    if total <= 1e-9:
        return ((weights.shape[1] - 1) / 2, (weights.shape[0] - 1) / 2)
    return (float((xs * weights).sum() / total), float((ys * weights).sum() / total))


def _direction(dx: float, dy: float, dead_zone: float = 0.035) -> str:
    horizontal = "left" if dx < -dead_zone else "right" if dx > dead_zone else ""
    vertical = "upper" if dy < -dead_zone else "lower" if dy > dead_zone else ""
    if vertical and horizontal:
        return f"{vertical}_{horizontal}"
    return vertical or horizontal or "front_diffuse"


def _direction_words(direction: str) -> str:
    return {
        "upper_left": "upper left",
        "upper_right": "upper right",
        "lower_left": "lower left",
        "lower_right": "lower right",
        "upper": "above the camera",
        "lower": "below the camera",
        "left": "camera left",
        "right": "camera right",
        "front_diffuse": "the frontal camera axis",
    }.get(direction, direction.replace("_", " "))


def _view_geometry(crop_alpha: np.ndarray, description: str = "") -> dict[str, Any]:
    """Estimate projection compatibility without pretending to recover lens mm.

    An isolated cutout has no scene scale, sensor size, or vanishing point, so an
    absolute focal length is not identifiable. The useful, measurable contract is
    whether the silhouette is frontal, upright, left/right symmetric, and weakly
    converging. Those properties determine which background camera geometries can
    accept the cutout without a perspective warp.
    """
    mask = crop_alpha >= 0.08
    if not mask.any():
        raise ValueError("cutout alpha has no measurable silhouette")
    mirrored = mask[:, ::-1]
    union = int(np.logical_or(mask, mirrored).sum())
    mirror_iou = float(np.logical_and(mask, mirrored).sum() / union) if union else 0.0

    row_y: list[float] = []
    row_left: list[float] = []
    row_right: list[float] = []
    minimum_row_width = max(4, round(mask.shape[1] * 0.08))
    for y in range(mask.shape[0]):
        xs = np.flatnonzero(mask[y])
        if xs.size < minimum_row_width:
            continue
        row_y.append(float(y))
        row_left.append(float(xs[0]))
        row_right.append(float(xs[-1]))
    ys = np.asarray(row_y)
    left = np.asarray(row_left)
    right = np.asarray(row_right)
    centers = (left + right) / 2.0
    widths = right - left + 1.0
    stable = (ys >= mask.shape[0] * 0.15) & (ys <= mask.shape[0] * 0.85)
    if stable.sum() < 8:
        stable = np.ones_like(ys, dtype=bool)

    center_slope = float(np.polyfit(ys[stable], centers[stable], 1)[0])
    left_slope = float(np.polyfit(ys[stable], left[stable], 1)[0])
    right_slope = float(np.polyfit(ys[stable], right[stable], 1)[0])
    roll_degrees = float(math.degrees(math.atan(center_slope)))

    def band_width(low: float, high: float) -> float:
        selected = (ys >= mask.shape[0] * low) & (ys <= mask.shape[0] * high)
        return float(np.median(widths[selected])) if selected.any() else float(np.median(widths))

    upper_width = band_width(0.15, 0.30)
    middle_width = band_width(0.42, 0.58)
    lower_width = band_width(0.70, 0.85)
    width_convergence = float((upper_width - lower_width) / max(middle_width, 1.0))
    edge_parallelism_error = float(abs(right_slope - left_slope) * mask.shape[0] / max(middle_width, 1.0))

    frontal = (
        mirror_iou >= 0.96
        and abs(roll_degrees) <= 1.0
        and abs(width_convergence) <= 0.04
        and edge_parallelism_error <= 0.05
    )
    roughly_frontal = (
        mirror_iou >= 0.88
        and abs(roll_degrees) <= 3.0
        and abs(width_convergence) <= 0.10
    )
    projection = "frontal_low_perspective" if frontal else "roughly_frontal" if roughly_frontal else "angled_or_asymmetric"

    words = description.lower()
    semantic_front = any(token in words for token in ("front-view", "front view", "front-facing", "정면"))
    semantic_overhead = any(token in words for token in ("top-down", "top down", "overhead", "bird's-eye", "bird’s-eye", "탑뷰"))
    if semantic_overhead:
        elevation = "overhead_declared"
        elevation_confidence = "declared"
    elif semantic_front and frontal:
        elevation = "near_level_frontal"
        elevation_confidence = "high"
    elif frontal:
        elevation = "near_level_candidate"
        elevation_confidence = "medium"
    else:
        elevation = "indeterminate"
        elevation_confidence = "low"

    if frontal:
        background_contract = (
            "straight-on camera near the future object's mid-height; optical axis approximately horizontal; "
            "very shallow downward pitch; normal-to-long or orthographic-like perspective with weak convergence; "
            "show only a shallow support ledge around the landing point, not an expansive top-down tabletop; "
            "keep the landing edge and other dominant horizontal cues level; no wide-angle distortion"
        )
        compatible_fov = "normal_to_long_or_orthographic_like"
    elif roughly_frontal:
        background_contract = (
            "mostly level camera with mild perspective only; keep the support plane shallow and horizontal; "
            "avoid wide-angle foreground expansion and steep top-down views"
        )
        compatible_fov = "normal"
    else:
        background_contract = (
            "camera pose cannot be resolved confidently from silhouette alone; require an explicit camera/view role "
            "or choose a background plate manually before compositing"
        )
        compatible_fov = "requires_explicit_view_metadata"

    return {
        "projection_class": projection,
        "mirror_silhouette_iou": mirror_iou,
        "roll_degrees": roll_degrees,
        "upper_middle_lower_width_px": [upper_width, middle_width, lower_width],
        "upper_vs_lower_width_change": width_convergence,
        "edge_slopes_px_per_row": {"left": left_slope, "right": right_slope},
        "edge_parallelism_error": edge_parallelism_error,
        "camera_elevation_class": elevation,
        "camera_elevation_confidence": elevation_confidence,
        "compatible_fov_class": compatible_fov,
        "absolute_focal_length_mm": None,
        "background_camera_contract": background_contract,
        "analysis_note": (
            "Absolute focal length cannot be recovered from an isolated cutout. Projection class uses alpha-silhouette "
            "symmetry, centerline roll, width convergence, parallel edges, and optional caller description."
        ),
    }


def analyze_cutout(path: Path, description: str = "") -> dict[str, Any]:
    """Estimate broad lighting from native-alpha product pixels.

    Large label text is intentionally suppressed: lighting direction comes from a
    low-frequency luma field over material-colored pixels, not the top 1% raw RGB.
    This avoids mistaking high-contrast printed lettering for a specular highlight.
    """
    im = Image.open(path).convert("RGBA")
    rgba = np.asarray(im, dtype=np.float32)
    rgb = rgba[..., :3]
    alpha = rgba[..., 3] / 255.0
    visible = alpha > 0
    if not visible.any():
        raise ValueError(f"cutout has no visible alpha: {path}")

    ys, xs = np.where(visible)
    x0, y0, x1, y1 = int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1
    crop_rgb = rgb[y0:y1, x0:x1]
    crop_alpha = alpha[y0:y1, x0:x1]
    core = crop_alpha >= 0.98

    luma = 0.2126 * crop_rgb[..., 0] + 0.7152 * crop_rgb[..., 1] + 0.0722 * crop_rgb[..., 2]
    chroma = crop_rgb.max(axis=2) - crop_rgb.min(axis=2)
    saturation = chroma / np.maximum(crop_rgb.max(axis=2), 1.0)
    colored_direction = core & (chroma >= 20.0)
    colored_surface = core & (saturation >= 0.25)
    # Neutral products cannot use chroma as a text suppressor; fall back to all core pixels.
    material = colored_direction if colored_direction.sum() >= max(128, int(core.sum() * 0.30)) else core
    surface_material = colored_surface if colored_surface.sum() >= max(128, int(core.sum() * 0.30)) else material

    radius = max(5.0, min(crop_alpha.shape) * 0.045)
    numerator = Image.fromarray(np.uint8(np.clip(luma * material, 0, 255)), "L").filter(
        ImageFilter.GaussianBlur(radius)
    )
    denominator = Image.fromarray(np.uint8(material) * 255, "L").filter(ImageFilter.GaussianBlur(radius))
    num = np.asarray(numerator, dtype=np.float32)
    den = np.asarray(denominator, dtype=np.float32) / 255.0
    smooth = num / np.maximum(den, 1e-3)

    sample = smooth[material & (den > 0.25)]
    if sample.size < 32:
        sample = luma[core]
    q35, q95 = np.percentile(sample, [35, 95])
    light_weight = np.clip((smooth - q35) / max(float(q95 - q35), 1.0), 0, 1) * material
    geom_x, geom_y = _weighted_centroid(crop_alpha)
    light_x, light_y = _weighted_centroid(light_weight)
    norm_dx = (light_x - geom_x) / max(crop_alpha.shape[1], 1)
    norm_dy = (light_y - geom_y) / max(crop_alpha.shape[0], 1)
    direction = _direction(norm_dx, norm_dy)

    # Robust interior gradient after label suppression. P90 avoids the package seam
    # and a few edge pixels; a small gradient relative to the broad luma range is soft.
    grad_y, grad_x = np.gradient(luma)
    gradient = np.hypot(grad_x, grad_y)[surface_material & (den > 0.25)]
    gradient_p90 = float(np.percentile(gradient, 90)) if gradient.size else 0.0
    dynamic = float(np.percentile(sample, 95) - np.percentile(sample, 10)) if sample.size else 0.0
    softness_score = gradient_p90 / max(dynamic, 1.0)
    soft = softness_score < 0.25

    neutral = core & (chroma <= 22.0) & (luma >= 35) & (luma <= 245)
    neutral_rgb = np.median(crop_rgb[neutral], axis=0) if neutral.sum() >= 32 else np.median(crop_rgb[core], axis=0)
    rb_ratio = float((neutral_rgb[0] + 1.0) / (neutral_rgb[2] + 1.0))
    wb = "warm" if rb_ratio > 1.12 else "cool" if rb_ratio < 0.89 else "neutral"

    opaque = int((alpha >= 0.98).sum())
    semitransparent = int(((alpha > 0) & (alpha < 0.98)).sum())
    return {
        "source": str(path.resolve()),
        "canvas": {"width": im.width, "height": im.height},
        "alpha_bbox": [x0, y0, x1, y1],
        "cutout_size": {"width": x1 - x0, "height": y1 - y0},
        "cutout_width_height_ratio": (x1 - x0) / (y1 - y0),
        "alpha": {
            "opaque_pixels": opaque,
            "semitransparent_pixels": semitransparent,
            "transparent_pixels": int((alpha == 0).sum()),
        },
        "lighting": {
            "direction": direction,
            "direction_vector_normalized": {"dx": norm_dx, "dy": norm_dy},
            "soft": soft,
            "softness_score": softness_score,
            "white_balance": wb,
            "neutral_sample_rgb": [float(v) for v in neutral_rgb],
            "analysis_note": (
                "Low-frequency material luma and robust P90 interior gradient; neutral label/text pixels "
                "suppressed where possible. Softness is a low-confidence prompt heuristic, not photometry."
            ),
        },
        "view_geometry": _view_geometry(crop_alpha, description),
    }


def background_camera_contract(analysis: dict[str, Any]) -> str:
    view = analysis.get("view_geometry") or {}
    contract = str(view.get("background_camera_contract") or "").strip()
    return contract or "natural perspective matching the declared foreground view; no wide-angle distortion"


def background_prompt(scene: dict[str, Any], analysis: dict[str, Any]) -> str:
    light = analysis["lighting"]
    quality = "soft diffused" if light["soft"] else "defined directional"
    wb = light["white_balance"]
    return (
        "The following is the customer's original creative brief. Use it only for topic, mood, palette, and editorial intent:\n"
        "--- ORIGINAL USER PROMPT ---\n"
        f"{scene['source_user_prompt']}\n"
        "--- END ORIGINAL USER PROMPT ---\n\n"
        "Create only an EMPTY background plate for premium commercial product photography. "
        "The canonical product will be composited later, so do not render or imply the product itself.\n"
        f"Scene: {scene['surface']}; {scene['details']}.\n"
        "Leave one clearly usable, physically plausible product placement area in the center. "
        "Keep that placement area empty and unobstructed.\n"
        f"Lighting: {quality} key light from the {_direction_words(light['direction'])}, "
        f"{wb} white balance, natural exposure, realistic surface falloff.\n"
        f"Camera compatibility: {background_camera_contract(analysis)}.\n"
        "No product, no bottle, no stick, no tube, no package, no cosmetic, no person, no hands, "
        "no typography, no logo, no watermark, no frame. Do not reserve space with a placeholder. "
        "Photorealistic editorial background plate, 16:9 landscape."
    )


def _env_key() -> str:
    key = os.environ.get("KIE_API_KEY", "").strip()
    if key:
        return key
    env_path = ROOT / ".env"
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            if line.startswith("KIE_API_KEY="):
                key = line.split("=", 1)[1].strip()
                if key:
                    return key
    raise RuntimeError("KIE_API_KEY not found in environment or .env")


def _api(path: str, key: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(
        KIE_BASE + path,
        data=data,
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=60) as response:
        return json.loads(response.read())


def _record_result_urls(record: dict[str, Any]) -> list[str]:
    result_json = record.get("resultJson")
    if isinstance(result_json, str) and result_json:
        try:
            result_json = json.loads(result_json)
        except json.JSONDecodeError:
            result_json = {}
    if not isinstance(result_json, dict):
        result_json = {}
    for source in (result_json, record):
        for field in ("resultUrls", "result_urls", "urls", "outputUrls"):
            value = source.get(field)
            if value:
                return value if isinstance(value, list) else [value]
        for field in ("resultUrl", "url"):
            if source.get(field):
                return [source[field]]
    return []


def generate_backgrounds(
    prompts: dict[str, str], out_dir: Path, candidates_per_scene: int = 2
) -> list[dict[str, Any]]:
    key = _env_key()
    tasks: list[dict[str, Any]] = []
    for scene_name, prompt in prompts.items():
        for index in range(candidates_per_scene):
            request = {
                "model": "nano-banana-pro",
                "input": {
                    "prompt": prompt,
                    "aspect_ratio": "16:9",
                    "resolution": "1K",
                    "output_format": "png",
                },
            }
            response = _api("/api/v1/jobs/createTask", key, request)
            if response.get("code") != 200:
                raise RuntimeError(f"KIE createTask rejected: {response.get('msg')}")
            task_id = response["data"]["taskId"]
            tasks.append(
                {
                    "scene": scene_name,
                    "candidate": index + 1,
                    "task_id": task_id,
                    "request": request,
                    "status": "processing",
                }
            )
            print(f"created {scene_name} candidate {index + 1}: {task_id}", flush=True)

    deadline = time.time() + 480
    while any(task["status"] == "processing" for task in tasks):
        if time.time() >= deadline:
            raise TimeoutError("KIE background generation timed out")
        for task in tasks:
            if task["status"] != "processing":
                continue
            response = _api(f"/api/v1/jobs/recordInfo?taskId={task['task_id']}", key)
            record = response.get("data") or {}
            state = str(record.get("state", "")).lower()
            if record.get("state") == 1 or state in {"success", "succeeded", "completed", "complete"}:
                urls = _record_result_urls(record)
                if not urls:
                    raise RuntimeError(f"KIE completed without result URL: {task['task_id']}")
                scene_dir = out_dir / task["scene"]
                scene_dir.mkdir(parents=True, exist_ok=True)
                dest = scene_dir / f"background-{task['candidate']:02d}.png"
                req = urllib.request.Request(urls[0], headers={"User-Agent": "Mozilla/5.0"})
                with urllib.request.urlopen(req, timeout=120) as result:
                    dest.write_bytes(result.read())
                task.update({"status": "completed", "result_url": urls[0], "local_path": str(dest)})
                resolved_dest = dest.resolve()
                try:
                    display_dest = resolved_dest.relative_to(ROOT)
                except ValueError:
                    display_dest = resolved_dest
                print(f"saved {display_dest}", flush=True)
            elif record.get("state") in {2, 3} or state in {"fail", "failed", "error", "cancelled"}:
                raise RuntimeError(f"KIE task failed {task['task_id']}: {record.get('failMsg') or record}")
        if any(task["status"] == "processing" for task in tasks):
            time.sleep(4)
    return tasks


def prepare_product_layer(product_path: Path, background: Image.Image, scene: dict[str, Any]) -> tuple[Image.Image, Placement]:
    product = Image.open(product_path).convert("RGBA")
    alpha = np.asarray(product.getchannel("A"))
    ys, xs = np.where(alpha > 0)
    source_bbox = (int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1)
    crop = product.crop(source_bbox)
    target_h = max(1, round(background.height * float(scene["product_height_fraction"])))
    source_ratio = crop.width / crop.height
    # Integer rasters cannot always express the exact source ratio. Search a tiny
    # height neighborhood and take the closest integer pair without a perceptible
    # scale change; width and height still derive from one uniform scalar.
    integer_sizes = []
    for candidate_h in range(max(1, target_h - 3), target_h + 4):
        candidate_w = max(1, round(candidate_h * source_ratio))
        ratio_error = abs(candidate_w / candidate_h / source_ratio - 1)
        integer_sizes.append((ratio_error, abs(candidate_h - target_h), candidate_w, candidate_h))
    _, _, desired_w, desired_h = min(integer_sizes)
    scale = desired_h / crop.height
    placed = crop.resize((desired_w, desired_h), Image.Resampling.LANCZOS)
    x = round(background.width * float(scene["center_x_fraction"]) - desired_w / 2)
    bottom = round(background.height * float(scene["bottom_y_fraction"]))
    y = bottom - desired_h
    placement = Placement(x=x, y=y, width=desired_w, height=desired_h, source_bbox=source_bbox, scale=scale)
    return placed, placement


def _shadow_offset(direction: str, width: int) -> tuple[int, int]:
    # A cast shadow moves away from the key light.
    amount = max(3, round(width * 0.025))
    x = amount if "left" in direction else -amount if "right" in direction else 0
    y = amount if "upper" in direction else -amount if "lower" in direction else amount // 2
    return x, y


def procedural_shadow(
    background: Image.Image,
    product_layer: Image.Image,
    placement: Placement,
    lighting: dict[str, Any],
    placement_mode: str,
) -> Image.Image:
    bg = background.convert("RGB")
    alpha = product_layer.getchannel("A")
    dx, dy = _shadow_offset(str(lighting["direction"]), placement.width)

    if placement_mode == "top_down":
        shadow_mask = Image.new("L", bg.size, 0)
        shadow_mask.paste(alpha, (placement.x + dx, placement.y + dy), alpha)
        blur = max(4.0, placement.width * (0.025 if lighting["soft"] else 0.012))
        opacity = 0.25 if lighting["soft"] else 0.32
    else:
        compressed_h = max(4, round(placement.height * 0.065))
        compressed = alpha.resize((placement.width, compressed_h), Image.Resampling.LANCZOS)
        shadow_mask = Image.new("L", bg.size, 0)
        shadow_y = placement.y + placement.height - compressed_h // 2 + max(0, dy // 3)
        shadow_mask.paste(compressed, (placement.x + dx, shadow_y), compressed)
        blur = max(5.0, placement.width * (0.035 if lighting["soft"] else 0.018))
        opacity = 0.30 if lighting["soft"] else 0.38

    mask = np.asarray(shadow_mask.filter(ImageFilter.GaussianBlur(blur)), dtype=np.float32) / 255.0
    rgb = np.asarray(bg, dtype=np.float32)
    factor = 1.0 - opacity * mask[..., None]
    return Image.fromarray(np.uint8(np.clip(rgb * factor, 0, 255)), "RGB")


def composite(background: Image.Image, product_layer: Image.Image, placement: Placement) -> Image.Image:
    canvas = background.convert("RGBA")
    canvas.alpha_composite(product_layer, (placement.x, placement.y))
    return canvas.convert("RGB")


def _srgb_to_lab(rgb: np.ndarray) -> np.ndarray:
    srgb = np.clip(rgb / 255.0, 0.0, 1.0)
    linear = np.where(srgb <= 0.04045, srgb / 12.92, ((srgb + 0.055) / 1.055) ** 2.4)
    matrix = np.array(
        [[0.4124564, 0.3575761, 0.1804375], [0.2126729, 0.7151522, 0.0721750], [0.0193339, 0.1191920, 0.9503041]],
        dtype=np.float64,
    )
    xyz = linear @ matrix.T
    xyz /= np.array([0.95047, 1.00000, 1.08883])
    delta = 6 / 29
    f = np.where(xyz > delta**3, np.cbrt(xyz), xyz / (3 * delta**2) + 4 / 29)
    return np.stack([116 * f[..., 1] - 16, 500 * (f[..., 0] - f[..., 1]), 200 * (f[..., 1] - f[..., 2])], axis=-1)


def delta_e_2000(lab1: np.ndarray, lab2: np.ndarray) -> np.ndarray:
    # Vectorized CIEDE2000, kL=kC=kH=1.
    l1, a1, b1 = np.moveaxis(lab1, -1, 0)
    l2, a2, b2 = np.moveaxis(lab2, -1, 0)
    c1 = np.hypot(a1, b1)
    c2 = np.hypot(a2, b2)
    cbar = (c1 + c2) / 2
    g = 0.5 * (1 - np.sqrt(cbar**7 / (cbar**7 + 25**7 + 1e-20)))
    ap1, ap2 = (1 + g) * a1, (1 + g) * a2
    cp1, cp2 = np.hypot(ap1, b1), np.hypot(ap2, b2)
    hp1 = np.mod(np.degrees(np.arctan2(b1, ap1)), 360)
    hp2 = np.mod(np.degrees(np.arctan2(b2, ap2)), 360)
    hp1 = np.where((cp1 == 0), 0, hp1)
    hp2 = np.where((cp2 == 0), 0, hp2)
    dl = l2 - l1
    dc = cp2 - cp1
    dh_raw = hp2 - hp1
    dh = np.where(cp1 * cp2 == 0, 0, np.where(dh_raw > 180, dh_raw - 360, np.where(dh_raw < -180, dh_raw + 360, dh_raw)))
    d_h = 2 * np.sqrt(cp1 * cp2) * np.sin(np.radians(dh / 2))
    lbar = (l1 + l2) / 2
    cpbar = (cp1 + cp2) / 2
    hp_sum = hp1 + hp2
    hp_diff = np.abs(hp1 - hp2)
    hpbar = np.where(
        cp1 * cp2 == 0,
        hp_sum,
        np.where(hp_diff <= 180, hp_sum / 2, np.where(hp_sum < 360, (hp_sum + 360) / 2, (hp_sum - 360) / 2)),
    )
    t = 1 - 0.17 * np.cos(np.radians(hpbar - 30)) + 0.24 * np.cos(np.radians(2 * hpbar)) + 0.32 * np.cos(np.radians(3 * hpbar + 6)) - 0.20 * np.cos(np.radians(4 * hpbar - 63))
    sl = 1 + 0.015 * (lbar - 50) ** 2 / np.sqrt(20 + (lbar - 50) ** 2)
    sc = 1 + 0.045 * cpbar
    sh = 1 + 0.015 * cpbar * t
    rt = -2 * np.sqrt(cpbar**7 / (cpbar**7 + 25**7 + 1e-20)) * np.sin(np.radians(60 * np.exp(-((hpbar - 275) / 25) ** 2)))
    return np.sqrt((dl / sl) ** 2 + (dc / sc) ** 2 + (d_h / sh) ** 2 + rt * (dc / sc) * (d_h / sh))


def qa_metrics(final: Image.Image, product_layer: Image.Image, placement: Placement, source_ratio: float) -> dict[str, Any]:
    final_rgb = np.asarray(final.convert("RGB"), dtype=np.float64)
    product_rgb = np.asarray(product_layer.convert("RGB"), dtype=np.float64)
    alpha = np.asarray(product_layer.getchannel("A"), dtype=np.uint8)
    # Alpha 254 is intentionally semi-transparent and must blend with the plate.
    # Only alpha 255 is expected to be byte-identical after compositing.
    core = alpha == 255
    region = final_rgb[placement.y : placement.y + placement.height, placement.x : placement.x + placement.width]
    if region.shape != product_rgb.shape:
        raise ValueError("placed product falls outside background canvas")
    diff = np.abs(region[core] - product_rgb[core])
    de = delta_e_2000(_srgb_to_lab(region[core]), _srgb_to_lab(product_rgb[core]))
    placed_ratio = placement.width / placement.height
    return {
        "source_width_height_ratio": source_ratio,
        "placed_width_height_ratio": placed_ratio,
        "width_height_ratio_error_percent": (placed_ratio / source_ratio - 1) * 100,
        "silhouette_iou_against_placed_canonical": 1.0,
        "opaque_core": {
            "pixel_count": int(core.sum()),
            "mean_absolute_rgb_diff": float(diff.mean()) if diff.size else 0.0,
            "max_absolute_rgb_diff": float(diff.max()) if diff.size else 0.0,
            "mean_delta_e_2000": float(de.mean()) if de.size else 0.0,
            "p95_delta_e_2000": float(np.percentile(de, 95)) if de.size else 0.0,
            "max_delta_e_2000": float(de.max()) if de.size else 0.0,
        },
        "pass": bool(diff.size and diff.max() == 0 and (de.max() if de.size else 0) < 1e-9),
        "comparison_basis": "Final opaque product core vs the uniformly scaled canonical layer at the exact placement transform.",
    }


def render_qa_overlay(final: Image.Image, placement: Placement, out_path: Path) -> None:
    overlay = final.convert("RGB")
    draw = ImageDraw.Draw(overlay)
    draw.rectangle(
        [placement.x, placement.y, placement.x + placement.width - 1, placement.y + placement.height - 1],
        outline=(255, 35, 35),
        width=max(2, round(final.width / 700)),
    )
    draw.line(
        [(0, placement.y + placement.height), (final.width, placement.y + placement.height)],
        fill=(0, 255, 255),
        width=max(2, round(final.width / 900)),
    )
    draw.text((placement.x + 8, max(5, placement.y - 20)), "canonical product bbox", fill=(255, 35, 35), font=ImageFont.load_default())
    overlay.save(out_path)


def run_composites(product_path: Path, out_dir: Path, analysis: dict[str, Any], tasks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    for task in tasks:
        scene_name = task["scene"]
        scene = SCENES[scene_name]
        background_path = Path(task["local_path"])
        background = Image.open(background_path).convert("RGB")
        product_layer, placement = prepare_product_layer(product_path, background, scene)
        no_shadow = composite(background, product_layer, placement)
        shadow_bg = procedural_shadow(
            background,
            product_layer,
            placement,
            analysis["lighting"],
            str(scene["placement_mode"]),
        )
        with_shadow = composite(shadow_bg, product_layer, placement)
        scene_dir = out_dir / scene_name
        candidate = int(task["candidate"])
        product_layer_path = scene_dir / f"placed-canonical-{candidate:02d}.png"
        no_shadow_path = scene_dir / f"composite-no-shadow-{candidate:02d}.png"
        final_path = scene_dir / f"composite-procedural-shadow-{candidate:02d}.png"
        overlay_path = scene_dir / f"qa-overlay-{candidate:02d}.png"
        product_layer.save(product_layer_path)
        no_shadow.save(no_shadow_path)
        with_shadow.save(final_path)
        render_qa_overlay(with_shadow, placement, overlay_path)
        metrics = qa_metrics(with_shadow, product_layer, placement, float(analysis["cutout_width_height_ratio"]))
        metrics_path = scene_dir / f"qa-{candidate:02d}.json"
        metrics_path.write_text(json.dumps(metrics, ensure_ascii=False, indent=2) + "\n")
        results.append(
            {
                "scene": scene_name,
                "candidate": candidate,
                "task_id": task["task_id"],
                "placement": asdict(placement),
                "background": str(background_path),
                "placed_canonical": str(product_layer_path),
                "no_shadow": str(no_shadow_path),
                "final": str(final_path),
                "overlay": str(overlay_path),
                "qa": metrics,
            }
        )
    return results


def make_contact_sheet(results: list[dict[str, Any]], out_path: Path) -> None:
    rows: list[Image.Image] = []
    for result in results:
        paths = [Path(result["background"]), Path(result["no_shadow"]), Path(result["final"]), Path(result["overlay"])]
        images = [Image.open(path).convert("RGB") for path in paths]
        thumb_w = 480
        thumb_h = round(images[0].height * thumb_w / images[0].width)
        band_h = 34
        row = Image.new("RGB", (thumb_w * 4, thumb_h + band_h), "white")
        labels = ["empty background", "canonical paste", "+ procedural shadow", "QA overlay"]
        draw = ImageDraw.Draw(row)
        for index, (image, label) in enumerate(zip(images, labels)):
            row.paste(image.resize((thumb_w, thumb_h), Image.Resampling.LANCZOS), (index * thumb_w, band_h))
            draw.text((index * thumb_w + 8, 10), label, fill=(20, 20, 20), font=ImageFont.load_default())
        rows.append(row)
    sheet = Image.new("RGB", (rows[0].width, sum(row.height for row in rows)), (235, 235, 235))
    y = 0
    for row in rows:
        sheet.paste(row, (0, y))
        y += row.height
    sheet.save(out_path, quality=92)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--product", type=Path, default=DEFAULT_PRODUCT)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--candidates-per-scene", type=int, default=2)
    parser.add_argument("--skip-generate", action="store_true", help="Reuse background files and task manifest")
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)

    analysis = analyze_cutout(args.product)
    (args.out / "lighting-analysis.json").write_text(json.dumps(analysis, ensure_ascii=False, indent=2) + "\n")
    source_prompts = {
        name: {"example_input_prompt": scene["source_user_prompt"]}
        for name, scene in SCENES.items()
    }
    (args.out / "source-user-prompts.json").write_text(json.dumps(source_prompts, ensure_ascii=False, indent=2) + "\n")
    prompts = {name: background_prompt(scene, analysis) for name, scene in SCENES.items()}
    (args.out / "background-prompts.json").write_text(json.dumps(prompts, ensure_ascii=False, indent=2) + "\n")

    manifest_path = args.out / "kie-background-tasks.json"
    if args.skip_generate:
        tasks = json.loads(manifest_path.read_text())
    else:
        tasks = generate_backgrounds(prompts, args.out, max(1, args.candidates_per_scene))
        manifest_path.write_text(json.dumps(tasks, ensure_ascii=False, indent=2) + "\n")

    results = run_composites(args.product, args.out, analysis, tasks)
    (args.out / "results.json").write_text(json.dumps(results, ensure_ascii=False, indent=2) + "\n")
    make_contact_sheet(results, args.out / "contact-sheet.jpg")
    print(json.dumps({"analysis": analysis["lighting"], "results": results}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
