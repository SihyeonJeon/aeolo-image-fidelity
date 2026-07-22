import sharp from 'sharp'

import {
  harmonizeCanonicalLayer,
  resolveCompositeColorPolicy,
  sampleLocalBackgroundColor,
} from './composite.js'
import type {
  CanonicalCutoutSlot,
  CompositeColorReport,
  CompositePlacement,
  CompositeSizeResolution,
  CutoutAnalysis,
  ResolvedCompositeColorPolicy,
  SupportPlane,
} from './composite.js'

export type OutpaintResolution = '1K' | '2K'

export interface OutpaintPlacementInput {
  /** Product height as a fraction of the output canvas. Defaults to the tested 0.38 hero framing. */
  heightFraction?: number
  /** Horizontal product center as a fraction of the output canvas. */
  centerXFraction?: number
  /** Physical bottom/contact row as a fraction of the output canvas. */
  contactYFraction?: number
  /** Reject when the provider-redrawn silhouette edge moves farther than this. */
  maxRawBoundaryOffsetPx?: number
}

export interface OutpaintRequest {
  originalPrompt: string
  canonicalCutout: CanonicalCutoutSlot
  size: CompositeSizeResolution
  resolution?: OutpaintResolution
  placement?: OutpaintPlacementInput
}

export interface ResolvedOutpaintPlacement {
  canvas: { width: number; height: number }
  resolution: OutpaintResolution
  aspectRatio: '16:9'
  x: number
  y: number
  width: number
  height: number
  centerXFraction: number
  heightFraction: number
  contactY: number
  contactYFraction: number
  sourceBbox: [number, number, number, number]
  sourceWidthHeightRatio: number
  widthHeightRatioErrorPercent: number
  transform: 'uniform_scale_and_translation'
  maxRawBoundaryOffsetPx: number
}

export interface PreparedOutpaintCanvas {
  inputCanvas: Buffer
  canonicalLayer: Buffer
  placement: ResolvedOutpaintPlacement
}

export interface OutpaintPixelDifference {
  opaquePixelCount: number
  changedOpaquePixelCount: number
  meanAbsoluteRgbDifference: number
  maxAbsoluteRgbDifference: number
}

export interface OutpaintBoundaryRegistration {
  dx: number
  dy: number
  distancePx: number
  confidence: number
  expectedPositionScore: number
  bestScore: number
  sampledBoundaryPixelCount: number
  passed: boolean
}

export interface OutpaintQaReport {
  expectedCanvas: { width: number; height: number }
  actualCanvas: { width: number; height: number }
  exactCanvasSize: boolean
  placement: ResolvedOutpaintPlacement
  placementBottomMatchesContact: boolean
  widthHeightRatioErrorPercent: number
  silhouetteIouAgainstPlacedCanonical: 1
  rawForegroundDifference?: OutpaintPixelDifference
  finalOpaqueCoreDifference?: OutpaintPixelDifference
  rawBoundaryRegistration?: OutpaintBoundaryRegistration
  /** Intended bounded RGB-only transform. Present when provider dimensions allow finalization. */
  color?: CompositeColorReport
  semiTransparentBoundaryPixelCount: number
  edgeStrategy: 'canonical_alpha_over_provider_raw'
  geometry: {
    transform: 'uniform_scale_and_translation'
    warpApplied: false
    providerForegroundUsedAsFinal: false
    canonicalLayerCompositedLast: true
  }
  warnings: string[]
  pass: boolean
  rejectionReasons: string[]
}

export interface OutpaintQaAcceptance {
  accepted: boolean
  retryRecommended: boolean
  reasons: string[]
}

export interface OutpaintFinalization {
  result?: Buffer
  overlay?: Buffer
  report: OutpaintQaReport
  acceptance: OutpaintQaAcceptance
}

export interface OutpaintFinalizeOptions {
  sourceNeutralRgb?: [number, number, number]
  colorPolicy?: ResolvedCompositeColorPolicy
}

const OUTPAINT_CANVASES: Record<OutpaintResolution, { width: number; height: number }> = {
  '1K': { width: 1376, height: 768 },
  '2K': { width: 2752, height: 1536 },
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value))
}

function validateFraction(name: string, value: number, low: number, high: number): void {
  if (!Number.isFinite(value) || value < low || value > high) {
    throw new Error(`outpaint ${name} must be between ${low} and ${high}`)
  }
}

export function outpaintCanvasDimensions(resolution: OutpaintResolution): { width: number; height: number } {
  return { ...OUTPAINT_CANVASES[resolution] }
}

export async function prepareOutpaintCanvas(
  cutout: Buffer,
  analysis: CutoutAnalysis,
  resolution: OutpaintResolution = '2K',
  input: OutpaintPlacementInput = {},
): Promise<PreparedOutpaintCanvas> {
  const canvas = outpaintCanvasDimensions(resolution)
  const heightFraction = input.heightFraction ?? 0.38
  const centerXFraction = input.centerXFraction ?? 0.52
  const contactYFraction = input.contactYFraction ?? 0.71
  const maxRawBoundaryOffsetPx = input.maxRawBoundaryOffsetPx ?? (resolution === '2K' ? 4 : 2)
  validateFraction('heightFraction', heightFraction, 0.12, 0.65)
  validateFraction('centerXFraction', centerXFraction, 0.15, 0.85)
  validateFraction('contactYFraction', contactYFraction, 0.35, 0.92)
  if (!Number.isInteger(maxRawBoundaryOffsetPx) || maxRawBoundaryOffsetPx < 0 || maxRawBoundaryOffsetPx > 16) {
    throw new Error('outpaint maxRawBoundaryOffsetPx must be an integer between 0 and 16')
  }

  const [left, top, right, bottom] = analysis.alphaBbox
  const sourceWidth = right - left
  const sourceHeight = bottom - top
  if (sourceWidth <= 0 || sourceHeight <= 0) throw new Error('outpaint canonical alpha bbox is empty')
  const sourceRatio = sourceWidth / sourceHeight
  const targetHeight = Math.round(canvas.height * heightFraction)
  const candidates: Array<[number, number, number, number]> = []
  for (let height = Math.max(1, targetHeight - 3); height <= targetHeight + 3; height += 1) {
    const width = Math.max(1, Math.round(height * sourceRatio))
    candidates.push([Math.abs(width / height / sourceRatio - 1), Math.abs(height - targetHeight), width, height])
  }
  candidates.sort((first, second) => first[0] - second[0] || first[1] - second[1])
  const [, , width, height] = candidates[0]
  const contactY = Math.round(canvas.height * contactYFraction)
  const x = Math.round(canvas.width * centerXFraction - width / 2)
  const y = contactY - height
  if (x < 0 || y < 0 || x + width > canvas.width || y + height > canvas.height) {
    throw new Error('outpaint resolved placement falls outside the output canvas')
  }

  const canonicalLayer = await sharp(cutout)
    .extract({ left, top, width: sourceWidth, height: sourceHeight })
    .resize(width, height, { kernel: sharp.kernel.lanczos3 })
    .ensureAlpha()
    .png()
    .toBuffer()
  const inputCanvas = await sharp({
    create: { width: canvas.width, height: canvas.height, channels: 3, background: '#ffffff' },
  }).composite([{ input: canonicalLayer, left: x, top: y, blend: 'over' }]).png().toBuffer()
  return {
    inputCanvas,
    canonicalLayer,
    placement: {
      canvas,
      resolution,
      aspectRatio: '16:9',
      x,
      y,
      width,
      height,
      centerXFraction,
      heightFraction: height / canvas.height,
      contactY,
      contactYFraction: contactY / canvas.height,
      sourceBbox: analysis.alphaBbox,
      sourceWidthHeightRatio: sourceRatio,
      widthHeightRatioErrorPercent: (width / height / sourceRatio - 1) * 100,
      transform: 'uniform_scale_and_translation',
      maxRawBoundaryOffsetPx,
    },
  }
}

function lightingWords(analysis: CutoutAnalysis): string {
  const direction = analysis.lighting.direction.replaceAll('_', ' ')
  return `${analysis.lighting.soft ? 'soft diffused' : 'defined directional'} light from ${direction}, ${analysis.lighting.whiteBalance} white balance`
}

export function compileOutpaintPrompt(
  request: OutpaintRequest,
  analysis: CutoutAnalysis,
  placement: ResolvedOutpaintPlacement,
): string {
  const declaredScale = request.size.confidence === 'declared'
    ? `The existing foreground is declared to be ${request.size.heightCm.toFixed(1)} cm tall.`
    : `Treat the existing foreground as an approximately ${request.size.heightCm.toFixed(1)} cm tall ${request.size.sizeClass.replaceAll('_', ' ')} based only on the supplied description.`
  return `The following is the customer's exact original creative brief. Use it for the surrounding scene, mood, palette, props and editorial intent.
--- ORIGINAL USER PROMPT ---
${request.originalPrompt.trim()}
--- END ORIGINAL USER PROMPT ---

IMAGE 1 is the EDIT TARGET: a white ${placement.resolution} 16:9 expansion canvas containing one pre-positioned canonical foreground.
DESCRIPTION: ${request.canonicalCutout.description.trim()}
ROLE: ${request.canonicalCutout.role.trim()}

OUTPAINT AND REPLACE ONLY THE PURE-WHITE AREA OUTSIDE THE EXISTING FOREGROUND SILHOUETTE. Treat every existing foreground pixel, label character, highlight, edge and exact silhouette as a locked protected plate. Do not redraw, regenerate, retouch, relight, recolor, resize, warp, move, blur, sharpen, crop, cover or alter it. Never create a duplicate, reflected duplicate, proxy package or second version of the foreground.

Build the scene behind and around the fixed foreground according to the original user prompt. Keep its immediate silhouette unobstructed. ${declaredScale} It occupies ${(placement.heightFraction * 100).toFixed(1)}% of frame height, so all surrounding objects must have physically plausible relative scale.

The exact bottom row of the existing foreground at ${(placement.contactYFraction * 100).toFixed(1)}% of frame height is its physical contact row. Generate a broad level support surface that meets that exact row so the foreground visibly rests on the surface, never floats and never sinks below a rim. Add a tight ambient-occlusion contact shadow and a coherent short cast shadow only in the surrounding pixels outside the protected silhouette.

LIGHTING CONTRACT: Match the foreground's existing ${lightingWords(analysis)} by designing the surrounding scene around it. Environmental color belongs in the generated surroundings; do not recolor the locked foreground.
CAMERA CONTRACT: Keep the camera near the foreground's mid-height with a normal-to-long perspective, level dominant horizontals and no wide-angle distortion. The support plane must remain shallow and physically readable around the contact row.
FOCUS CONTRACT: Render focus-stacked commercial clarity. Scene textures and context objects must remain sharp with no bokeh, shallow depth of field, selective focus, foreground/background defocus, dreamy blur or tilt-shift effect.

Do not place any generated object, text or effect in front of the protected foreground. No additional logos, no extra typography, no watermark and no frame.`
}

function pixelDifferenceAtPlacement(
  reference: Uint8Array,
  referenceChannels: number,
  target: Uint8Array,
  targetWidth: number,
  targetChannels: number,
  placement: ResolvedOutpaintPlacement,
): OutpaintPixelDifference {
  let opaquePixelCount = 0
  let changedOpaquePixelCount = 0
  let absoluteRgbDifference = 0
  let maxAbsoluteRgbDifference = 0
  for (let y = 0; y < placement.height; y += 1) {
    for (let x = 0; x < placement.width; x += 1) {
      const referenceOffset = (y * placement.width + x) * referenceChannels
      if (reference[referenceOffset + 3] !== 255) continue
      const targetOffset = ((placement.y + y) * targetWidth + placement.x + x) * targetChannels
      let changed = false
      for (let channel = 0; channel < 3; channel += 1) {
        const difference = Math.abs(reference[referenceOffset + channel] - target[targetOffset + channel])
        absoluteRgbDifference += difference
        maxAbsoluteRgbDifference = Math.max(maxAbsoluteRgbDifference, difference)
        if (difference !== 0) changed = true
      }
      if (changed) changedOpaquePixelCount += 1
      opaquePixelCount += 1
    }
  }
  return {
    opaquePixelCount,
    changedOpaquePixelCount,
    meanAbsoluteRgbDifference: opaquePixelCount ? absoluteRgbDifference / (opaquePixelCount * 3) : 0,
    maxAbsoluteRgbDifference,
  }
}

function median(values: number[]): number {
  if (!values.length) return 0
  const ordered = [...values].sort((first, second) => first - second)
  const midpoint = Math.floor(ordered.length / 2)
  return ordered.length % 2 ? ordered[midpoint] : (ordered[midpoint - 1] + ordered[midpoint]) / 2
}

function boundaryRegistration(
  layer: Uint8Array,
  layerChannels: number,
  raw: Uint8Array,
  rawWidth: number,
  rawHeight: number,
  rawChannels: number,
  placement: ResolvedOutpaintPlacement,
): OutpaintBoundaryRegistration {
  const boundary: Array<[number, number]> = []
  const foreground = (x: number, y: number): boolean => {
    if (x < 0 || y < 0 || x >= placement.width || y >= placement.height) return false
    return layer[(y * placement.width + x) * layerChannels + 3] >= 128
  }
  for (let y = 0; y < placement.height; y += 1) {
    for (let x = 0; x < placement.width; x += 1) {
      if (!foreground(x, y)) continue
      if (!foreground(x - 1, y) || !foreground(x + 1, y) || !foreground(x, y - 1) || !foreground(x, y + 1)) {
        boundary.push([x, y])
      }
    }
  }
  const stride = Math.max(1, Math.floor(boundary.length / 2400))
  const sampled = boundary.filter((_, index) => index % stride === 0)
  const luma = (x: number, y: number): number => {
    const offset = (y * rawWidth + x) * rawChannels
    return 0.2126 * raw[offset] + 0.7152 * raw[offset + 1] + 0.0722 * raw[offset + 2]
  }
  const gradient = (x: number, y: number): number => {
    if (x <= 0 || y <= 0 || x + 1 >= rawWidth || y + 1 >= rawHeight) return 0
    const dx = (luma(x + 1, y) - luma(x - 1, y)) / 2
    const dy = (luma(x, y + 1) - luma(x, y - 1)) / 2
    return Math.hypot(dx, dy)
  }
  const search = Math.max(6, placement.maxRawBoundaryOffsetPx + 2)
  const candidates: Array<{ dx: number; dy: number; score: number }> = []
  for (let dy = -search; dy <= search; dy += 1) {
    for (let dx = -search; dx <= search; dx += 1) {
      let score = 0
      let count = 0
      for (const [x, y] of sampled) {
        const targetX = placement.x + x + dx
        const targetY = placement.y + y + dy
        if (targetX <= 0 || targetY <= 0 || targetX + 1 >= rawWidth || targetY + 1 >= rawHeight) continue
        score += gradient(targetX, targetY)
        count += 1
      }
      candidates.push({ dx, dy, score: count ? score / count : 0 })
    }
  }
  candidates.sort((first, second) => second.score - first.score)
  const best = candidates[0] ?? { dx: 0, dy: 0, score: 0 }
  const expected = candidates.find((candidate) => candidate.dx === 0 && candidate.dy === 0)?.score ?? 0
  const confidence = clamp((best.score - median(candidates.map((candidate) => candidate.score))) / Math.max(best.score, 1), 0, 1)
  const distancePx = Math.hypot(best.dx, best.dy)
  return {
    dx: best.dx,
    dy: best.dy,
    distancePx,
    confidence,
    expectedPositionScore: expected,
    bestScore: best.score,
    sampledBoundaryPixelCount: sampled.length,
    passed: distancePx <= placement.maxRawBoundaryOffsetPx,
  }
}

function semiTransparentPixelCount(layer: Uint8Array, channels: number): number {
  let count = 0
  for (let offset = 0; offset < layer.length; offset += channels) {
    const alpha = layer[offset + 3]
    if (alpha > 0 && alpha < 255) count += 1
  }
  return count
}

function outpaintColorSamplingGeometry(placement: ResolvedOutpaintPlacement): {
  placement: CompositePlacement
  support: SupportPlane
} {
  const sourceHeight = placement.sourceBbox[3] - placement.sourceBbox[1]
  const halfDepth = Math.max(24, Math.round(placement.canvas.height * 0.045))
  return {
    placement: {
      x: placement.x,
      y: placement.y,
      width: placement.width,
      height: placement.height,
      sourceBbox: placement.sourceBbox,
      scale: sourceHeight > 0 ? placement.height / sourceHeight : 1,
    },
    support: {
      backY: Math.max(0, placement.contactY - halfDepth),
      frontY: Math.min(placement.canvas.height - 1, placement.contactY + halfDepth),
      contactY: placement.contactY,
      confidence: 'high',
      method: 'stored_outpaint_contact_band_for_color_sampling',
      analysisWindow: { x0: 0, x1: placement.canvas.width, widthFraction: 1 },
      backScore: 1,
      frontScore: 1,
    },
  }
}

async function outpaintOverlay(
  result: Buffer,
  placement: ResolvedOutpaintPlacement,
  registration: OutpaintBoundaryRegistration,
): Promise<Buffer> {
  const line = Math.max(2, Math.round(placement.canvas.width / 700))
  const shiftedX = placement.x + registration.dx
  const shiftedY = placement.y + registration.dy
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${placement.canvas.width}" height="${placement.canvas.height}">
    <line x1="0" y1="${placement.contactY}" x2="${placement.canvas.width}" y2="${placement.contactY}" stroke="#00ffff" stroke-width="${line}"/>
    <rect x="${placement.x}" y="${placement.y}" width="${placement.width}" height="${placement.height}" fill="none" stroke="#ff2323" stroke-width="${line}"/>
    <rect x="${shiftedX}" y="${shiftedY}" width="${placement.width}" height="${placement.height}" fill="none" stroke="#55ff55" stroke-width="${line}" stroke-dasharray="${line * 2},${line * 2}"/>
  </svg>`)
  return sharp(result).composite([{ input: svg, blend: 'over' }]).png().toBuffer()
}

export async function finalizeOutpaint(
  rawResult: Buffer,
  canonicalLayer: Buffer,
  placement: ResolvedOutpaintPlacement,
  options: OutpaintFinalizeOptions = {},
): Promise<OutpaintFinalization> {
  const metadata = await sharp(rawResult).metadata()
  const actualCanvas = { width: metadata.width ?? 0, height: metadata.height ?? 0 }
  const exactCanvasSize = actualCanvas.width === placement.canvas.width && actualCanvas.height === placement.canvas.height
  const rejectionReasons: string[] = []
  const warnings: string[] = []
  const layer = await sharp(canonicalLayer).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const semiTransparentBoundaryPixelCount = semiTransparentPixelCount(layer.data, layer.info.channels)
  if (!exactCanvasSize) {
    rejectionReasons.push('provider_canvas_dimensions_changed')
    const report: OutpaintQaReport = {
      expectedCanvas: placement.canvas,
      actualCanvas,
      exactCanvasSize,
      placement,
      placementBottomMatchesContact: placement.y + placement.height === placement.contactY,
      widthHeightRatioErrorPercent: placement.widthHeightRatioErrorPercent,
      silhouetteIouAgainstPlacedCanonical: 1,
      semiTransparentBoundaryPixelCount,
      edgeStrategy: 'canonical_alpha_over_provider_raw',
      geometry: {
        transform: 'uniform_scale_and_translation',
        warpApplied: false,
        providerForegroundUsedAsFinal: false,
        canonicalLayerCompositedLast: true,
      },
      warnings,
      pass: false,
      rejectionReasons,
    }
    return { report, acceptance: { accepted: false, retryRecommended: true, reasons: rejectionReasons } }
  }

  const raw = await sharp(rawResult).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const rawForegroundDifference = pixelDifferenceAtPlacement(
    layer.data,
    layer.info.channels,
    raw.data,
    raw.info.width,
    raw.info.channels,
    placement,
  )
  const registration = boundaryRegistration(
    layer.data,
    layer.info.channels,
    raw.data,
    raw.info.width,
    raw.info.height,
    raw.info.channels,
    placement,
  )
  const colorPolicy = options.colorPolicy ?? resolveCompositeColorPolicy()
  const colorSampling = outpaintColorSamplingGeometry(placement)
  const localBackgroundSample = await sampleLocalBackgroundColor(
    rawResult,
    colorSampling.placement,
    colorSampling.support,
    options.sourceNeutralRgb ?? [128, 128, 128],
    { excludePlacement: true, maxNeutralChromaFraction: 0.28 },
  )
  const { layer: renderedLayer, report: color } = await harmonizeCanonicalLayer(
    canonicalLayer,
    options.sourceNeutralRgb ?? [128, 128, 128],
    localBackgroundSample,
    colorPolicy,
  )
  const rendered = await sharp(renderedLayer).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const result = await sharp(rawResult)
    .ensureAlpha()
    .composite([{ input: renderedLayer, left: placement.x, top: placement.y, blend: 'over' }])
    .png()
    .toBuffer()
  const finalized = await sharp(result).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const finalOpaqueCoreDifference = pixelDifferenceAtPlacement(
    rendered.data,
    rendered.info.channels,
    finalized.data,
    finalized.info.width,
    finalized.info.channels,
    placement,
  )
  if (rawForegroundDifference.changedOpaquePixelCount > 0) warnings.push('provider_raw_redrew_foreground_pixels_reoverlay_required')
  if (semiTransparentBoundaryPixelCount > 0) warnings.push('semi_transparent_edge_uses_provider_raw_as_underlay_review_for_halo')
  if (color.appliedStrength > 0) warnings.push('ambient_color_transform_applied_within_delta_e_budget')
  if (Math.abs(placement.widthHeightRatioErrorPercent) > 0.1) rejectionReasons.push('canonical_width_height_ratio_changed')
  if (placement.y + placement.height !== placement.contactY) rejectionReasons.push('stored_placement_bottom_does_not_match_contact_row')
  if (finalOpaqueCoreDifference.changedOpaquePixelCount !== 0 || finalOpaqueCoreDifference.maxAbsoluteRgbDifference !== 0) {
    rejectionReasons.push('canonical_final_opaque_pixels_changed')
  }
  if (!registration.passed) rejectionReasons.push('provider_raw_foreground_boundary_shifted')
  rejectionReasons.push(...color.rejectionReasons)
  const overlay = await outpaintOverlay(result, placement, registration)
  const report: OutpaintQaReport = {
    expectedCanvas: placement.canvas,
    actualCanvas,
    exactCanvasSize,
    placement,
    placementBottomMatchesContact: placement.y + placement.height === placement.contactY,
    widthHeightRatioErrorPercent: placement.widthHeightRatioErrorPercent,
    silhouetteIouAgainstPlacedCanonical: 1,
    rawForegroundDifference,
    finalOpaqueCoreDifference,
    rawBoundaryRegistration: registration,
    color,
    semiTransparentBoundaryPixelCount,
    edgeStrategy: 'canonical_alpha_over_provider_raw',
    geometry: {
      transform: 'uniform_scale_and_translation',
      warpApplied: false,
      providerForegroundUsedAsFinal: false,
      canonicalLayerCompositedLast: true,
    },
    warnings,
    pass: rejectionReasons.length === 0,
    rejectionReasons,
  }
  return {
    result,
    overlay,
    report,
    acceptance: {
      accepted: report.pass,
      retryRecommended: !report.pass,
      reasons: [...rejectionReasons],
    },
  }
}
