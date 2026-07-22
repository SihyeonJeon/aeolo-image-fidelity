#!/usr/bin/env python3
"""Composite the actual dieline over a render after removing its white background."""

from PIL import Image, ImageChops


def white_to_transparent(drawing: Image.Image) -> Image.Image:
    """Turn white into alpha while preserving the drawing's original colored line pixels.

    Dark line cores stay fully opaque. Near-white antialiased edge pixels receive a
    soft alpha, avoiding a white fringe without replacing the source line color.
    """
    rgb = drawing.convert("RGB")
    red, green, blue = rgb.split()
    darkest_channel = ImageChops.darker(ImageChops.darker(red, green), blue)
    alpha = darkest_channel.point(
        lambda value: min(255, max(0, round((255 - value) * 2))),
        mode="L",
    )
    red, green, blue = rgb.split()
    return Image.merge("RGBA", (red, green, blue, alpha))


def composite_dieline(result: Image.Image, drawing: Image.Image) -> Image.Image:
    """Overlay the actual transparentized drawing without modifying the source images."""
    base = result.convert("RGBA")
    if drawing.size != base.size:
        drawing = drawing.resize(base.size, Image.Resampling.LANCZOS)
    return Image.alpha_composite(base, white_to_transparent(drawing)).convert("RGB")
