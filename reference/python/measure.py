#!/usr/bin/env python3
"""AEO-141/142 QA 측정 도구.

생성물 vs 레퍼런스의 제품 bbox W/H 비율과 평균 색(ΔE 근사)을 비교한다.
사용:
  python3 measure.py <image> [--thresh 245]           # 단일 이미지 bbox 비율
  python3 measure.py <ref> <gen> [<gen2> ...]         # 레퍼런스 대비 비교 리포트
  python3 measure.py <ref> <gen> --overlay-dieline <square-drawing.png>

``--overlay-dieline``은 도면의 어두운 선을 마지막 결과물에 검은색으로 겹쳐
형상 drift를 눈으로 확인할 수 있는 PNG를 만든다.
"""
import argparse
import json
from pathlib import Path

from PIL import Image

from dieline_overlay import composite_dieline


def product_bbox(path, thresh=245):
    """흰 배경 가정: 밝기 thresh 미만 픽셀의 bounding box."""
    im = Image.open(path).convert("L")
    # Full-resolution mask: subsampling even every other pixel makes a 1 px geometry
    # contract impossible to verify reliably on 2K outputs.
    mask = im.point(lambda value: 255 if value < thresh else 0, mode="L")
    bbox = mask.getbbox()
    if bbox is None:
        return None
    left, top, right, bottom = bbox
    return bbox, (right - left, bottom - top)


def mean_rgb_in_bbox(path, bbox):
    im = Image.open(path).convert("RGB")
    region = im.crop(bbox)
    region.thumbnail((64, 64))
    px = list(region.get_flattened_data())
    n = len(px)
    return tuple(round(sum(c[i] for c in px) / n, 1) for i in range(3))


def report_with_bbox(path, bbox):
    left, top, right, bottom = bbox
    bw, bh = right - left, bottom - top
    ratio = bw / bh
    rgb = mean_rgb_in_bbox(path, bbox)
    return {"path": path, "bbox": bbox, "bbox_wh": (bw, bh), "ratio": ratio, "mean_rgb": rgb}


def report(path, thresh=245):
    r = product_bbox(path, thresh)
    if r is None:
        return None
    bbox, _ = r
    return report_with_bbox(path, bbox)


def report_from_mask(image_path, mask_path):
    """Measure the reference from a QA mask whose nonzero region is the exact silhouette."""
    mask = Image.open(mask_path).convert("L")
    image = Image.open(image_path)
    if mask.size != image.size:
        raise ValueError(
            f"reference mask size {mask.size} does not match first image size {image.size}"
        )
    bbox = mask.getbbox()
    if bbox is None:
        return None
    row = report_with_bbox(image_path, bbox)
    row["geometry_source"] = mask_path
    return row


def overlay_dieline(result_path, dieline_path, output_path, thresh=245):
    result = Image.open(result_path).convert("RGB")
    drawing = Image.open(dieline_path).convert("RGB")
    result = composite_dieline(result, drawing)
    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    result.save(output_path)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("images", nargs="+")
    parser.add_argument("--thresh", type=int, default=245)
    parser.add_argument("--json-out")
    parser.add_argument("--reference-mask", help="nonzero silhouette mask for exact first-image bbox")
    parser.add_argument("--overlay-dieline")
    parser.add_argument("--overlay-out", default="out/dieline-overlay.png")
    args = parser.parse_args()

    rows = [report(path, args.thresh) for path in args.images]
    if args.reference_mask:
        rows[0] = report_from_mask(args.images[0], args.reference_mask)
    rows = [r for r in rows if r]
    if not rows:
        raise SystemExit("no measurable image")
    ref = rows[0]
    print(f"{'image':58s} {'W/H':>7s} {'vs ref':>8s} {'mean RGB':>18s}")
    for r in rows:
        dev = (r["ratio"] / ref["ratio"] - 1) * 100
        name = r["path"].rsplit("/", 1)[-1][:56]
        print(f"{name:58s} {r['ratio']:7.3f} {dev:+7.1f}% {str(r['mean_rgb']):>18s}")

    if args.json_out:
        payload = {
            "threshold": args.thresh,
            "reference": ref["path"],
            "measurements": [
                {
                    **row,
                    "ratio_error_pct": (row["ratio"] / ref["ratio"] - 1) * 100,
                }
                for row in rows
            ],
        }
        Path(args.json_out).parent.mkdir(parents=True, exist_ok=True)
        Path(args.json_out).write_text(json.dumps(payload, indent=2) + "\n")
    if args.overlay_dieline:
        overlay_dieline(args.images[-1], args.overlay_dieline, args.overlay_out, args.thresh)
        print(f"overlay saved: {args.overlay_out}")


if __name__ == "__main__":
    main()
