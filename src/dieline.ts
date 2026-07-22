import sharp from 'sharp'

import { resizeRgbPillowLanczos } from './pillow-lanczos.js'

import {
  type CompiledImageEditInput,
  type ImageReferenceRole,
  type ReferenceRoleFields,
  validateReferences,
} from './reference-roles.js'

export interface DielineGeometryReference extends ReferenceRoleFields {
  kind: 'geometry'
}

export interface DielineImageSlot {
  /** Human-supplied description only; geometry authority is implied by this slot. */
  description: string
}

export interface DielineSupportReference extends ImageReferenceRole {
  kind: 'support'
}

export type DielineReference = DielineGeometryReference | DielineSupportReference

export interface DielineRequest {
  originalPrompt: string
  dielineImage: DielineImageSlot
  supportReferences?: DielineSupportReference[]
}

export interface DielinePreparationOptions {
  finalSize?: number
  outsideWhiteMin?: number
}

export interface DielinePreparationMetadata {
  sourceSize: [number, number]
  nativeSquareSize: number
  sourceOffsetInNativeSquare: [number, number]
  integerScale: number
  scaledSquareOffsetInFinalCanvas: number
  finalSize: number
  targetBbox: [number, number, number, number]
  targetRatio: number
  modelInputs: ['paddedDrawing']
  qaOnlyAssets: ['silhouetteMask']
}

export interface PreparedDieline {
  paddedDrawing: Buffer
  silhouetteMask: Buffer
  metadata: DielinePreparationMetadata
}

export interface CompileDielineInput {
  request: DielineRequest
  metadata: DielinePreparationMetadata
  paddedDrawingUrl: string
}

export interface DielineQaReport {
  pixelModification: 'none'
  threshold: number
  contractCanvasSize: [number, number]
  returnedCanvasSize: [number, number]
  returnedCanvasMatchesContract: boolean
  targetMaskResampledForQa: boolean
  contractTargetBbox: [number, number, number, number]
  contractTargetRatio: number
  qaTargetBbox: [number, number, number, number] | null
  rawBbox: [number, number, number, number] | null
  rawRatio: number | null
  rawRatioErrorPercent: number | null
  outsideDriftPixels: number
  insideCoverage: number | null
  silhouetteIou: number | null
}

export interface DielineQaOutput {
  /** Separate visual QA artifact. The caller must persist the provider raw independently. */
  overlay: Buffer
  report: DielineQaReport
}

export interface DielineAcceptanceCriteria {
  maxAbsoluteRatioErrorPercent?: number
  minimumSilhouetteIou?: number
}

export interface DielineQaAcceptance {
  accepted: boolean
  retryRecommended: boolean
  criteria: Required<DielineAcceptanceCriteria>
  reasons: string[]
}

export const DEFAULT_DIELINE_ACCEPTANCE: Required<DielineAcceptanceCriteria> = {
  maxAbsoluteRatioErrorPercent: 1,
  minimumSilhouetteIou: 0.99,
}

interface Bbox {
  left: number
  top: number
  right: number
  bottom: number
}

function requireInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`)
  return value
}

function bboxFromMask(mask: Uint8Array, width: number, height: number): Bbox | null {
  let left = width
  let top = height
  let right = -1
  let bottom = -1
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (mask[y * width + x] === 0) continue
      left = Math.min(left, x)
      top = Math.min(top, y)
      right = Math.max(right, x)
      bottom = Math.max(bottom, y)
    }
  }
  return right < 0 ? null : { left, top, right: right + 1, bottom: bottom + 1 }
}

function bboxTuple(bbox: Bbox | null): [number, number, number, number] | null {
  return bbox ? [bbox.left, bbox.top, bbox.right, bbox.bottom] : null
}

function bboxRatio(bbox: Bbox | null): number | null {
  if (!bbox) return null
  return (bbox.right - bbox.left) / (bbox.bottom - bbox.top)
}

function deriveClosedSilhouette(
  rgb: Uint8Array,
  width: number,
  height: number,
  channels: number,
  outsideWhiteMin: number,
): Uint8Array {
  const total = width * height
  const outside = new Uint8Array(total)
  const queue = new Int32Array(total)
  let read = 0
  let write = 0

  const isNearWhite = (index: number): boolean => {
    const offset = index * channels
    const distanceFromWhite = (255 - rgb[offset]) + (255 - rgb[offset + 1]) + (255 - rgb[offset + 2])
    return distanceFromWhite <= 255 - outsideWhiteMin
  }
  const enqueue = (index: number): void => {
    if (outside[index] || !isNearWhite(index)) return
    outside[index] = 1
    queue[write] = index
    write += 1
  }

  for (let x = 0; x < width; x += 1) {
    enqueue(x)
    enqueue((height - 1) * width + x)
  }
  for (let y = 0; y < height; y += 1) {
    enqueue(y * width)
    enqueue(y * width + width - 1)
  }
  while (read < write) {
    const index = queue[read]
    read += 1
    const x = index % width
    const y = Math.floor(index / width)
    if (x > 0) enqueue(index - 1)
    if (x + 1 < width) enqueue(index + 1)
    if (y > 0) enqueue(index - width)
    if (y + 1 < height) enqueue(index + width)
  }

  const mask = new Uint8Array(total)
  for (let index = 0; index < total; index += 1) mask[index] = outside[index] ? 0 : 255
  if (!bboxFromMask(mask, width, height)) throw new Error('could not derive a closed silhouette from the drawing')
  return mask
}

export async function prepareDieline(
  source: Buffer,
  options: DielinePreparationOptions = {},
): Promise<PreparedDieline> {
  const finalSize = requireInteger(options.finalSize ?? 2048, 'finalSize')
  const outsideWhiteMin = options.outsideWhiteMin ?? 215
  if (outsideWhiteMin < 0 || outsideWhiteMin > 255) throw new Error('outsideWhiteMin must be 0..255')

  const flattened = await sharp(source)
    .flatten({ background: '#ffffff' })
    .removeAlpha()
    .toColourspace('srgb')
    .png()
    .toBuffer({ resolveWithObject: true })
  const sourceWidth = requireInteger(flattened.info.width, 'source width')
  const sourceHeight = requireInteger(flattened.info.height, 'source height')
  const side = Math.max(sourceWidth, sourceHeight)
  if (side > finalSize) throw new Error(`source square ${side}px exceeds final canvas ${finalSize}px`)
  const sourceLeft = Math.floor((side - sourceWidth) / 2)
  const sourceTop = Math.floor((side - sourceHeight) / 2)
  const square = await sharp(flattened.data)
    .extend({
      left: sourceLeft,
      right: side - sourceWidth - sourceLeft,
      top: sourceTop,
      bottom: side - sourceHeight - sourceTop,
      background: '#ffffff',
    })
    .png()
    .toBuffer()
  const squareRaw = await sharp(square).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  const nativeMask = deriveClosedSilhouette(
    squareRaw.data,
    side,
    side,
    squareRaw.info.channels,
    outsideWhiteMin,
  )
  const nativeBbox = bboxFromMask(nativeMask, side, side)
  if (!nativeBbox) throw new Error('closed silhouette has no bbox')

  const integerScale = Math.floor(finalSize / side)
  if (integerScale < 1) throw new Error('drawing cannot fit final canvas without downscaling')
  const scaledSide = side * integerScale
  const canvasOffset = Math.floor((finalSize - scaledSide) / 2)
  const finalPadding = {
    left: canvasOffset,
    right: finalSize - scaledSide - canvasOffset,
    top: canvasOffset,
    bottom: finalSize - scaledSide - canvasOffset,
  }
  const squareRgb = await sharp(square).removeAlpha().raw().toBuffer()
  const scaledDrawingRgb = resizeRgbPillowLanczos(squareRgb, side, side, scaledSide, scaledSide)
  const paddedDrawing = await sharp(scaledDrawingRgb, {
    raw: { width: scaledSide, height: scaledSide, channels: 3 },
  })
    .extend({ ...finalPadding, background: '#ffffff' })
    .png()
    .toBuffer()
  const silhouetteMask = await sharp(nativeMask, { raw: { width: side, height: side, channels: 1 } })
    .resize(scaledSide, scaledSide, { kernel: sharp.kernel.nearest })
    .extend({ ...finalPadding, background: '#000000' })
    .png()
    .toBuffer()
  const targetBbox: [number, number, number, number] = [
    nativeBbox.left * integerScale + canvasOffset,
    nativeBbox.top * integerScale + canvasOffset,
    nativeBbox.right * integerScale + canvasOffset,
    nativeBbox.bottom * integerScale + canvasOffset,
  ]
  return {
    paddedDrawing,
    silhouetteMask,
    metadata: {
      sourceSize: [sourceWidth, sourceHeight],
      nativeSquareSize: side,
      sourceOffsetInNativeSquare: [sourceLeft, sourceTop],
      integerScale,
      scaledSquareOffsetInFinalCanvas: canvasOffset,
      finalSize,
      targetBbox,
      targetRatio: (targetBbox[2] - targetBbox[0]) / (targetBbox[3] - targetBbox[1]),
      modelInputs: ['paddedDrawing'],
      qaOnlyAssets: ['silhouetteMask'],
    },
  }
}

function validateDielineRequest(request: DielineRequest, paddedDrawingUrl: string): DielineReference[] {
  if (!request.originalPrompt.trim()) throw new Error('originalPrompt must not be empty')
  const description = request.dielineImage.description.trim()
  if (!description) throw new Error('dielineImage.description must not be empty')
  const supportReferences = request.supportReferences?.length
    ? validateReferences(request.supportReferences) as DielineSupportReference[]
    : []
  if (supportReferences.some((reference) => reference.kind !== 'support')) {
    throw new Error('dieline supportReferences must have kind=support')
  }
  return [{
    id: 'dieline-image',
    kind: 'geometry',
    url: paddedDrawingUrl,
    description,
    role: 'EDIT TARGET AND SOLE GEOMETRY AUTHORITY. Preserve its exterior boundary, every internal construction-line position, canvas position, and width-to-height ratio. It supplies geometry only; all semantic section meanings and appearance properties must come from the original user prompt.',
  }, ...supportReferences]
}

export function compileDielineEdit(input: CompileDielineInput): CompiledImageEditInput<DielineReference> {
  const references = validateDielineRequest(input.request, input.paddedDrawingUrl)
  const [left, top, right, bottom] = input.metadata.targetBbox
  const width = right - left
  const height = bottom - top
  // Dieline V3 used a compact, line-contiguous role block. Keep it byte-stable:
  // small wording/whitespace changes are observable model inputs.
  const roleBlock = references
    .map((reference, index) => [
      `IMAGE ${index + 1} — ${reference.description}`,
      `Role: ${reference.role}`,
    ].join('\n'))
    .join('\n')
  const prompt = `${input.request.originalPrompt.trim()}

REFERENCE IMAGE DESCRIPTIONS AND ROLES (same order as the inputs):
${roleBlock}

PIXEL GEOMETRY CONTRACT FOR THE ${input.metadata.finalSize} × ${input.metadata.finalSize} OUTPUT:
- The complete visible generated-subject bbox must be x=${left}..${right - 1}, y=${top}..${bottom - 1} (right/bottom exclusive bbox [${left}, ${top}, ${right}, ${bottom}]).
- Required visible generated-subject width=${width}px, height=${height}px, W/H=${input.metadata.targetRatio.toFixed(12)}.
- Its topmost and bottommost pixels must stay on those exact rows. All edge antialiasing, highlights, material effects, glow, reflections, and shadows that belong to the generated subject must end inside this bbox.


INPAINT / EDIT INSTRUCTION:
Use IMAGE 1 as the edit canvas and sole geometry authority. Replace only the appearance inside its closed exterior subject silhouette, while preserving the exact exterior boundary, every internal construction-line position, and the subject's canvas location. Do not move, resize, stretch, crop, expand, or redesign the subject. Render all requested sections together in one coherent edit; do not independently generate, composite, or reposition sections. An internal construction line has semantic meaning only when the ORIGINAL USER PROMPT explicitly maps that line to a section, part, or material boundary; when mapped, preserve that exact line as the boundary. Do not invent a mapping for any unmapped line. Determine all identity, section and part meanings, part relationships, material assignments, colors, text, branding, background, lighting, and shadow behavior exclusively from the ORIGINAL USER PROMPT and the declared reference roles. Keep pixels outside the subject silhouette unchanged except where the ORIGINAL USER PROMPT explicitly requests a background change. Supporting references may affect only the properties assigned in their roles. Do not copy an undeclared property from any reference.`
  return {
    prompt,
    imageInput: references.map((reference) => reference.url),
    references,
  }
}

async function rawRgb(buffer: Buffer, width?: number, height?: number, nearest = false) {
  let pipeline = sharp(buffer).flatten({ background: '#ffffff' }).removeAlpha().toColourspace('srgb')
  if (width && height) pipeline = pipeline.resize(width, height, { kernel: nearest ? sharp.kernel.nearest : sharp.kernel.lanczos3 })
  return pipeline.raw().toBuffer({ resolveWithObject: true })
}

async function rawMask(buffer: Buffer, width: number, height: number) {
  return sharp(buffer)
    .resize(width, height, { kernel: sharp.kernel.nearest })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true })
}

function nonWhiteMask(rgb: Uint8Array, width: number, height: number, channels: number, threshold: number): Uint8Array {
  const mask = new Uint8Array(width * height)
  for (let index = 0; index < mask.length; index += 1) {
    const offset = index * channels
    // Match Pillow RGB→L conversion used by the approved experiment's measure.py.
    const luma = (19595 * rgb[offset] + 38470 * rgb[offset + 1] + 7471 * rgb[offset + 2] + 32768) >> 16
    mask[index] = luma < threshold ? 255 : 0
  }
  return mask
}

export async function qaDielineResult(
  rawResult: Buffer,
  prepared: PreparedDieline,
  threshold = 245,
): Promise<DielineQaOutput> {
  if (threshold < 0 || threshold > 255) throw new Error('threshold must be 0..255')
  const raw = await rawRgb(rawResult)
  const width = raw.info.width
  const height = raw.info.height
  const drawing = await rawRgb(prepared.paddedDrawing, width, height)
  const target = await rawMask(prepared.silhouetteMask, width, height)
  const rawSubject = nonWhiteMask(raw.data, width, height, raw.info.channels, threshold)
  const targetSubject = new Uint8Array(width * height)
  for (let index = 0; index < targetSubject.length; index += 1) targetSubject[index] = target.data[index] > 0 ? 255 : 0

  const overlayRgba = Buffer.alloc(width * height * 4)
  let intersection = 0
  let union = 0
  let outside = 0
  let targetPixels = 0
  for (let index = 0; index < width * height; index += 1) {
    const sourceOffset = index * drawing.info.channels
    const outputOffset = index * 4
    const red = drawing.data[sourceOffset]
    const green = drawing.data[sourceOffset + 1]
    const blue = drawing.data[sourceOffset + 2]
    const darkest = Math.min(red, green, blue)
    overlayRgba[outputOffset] = red
    overlayRgba[outputOffset + 1] = green
    overlayRgba[outputOffset + 2] = blue
    overlayRgba[outputOffset + 3] = Math.max(0, Math.min(255, Math.round((255 - darkest) * 2)))

    const inRaw = rawSubject[index] > 0
    const inTarget = targetSubject[index] > 0
    if (inRaw && inTarget) intersection += 1
    if (inRaw || inTarget) union += 1
    if (inRaw && !inTarget) outside += 1
    if (inTarget) targetPixels += 1
  }
  const overlay = await sharp(rawResult)
    .composite([{ input: overlayRgba, raw: { width, height, channels: 4 }, blend: 'over' }])
    .png()
    .toBuffer()
  const targetBbox = bboxFromMask(targetSubject, width, height)
  const rawBbox = bboxFromMask(rawSubject, width, height)
  const rawRatio = bboxRatio(rawBbox)
  const report: DielineQaReport = {
    pixelModification: 'none',
    threshold,
    contractCanvasSize: [prepared.metadata.finalSize, prepared.metadata.finalSize],
    returnedCanvasSize: [width, height],
    returnedCanvasMatchesContract: width === prepared.metadata.finalSize && height === prepared.metadata.finalSize,
    targetMaskResampledForQa: width !== prepared.metadata.finalSize || height !== prepared.metadata.finalSize,
    contractTargetBbox: prepared.metadata.targetBbox,
    contractTargetRatio: prepared.metadata.targetRatio,
    qaTargetBbox: bboxTuple(targetBbox),
    rawBbox: bboxTuple(rawBbox),
    rawRatio,
    rawRatioErrorPercent: rawRatio === null ? null : (rawRatio / prepared.metadata.targetRatio - 1) * 100,
    outsideDriftPixels: outside,
    insideCoverage: targetPixels === 0 ? null : intersection / targetPixels,
    silhouetteIou: union === 0 ? null : intersection / union,
  }
  return { overlay, report }
}

export function evaluateDielineQa(
  report: DielineQaReport,
  criteria: DielineAcceptanceCriteria = {},
): DielineQaAcceptance {
  const resolved = {
    maxAbsoluteRatioErrorPercent: criteria.maxAbsoluteRatioErrorPercent
      ?? DEFAULT_DIELINE_ACCEPTANCE.maxAbsoluteRatioErrorPercent,
    minimumSilhouetteIou: criteria.minimumSilhouetteIou
      ?? DEFAULT_DIELINE_ACCEPTANCE.minimumSilhouetteIou,
  }
  if (resolved.maxAbsoluteRatioErrorPercent < 0) {
    throw new Error('maxAbsoluteRatioErrorPercent must be non-negative')
  }
  if (resolved.minimumSilhouetteIou < 0 || resolved.minimumSilhouetteIou > 1) {
    throw new Error('minimumSilhouetteIou must be 0..1')
  }
  const reasons: string[] = []
  if (!report.returnedCanvasMatchesContract) reasons.push('returned canvas does not match the geometry contract')
  if (report.rawRatioErrorPercent === null) {
    reasons.push('subject ratio could not be measured')
  } else if (Math.abs(report.rawRatioErrorPercent) > resolved.maxAbsoluteRatioErrorPercent) {
    reasons.push(`absolute W/H error ${Math.abs(report.rawRatioErrorPercent).toFixed(6)}% exceeds ${resolved.maxAbsoluteRatioErrorPercent}%`)
  }
  if (report.silhouetteIou === null) {
    reasons.push('silhouette IoU could not be measured')
  } else if (report.silhouetteIou < resolved.minimumSilhouetteIou) {
    reasons.push(`silhouette IoU ${report.silhouetteIou.toFixed(6)} is below ${resolved.minimumSilhouetteIou}`)
  }
  return {
    accepted: reasons.length === 0,
    retryRecommended: reasons.length > 0,
    criteria: resolved,
    reasons,
  }
}
