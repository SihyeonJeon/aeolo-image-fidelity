import sharp from 'sharp'

export interface CanonicalCutoutSlot {
  description: string
  role: string
}

export type CompositeSizeInput =
  | { mode: 'measured'; physicalHeightCm: number }
  | { mode: 'semantic'; fallbackHeightCm?: number }

export interface CompositeFramingProfile {
  name: string
  verticalSpanCmAtLandingPlane: number
  minHeightFraction: number
  maxHeightFraction: number
  surfaceDepthFraction: number
}

export type CompositeColorPolicy =
  | { mode: 'strict' }
  | {
      mode: 'ambient'
      /** Requested fraction of the bounded local white-balance/exposure transform. */
      strength?: number
      /** Hard ceiling for the mean intended color change from the canonical layer. */
      maxMeanDeltaE2000?: number
      /** Hard ceiling for the 95th-percentile intended color change. */
      maxP95DeltaE2000?: number
    }

export interface ResolvedCompositeColorPolicy {
  mode: 'strict' | 'ambient'
  strength: number
  maxMeanDeltaE2000: number
  maxP95DeltaE2000: number
}

export interface CompositeRequest {
  originalPrompt: string
  canonicalCutout: CanonicalCutoutSlot
  size: CompositeSizeInput
  framing?: Partial<CompositeFramingProfile>
  /** Strict is the default. Ambient changes RGB only within an explicit Delta-E budget. */
  color?: CompositeColorPolicy
}

export interface CutoutLightingAnalysis {
  direction: string
  directionVectorNormalized: { dx: number; dy: number }
  soft: boolean
  softnessScore: number
  whiteBalance: 'warm' | 'neutral' | 'cool'
  neutralSampleRgb: [number, number, number]
}

export interface BackgroundLightingAnalysis {
  sampleSize: { width: number; height: number }
  luma: { p10: number; median: number; p90: number; dynamicRange: number }
  whiteBalance: 'warm' | 'neutral' | 'cool'
  neutralSampleRgb: [number, number, number]
  direction: string
  directionVectorNormalized: { dx: number; dy: number }
  directionConfidence: number
  edgeHardnessScore: number
  hardEdgeFraction: number
  quality: 'soft' | 'defined' | 'mixed'
  qualitySource?: 'global_scene' | 'local_landing_zone'
  globalQuality?: 'soft' | 'defined' | 'mixed'
  globalEdgeHardnessScore?: number
  globalHardEdgeFraction?: number
}

export interface LightingCompatibility {
  passed: boolean
  rejectionReasons: string[]
  warnings: string[]
  foregroundQuality: 'soft' | 'defined'
  backgroundQuality: BackgroundLightingAnalysis['quality']
  shadowDirectionSource: 'background' | 'foreground_fallback'
}

export interface ProceduralShadowProfile {
  direction: string
  directionSource: LightingCompatibility['shadowDirectionSource']
  hardnessBlend: number
  castBlurSigmaFraction: number
  castOpacity: number
  contactBlurSigmaFraction: number
  contactOpacity: number
  occlusionCoreBlurSigmaFraction: number
  occlusionCoreOpacity: number
  colorRgb: [number, number, number]
}

export interface PixelDifferenceStats {
  pixelCount: number
  meanAbsoluteRgbDiff: number
  maxAbsoluteRgbDiff: number
  meanDeltaE2000: number
  p95DeltaE2000: number
  maxDeltaE2000: number
}

export interface LocalBackgroundColorSample {
  rgb: [number, number, number]
  pixelCount: number
  method: 'placement_local_neutral_pixels' | 'global_plate_neutral_fallback'
}

export interface LocalBackgroundColorSamplingOptions {
  /** Ignore pixels occupied by a pre-positioned canonical foreground. */
  excludePlacement?: boolean
  /** Relax only the neutral-like sampling gate; it does not change the output color budget. */
  maxNeutralChromaFraction?: number
}

export interface CompositeColorReport {
  policy: ResolvedCompositeColorPolicy
  localBackgroundSample: LocalBackgroundColorSample
  sourceNeutralRgb: [number, number, number]
  desiredLinearRgbGains: [number, number, number]
  appliedStrength: number
  /** Pixels whose ambient correction was reduced to protect text, edges, and antialiased boundaries. */
  detailProtectedPixelCount: number
  alphaChangedPixelCount: number
  intendedChangeFromCanonical: PixelDifferenceStats
  passed: boolean
  rejectionReasons: string[]
}

export interface CutoutViewAnalysis {
  projectionClass: 'frontal_low_perspective' | 'roughly_frontal' | 'angled_or_asymmetric'
  mirrorSilhouetteIou: number
  rollDegrees: number
  upperMiddleLowerWidthPx: [number, number, number]
  upperVsLowerWidthChange: number
  edgeParallelismError: number
  cameraElevationClass: string
  compatibleFovClass: string
  backgroundCameraContract: string
}

export interface CutoutAnalysis {
  canvas: { width: number; height: number }
  alphaBbox: [number, number, number, number]
  cutoutSize: { width: number; height: number }
  cutoutWidthHeightRatio: number
  lighting: CutoutLightingAnalysis
  view: CutoutViewAnalysis
}

export interface CompositeSizeResolution {
  heightCm: number
  source: 'explicit_user_or_catalog_dimension' | 'generic_form_factor_prior' | 'generic_default_fallback'
  confidence: 'declared' | 'medium' | 'low'
  sizeClass: string
  explanation: string
}

export interface SupportPlane {
  backY: number
  frontY: number
  contactY: number
  confidence: 'high' | 'medium' | 'low'
  method: string
  analysisWindow: { x0: number; x1: number; widthFraction: number }
  backScore: number
  frontScore: number
}

export interface CompositePlacement {
  x: number
  y: number
  width: number
  height: number
  sourceBbox: [number, number, number, number]
  scale: number
}

export interface CameraCompatibility {
  projectionClass: string
  productCenterYFraction: number
  opticalAxisOffsetFraction: number
  supportBandDepthFraction: number
  backAnchorTiltDegrees: number
  frontAnchorTiltDegrees: number
  passed: boolean
  rejectionReasons: string[]
}

export interface CompositeGeometryReport {
  transform: 'uniform_scale_and_translation'
  warpApplied: false
  incompatiblePlateAction: 'retry_empty_background_plate'
}

export interface CompositeQaReport {
  widthHeightRatioErrorPercent: number
  silhouetteIouAgainstPlacedCanonical: 1
  /** Unintended difference: final product core vs the exact layer intentionally rendered. */
  opaqueCore: PixelDifferenceStats
  /** Intended RGB-only correction vs the uniformly scaled canonical layer. */
  color: CompositeColorReport
  sizeResolution: CompositeSizeResolution
  projectedHeightFraction: number
  supportPlane: SupportPlane
  cameraCompatibility: CameraCompatibility
  backgroundLighting: BackgroundLightingAnalysis
  lightingCompatibility: LightingCompatibility
  shadowProfile: ProceduralShadowProfile
  geometry: CompositeGeometryReport
  placement: CompositePlacement
  placementBottomMatchesContact: boolean
  contactInsideLandingBand: boolean
  productDoesNotCrossFrontAnchor: boolean
  pass: boolean
  rejectionReasons: string[]
}

export interface CompositeQaAcceptance {
  accepted: boolean
  retryRecommended: boolean
  reasons: string[]
}

export interface CompositeOutput {
  result: Buffer
  overlay: Buffer
  report: CompositeQaReport
  acceptance: CompositeQaAcceptance
}

export const DEFAULT_COMPOSITE_FRAMING: CompositeFramingProfile = {
  name: 'contextual_still_life',
  verticalSpanCmAtLandingPlane: 40,
  minHeightFraction: 0.16,
  maxHeightFraction: 0.34,
  surfaceDepthFraction: 0.56,
}

const SIZE_RULES: Array<[RegExp, number, string]> = [
  [/\b(solid applicator|stick package|compact applicator)\b/i, 10, 'compact_handheld_stick'],
  [/\b(lipstick|lip balm|balm stick)\b/i, 9, 'small_handheld_stick'],
  [/\b(compact|palette)\b/i, 8, 'small_compact'],
  [/\bjar\b/i, 7, 'small_jar'],
  [/\b(dropper|serum bottle)\b/i, 11, 'small_bottle'],
  [/\btube\b/i, 14, 'handheld_tube'],
  [/\b(pump|spray bottle|bottle)\b/i, 18, 'medium_bottle'],
  [/\b(can|aerosol)\b/i, 15, 'medium_can'],
  [/\b(carton|box)\b/i, 20, 'medium_carton'],
  [/\b(phone|smartphone)\b/i, 15, 'handheld_device'],
  [/\b(mug|cup)\b/i, 10, 'tabletop_vessel'],
  [/\b(shoe|sneaker)\b/i, 12, 'footwear_height'],
  [/\b(backpack|rucksack)\b/i, 42, 'large_bag'],
]

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.max(0, Math.min(sorted.length - 1, Math.round((sorted.length - 1) * fraction)))
  return sorted[index]
}

function median(values: number[]): number {
  return percentile(values, 0.5)
}

function regressionSlope(xs: number[], ys: number[]): number {
  if (xs.length !== ys.length || xs.length < 2) return 0
  const meanX = xs.reduce((sum, value) => sum + value, 0) / xs.length
  const meanY = ys.reduce((sum, value) => sum + value, 0) / ys.length
  let numerator = 0
  let denominator = 0
  for (let index = 0; index < xs.length; index += 1) {
    numerator += (xs[index] - meanX) * (ys[index] - meanY)
    denominator += (xs[index] - meanX) ** 2
  }
  return denominator === 0 ? 0 : numerator / denominator
}

function direction(dx: number, dy: number, deadZone = 0.035): string {
  const horizontal = dx < -deadZone ? 'left' : dx > deadZone ? 'right' : ''
  const vertical = dy < -deadZone ? 'upper' : dy > deadZone ? 'lower' : ''
  return vertical && horizontal ? `${vertical}_${horizontal}` : vertical || horizontal || 'front_diffuse'
}

function directionWords(value: string): string {
  const words: Record<string, string> = {
    upper_left: 'upper left',
    upper_right: 'upper right',
    lower_left: 'lower left',
    lower_right: 'lower right',
    upper: 'above the camera',
    lower: 'below the camera',
    left: 'camera left',
    right: 'camera right',
    front_diffuse: 'the frontal camera axis',
  }
  return words[value] ?? value.replaceAll('_', ' ')
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value))
}

export function resolveCompositeColorPolicy(input: CompositeColorPolicy = { mode: 'strict' }): ResolvedCompositeColorPolicy {
  if (input.mode === 'strict') {
    return { mode: 'strict', strength: 0, maxMeanDeltaE2000: 0, maxP95DeltaE2000: 0 }
  }
  // Ambient mode is opt-in, so its default should be visibly useful while the
  // Delta-E gate below remains the final safety limit. Strict mode stays the
  // zero-change default for brand-critical output.
  const strength = input.strength ?? 1
  const maxMeanDeltaE2000 = input.maxMeanDeltaE2000 ?? 2
  const maxP95DeltaE2000 = input.maxP95DeltaE2000 ?? 3.5
  if (!Number.isFinite(strength) || strength < 0 || strength > 1) throw new Error('ambient color strength must be between 0 and 1')
  if (!Number.isFinite(maxMeanDeltaE2000) || maxMeanDeltaE2000 <= 0) throw new Error('ambient maxMeanDeltaE2000 must be positive')
  if (!Number.isFinite(maxP95DeltaE2000) || maxP95DeltaE2000 <= 0) throw new Error('ambient maxP95DeltaE2000 must be positive')
  return { mode: 'ambient', strength, maxMeanDeltaE2000, maxP95DeltaE2000 }
}

export async function analyzeBackgroundLighting(
  background: Buffer,
  region?: { left: number; top: number; width: number; height: number },
): Promise<BackgroundLightingAnalysis> {
  const sampleWidth = 160
  const sampleHeight = 90
  let pipeline = sharp(background).removeAlpha().toColourspace('srgb')
  if (region) pipeline = pipeline.extract(region)
  const raw = await pipeline
    .resize(sampleWidth, sampleHeight, { fit: 'fill', kernel: sharp.kernel.lanczos3 })
    .raw()
    .toBuffer({ resolveWithObject: true })
  const channels = raw.info.channels
  const x0 = Math.round(sampleWidth * (region ? 0.04 : 0.12))
  const x1 = Math.round(sampleWidth * (region ? 0.96 : 0.88))
  const y0 = Math.round(sampleHeight * (region ? 0.04 : 0.30))
  const y1 = Math.round(sampleHeight * (region ? 0.96 : 0.92))
  const luma = new Float64Array(sampleWidth * sampleHeight)
  const sampleLuma: number[] = []
  const neutralRed: number[] = []
  const neutralGreen: number[] = []
  const neutralBlue: number[] = []
  for (let y = 0; y < sampleHeight; y += 1) {
    for (let x = 0; x < sampleWidth; x += 1) {
      const offset = (y * sampleWidth + x) * channels
      const red = raw.data[offset]
      const green = raw.data[offset + 1]
      const blue = raw.data[offset + 2]
      const value = 0.2126 * red + 0.7152 * green + 0.0722 * blue
      luma[y * sampleWidth + x] = value
      if (x < x0 || x >= x1 || y < y0 || y >= y1) continue
      sampleLuma.push(value)
      if (Math.max(red, green, blue) - Math.min(red, green, blue) <= 18 && value >= 35 && value <= 245) {
        neutralRed.push(red)
        neutralGreen.push(green)
        neutralBlue.push(blue)
      }
    }
  }
  const p10 = percentile(sampleLuma, 0.10)
  const p50 = percentile(sampleLuma, 0.50)
  const p90 = percentile(sampleLuma, 0.90)
  const dynamicRange = p90 - p10
  const gradients: number[] = []
  for (let y = y0 + 1; y < y1 - 1; y += 1) {
    for (let x = x0 + 1; x < x1 - 1; x += 1) {
      const horizontal = (luma[y * sampleWidth + x + 1] - luma[y * sampleWidth + x - 1]) / 2
      const vertical = (luma[(y + 1) * sampleWidth + x] - luma[(y - 1) * sampleWidth + x]) / 2
      gradients.push(Math.hypot(horizontal, vertical))
    }
  }
  const edgeHardnessScore = percentile(gradients, 0.90) / Math.max(dynamicRange, 1)
  const hardEdgeThreshold = Math.max(10, dynamicRange * 0.16)
  const hardEdgeFraction = gradients.filter((value) => value >= hardEdgeThreshold).length / Math.max(gradients.length, 1)
  const quality: BackgroundLightingAnalysis['quality'] = edgeHardnessScore >= 0.23 && hardEdgeFraction >= 0.14
    ? 'defined'
    : edgeHardnessScore <= 0.12 && hardEdgeFraction <= 0.08 ? 'soft' : 'mixed'

  let weightedX = 0
  let weightedY = 0
  let totalWeight = 0
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const weight = Math.max(0, luma[y * sampleWidth + x] - p50)
      weightedX += x * weight
      weightedY += y * weight
      totalWeight += weight
    }
  }
  const centerX = (x0 + x1 - 1) / 2
  const centerY = (y0 + y1 - 1) / 2
  const dx = ((totalWeight ? weightedX / totalWeight : centerX) - centerX) / (x1 - x0)
  const dy = ((totalWeight ? weightedY / totalWeight : centerY) - centerY) / (y1 - y0)
  const directionConfidence = clamp(Math.hypot(dx, dy) * 4, 0, 1)

  const neutralRgb: [number, number, number] = neutralRed.length >= 16
    ? [median(neutralRed), median(neutralGreen), median(neutralBlue)]
    : [median(sampleLuma), median(sampleLuma), median(sampleLuma)]
  const redBlueRatio = (neutralRgb[0] + 1) / (neutralRgb[2] + 1)
  return {
    sampleSize: { width: sampleWidth, height: sampleHeight },
    luma: { p10, median: p50, p90, dynamicRange },
    whiteBalance: redBlueRatio > 1.12 ? 'warm' : redBlueRatio < 0.89 ? 'cool' : 'neutral',
    neutralSampleRgb: neutralRgb,
    direction: direction(dx, dy, 0.025),
    directionVectorNormalized: { dx, dy },
    directionConfidence,
    edgeHardnessScore,
    hardEdgeFraction,
    quality,
    qualitySource: region ? 'local_landing_zone' : 'global_scene',
  }
}

export function evaluateLightingCompatibility(
  foreground: CutoutLightingAnalysis,
  background: BackgroundLightingAnalysis,
): LightingCompatibility {
  const rejectionReasons: string[] = []
  const warnings: string[] = []
  if (background.luma.median < 42) rejectionReasons.push('background_exposure_too_dark_for_product_plate')
  if (background.luma.median > 250) rejectionReasons.push('background_exposure_is_clipped')
  if (background.luma.dynamicRange < 18) warnings.push('background_lighting_is_very_flat')
  if (foreground.whiteBalance !== background.whiteBalance) warnings.push('background_white_balance_differs_from_product')
  if (foreground.soft && background.quality === 'defined') rejectionReasons.push('background_light_is_harder_than_product_light')
  if (foreground.soft && background.quality !== 'defined' && background.globalQuality === 'defined') {
    warnings.push('global_scene_contains_hard_edges_outside_landing_zone')
  }
  if (!foreground.soft && background.quality === 'soft') warnings.push('background_light_is_softer_than_product_light')
  const directionsAgree = foreground.direction !== 'front_diffuse' && foreground.direction === background.direction
  const directionSource = background.directionConfidence >= 0.24 && directionsAgree ? 'background' : 'foreground_fallback'
  if (background.directionConfidence >= 0.24 && foreground.direction !== 'front_diffuse'
    && background.direction !== 'front_diffuse' && !directionsAgree) warnings.push('background_brightness_direction_differs_from_product_highlight')
  return {
    passed: rejectionReasons.length === 0,
    rejectionReasons,
    warnings,
    foregroundQuality: foreground.soft ? 'soft' : 'defined',
    backgroundQuality: background.quality,
    shadowDirectionSource: directionSource,
  }
}

export function resolveProceduralShadowProfile(
  foreground: CutoutLightingAnalysis,
  background: BackgroundLightingAnalysis,
  compatibility: LightingCompatibility,
  ambientRgb: [number, number, number] = background.neutralSampleRgb,
): ProceduralShadowProfile {
  const contrast = clamp(background.luma.dynamicRange / 180, 0, 1)
  const scoreBlend = clamp((background.edgeHardnessScore - 0.08) / 0.22, 0, 1)
  const fractionBlend = clamp((background.hardEdgeFraction - 0.04) / 0.18, 0, 1)
  const hardnessBlend = clamp(scoreBlend * 0.65 + fractionBlend * 0.35, 0, 1)
  const directionValue = compatibility.shadowDirectionSource === 'background' ? background.direction : foreground.direction
  return {
    direction: directionValue,
    directionSource: compatibility.shadowDirectionSource,
    hardnessBlend,
    castBlurSigmaFraction: 0.038 - hardnessBlend * 0.020,
    castOpacity: 0.27 + hardnessBlend * 0.09 + contrast * 0.08,
    contactBlurSigmaFraction: 0.010 - hardnessBlend * 0.004,
    contactOpacity: 0.42 + hardnessBlend * 0.12 + contrast * 0.07,
    occlusionCoreBlurSigmaFraction: 0.0035,
    occlusionCoreOpacity: 0.58 + hardnessBlend * 0.08 + contrast * 0.05,
    colorRgb: ambientRgb.map((value) => Math.round(clamp(value * 0.22, 0, 64))) as [number, number, number],
  }
}

export async function analyzeCanonicalCutout(source: Buffer, description = ''): Promise<CutoutAnalysis> {
  const decoded = await sharp(source).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const { width, height, channels } = decoded.info
  let left = width
  let top = height
  let right = -1
  let bottom = -1
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (decoded.data[(y * width + x) * channels + 3] === 0) continue
      left = Math.min(left, x)
      top = Math.min(top, y)
      right = Math.max(right, x)
      bottom = Math.max(bottom, y)
    }
  }
  if (right < 0) throw new Error('canonical cutout alpha has no visible pixels')
  right += 1
  bottom += 1
  const cropWidth = right - left
  const cropHeight = bottom - top
  const mask = new Uint8Array(cropWidth * cropHeight)
  const alphaValues = new Uint8Array(cropWidth * cropHeight)
  const luma = new Float64Array(cropWidth * cropHeight)
  let mirrorIntersection = 0
  let mirrorUnion = 0
  const coreIndices: number[] = []
  const coloredDirectionIndices: number[] = []
  const coloredSurfaceIndices: number[] = []
  const neutralIndices: number[] = []
  for (let y = 0; y < cropHeight; y += 1) {
    for (let x = 0; x < cropWidth; x += 1) {
      const cropIndex = y * cropWidth + x
      const sourceOffset = ((top + y) * width + left + x) * channels
      const red = decoded.data[sourceOffset]
      const green = decoded.data[sourceOffset + 1]
      const blue = decoded.data[sourceOffset + 2]
      const alpha = decoded.data[sourceOffset + 3]
      alphaValues[cropIndex] = alpha
      mask[cropIndex] = alpha >= 21 ? 1 : 0
      luma[cropIndex] = 0.2126 * red + 0.7152 * green + 0.0722 * blue
      if (alpha >= 250) {
        coreIndices.push(cropIndex)
        const max = Math.max(red, green, blue)
        const min = Math.min(red, green, blue)
        const chroma = max - min
        if (chroma >= 20) coloredDirectionIndices.push(cropIndex)
        if (chroma / Math.max(max, 1) >= 0.25) coloredSurfaceIndices.push(cropIndex)
        if (chroma <= 22 && luma[cropIndex] >= 35 && luma[cropIndex] <= 245) neutralIndices.push(cropIndex)
      }
    }
  }
  for (let y = 0; y < cropHeight; y += 1) {
    for (let x = 0; x < cropWidth; x += 1) {
      const a = mask[y * cropWidth + x] > 0
      const b = mask[y * cropWidth + cropWidth - 1 - x] > 0
      if (a && b) mirrorIntersection += 1
      if (a || b) mirrorUnion += 1
    }
  }

  const rowYs: number[] = []
  const rowLefts: number[] = []
  const rowRights: number[] = []
  const rowWidths: number[] = []
  const minimumRowWidth = Math.max(4, Math.round(cropWidth * 0.08))
  for (let y = 0; y < cropHeight; y += 1) {
    let rowLeft = cropWidth
    let rowRight = -1
    let count = 0
    for (let x = 0; x < cropWidth; x += 1) {
      if (!mask[y * cropWidth + x]) continue
      rowLeft = Math.min(rowLeft, x)
      rowRight = Math.max(rowRight, x)
      count += 1
    }
    if (count < minimumRowWidth) continue
    rowYs.push(y)
    rowLefts.push(rowLeft)
    rowRights.push(rowRight)
    rowWidths.push(rowRight - rowLeft + 1)
  }
  const stable = rowYs.map((y) => y >= cropHeight * 0.15 && y <= cropHeight * 0.85)
  const selected = stable.filter(Boolean).length >= 8 ? stable : stable.map(() => true)
  const stableYs = rowYs.filter((_, index) => selected[index])
  const stableCenters = rowLefts.map((value, index) => (value + rowRights[index]) / 2).filter((_, index) => selected[index])
  const stableLefts = rowLefts.filter((_, index) => selected[index])
  const stableRights = rowRights.filter((_, index) => selected[index])
  const centerSlope = regressionSlope(stableYs, stableCenters)
  const leftSlope = regressionSlope(stableYs, stableLefts)
  const rightSlope = regressionSlope(stableYs, stableRights)
  const rollDegrees = Math.atan(centerSlope) * 180 / Math.PI
  const bandWidth = (low: number, high: number): number => {
    const values = rowWidths.filter((_, index) => rowYs[index] >= cropHeight * low && rowYs[index] <= cropHeight * high)
    return median(values.length ? values : rowWidths)
  }
  const upperWidth = bandWidth(0.15, 0.30)
  const middleWidth = bandWidth(0.42, 0.58)
  const lowerWidth = bandWidth(0.70, 0.85)
  const widthConvergence = (upperWidth - lowerWidth) / Math.max(middleWidth, 1)
  const edgeParallelismError = Math.abs(rightSlope - leftSlope) * cropHeight / Math.max(middleWidth, 1)
  const mirrorIou = mirrorUnion === 0 ? 0 : mirrorIntersection / mirrorUnion
  const frontal = mirrorIou >= 0.96 && Math.abs(rollDegrees) <= 1 && Math.abs(widthConvergence) <= 0.04 && edgeParallelismError <= 0.05
  const roughlyFrontal = mirrorIou >= 0.88 && Math.abs(rollDegrees) <= 3 && Math.abs(widthConvergence) <= 0.10
  const projectionClass = frontal ? 'frontal_low_perspective' : roughlyFrontal ? 'roughly_frontal' : 'angled_or_asymmetric'

  const material = coloredDirectionIndices.length >= Math.max(128, coreIndices.length * 0.3) ? coloredDirectionIndices : coreIndices
  const surfaceMaterial = coloredSurfaceIndices.length >= Math.max(128, coreIndices.length * 0.3) ? coloredSurfaceIndices : material
  const materialSet = new Set(material)
  const blurRadius = Math.max(5, Math.min(cropWidth, cropHeight) * 0.045)
  const numeratorInput = Buffer.alloc(cropWidth * cropHeight)
  const denominatorInput = Buffer.alloc(cropWidth * cropHeight)
  for (const index of material) {
    numeratorInput[index] = Math.max(0, Math.min(255, Math.trunc(luma[index])))
    denominatorInput[index] = 255
  }
  const [numerator, denominator] = await Promise.all([
    sharp(numeratorInput, { raw: { width: cropWidth, height: cropHeight, channels: 1 } }).blur(blurRadius).extractChannel(0).raw().toBuffer(),
    sharp(denominatorInput, { raw: { width: cropWidth, height: cropHeight, channels: 1 } }).blur(blurRadius).extractChannel(0).raw().toBuffer(),
  ])
  const smoothedLuma = new Float64Array(cropWidth * cropHeight)
  const materialLuma: number[] = []
  for (let index = 0; index < smoothedLuma.length; index += 1) {
    const density = denominator[index] / 255
    smoothedLuma[index] = numerator[index] / Math.max(density, 1e-3)
    if (materialSet.has(index) && density > 0.25) materialLuma.push(smoothedLuma[index])
  }
  if (materialLuma.length < 32) materialLuma.splice(0, materialLuma.length, ...coreIndices.map((index) => luma[index]))
  const low = percentile(materialLuma, 0.35)
  const high = percentile(materialLuma, 0.95)
  let geomX = 0
  let geomY = 0
  let geomWeight = 0
  let lightX = 0
  let lightY = 0
  let lightWeight = 0
  const gradients: number[] = []
  for (let y = 0; y < cropHeight; y += 1) {
    for (let x = 0; x < cropWidth; x += 1) {
      const index = y * cropWidth + x
      if (alphaValues[index] > 0) {
        const weight = alphaValues[index] / 255
        geomX += x * weight
        geomY += y * weight
        geomWeight += weight
      }
    }
  }
  for (const index of material) {
    const x = index % cropWidth
    const y = Math.floor(index / cropWidth)
    const weight = Math.max(0, Math.min(1, (smoothedLuma[index] - low) / Math.max(high - low, 1)))
    lightX += x * weight
    lightY += y * weight
    lightWeight += weight
  }
  for (const index of surfaceMaterial) {
    if (denominator[index] / 255 <= 0.25) continue
    const x = index % cropWidth
    const y = Math.floor(index / cropWidth)
    const leftIndex = y * cropWidth + Math.max(0, x - 1)
    const rightIndex = y * cropWidth + Math.min(cropWidth - 1, x + 1)
    const upperIndex = Math.max(0, y - 1) * cropWidth + x
    const lowerIndex = Math.min(cropHeight - 1, y + 1) * cropWidth + x
    const gradX = (luma[rightIndex] - luma[leftIndex]) / (x > 0 && x < cropWidth - 1 ? 2 : 1)
    const gradY = (luma[lowerIndex] - luma[upperIndex]) / (y > 0 && y < cropHeight - 1 ? 2 : 1)
    gradients.push(Math.hypot(gradX, gradY))
  }
  const normalizedDx = ((lightWeight ? lightX / lightWeight : geomX / geomWeight) - geomX / geomWeight) / cropWidth
  const normalizedDy = ((lightWeight ? lightY / lightWeight : geomY / geomWeight) - geomY / geomWeight) / cropHeight
  const dynamic = percentile(materialLuma, 0.95) - percentile(materialLuma, 0.10)
  const softnessScore = percentile(gradients, 0.90) / Math.max(dynamic, 1)

  const neutral = neutralIndices.length >= 32 ? neutralIndices : coreIndices
  const neutralRed: number[] = []
  const neutralGreen: number[] = []
  const neutralBlue: number[] = []
  for (const index of neutral) {
    const x = index % cropWidth
    const y = Math.floor(index / cropWidth)
    const offset = ((top + y) * width + left + x) * channels
    neutralRed.push(decoded.data[offset])
    neutralGreen.push(decoded.data[offset + 1])
    neutralBlue.push(decoded.data[offset + 2])
  }
  const neutralRgb: [number, number, number] = [median(neutralRed), median(neutralGreen), median(neutralBlue)]
  const redBlueRatio = (neutralRgb[0] + 1) / (neutralRgb[2] + 1)
  const words = description.toLowerCase()
  const cameraElevationClass = /front[- ]?view|front-facing|정면/.test(words) && frontal
    ? 'near_level_frontal'
    : frontal ? 'near_level_candidate' : 'indeterminate'
  const cameraContract = frontal
    ? "straight-on camera near the future object's mid-height; optical axis approximately horizontal; very shallow downward pitch; normal-to-long or orthographic-like perspective with weak convergence; show only a shallow support ledge around the landing point, not an expansive top-down tabletop; keep the landing edge and other dominant horizontal cues level; no wide-angle distortion"
    : roughlyFrontal
      ? 'mostly level camera with mild perspective only; keep the support plane shallow and horizontal; avoid wide-angle foreground expansion and steep top-down views'
      : 'camera pose cannot be resolved confidently from silhouette alone; require explicit camera/view metadata or manual plate selection'
  return {
    canvas: { width, height },
    alphaBbox: [left, top, right, bottom],
    cutoutSize: { width: cropWidth, height: cropHeight },
    cutoutWidthHeightRatio: cropWidth / cropHeight,
    lighting: {
      direction: direction(normalizedDx, normalizedDy),
      directionVectorNormalized: { dx: normalizedDx, dy: normalizedDy },
      soft: softnessScore < 0.25,
      softnessScore,
      whiteBalance: redBlueRatio > 1.12 ? 'warm' : redBlueRatio < 0.89 ? 'cool' : 'neutral',
      neutralSampleRgb: neutralRgb,
    },
    view: {
      projectionClass,
      mirrorSilhouetteIou: mirrorIou,
      rollDegrees,
      upperMiddleLowerWidthPx: [upperWidth, middleWidth, lowerWidth],
      upperVsLowerWidthChange: widthConvergence,
      edgeParallelismError,
      cameraElevationClass,
      compatibleFovClass: frontal ? 'normal_to_long_or_orthographic_like' : roughlyFrontal ? 'normal' : 'requires_explicit_view_metadata',
      backgroundCameraContract: cameraContract,
    },
  }
}

export function resolveCompositeSize(input: CompositeSizeInput, description: string): CompositeSizeResolution {
  if (input.mode === 'measured') {
    if (!Number.isFinite(input.physicalHeightCm) || input.physicalHeightCm <= 0) {
      throw new Error('measured composite size requires a positive physicalHeightCm')
    }
    return {
      heightCm: input.physicalHeightCm,
      source: 'explicit_user_or_catalog_dimension',
      confidence: 'declared',
      sizeClass: 'measured',
      explanation: 'Caller-supplied physical package height.',
    }
  }
  for (const [pattern, heightCm, sizeClass] of SIZE_RULES) {
    if (!pattern.test(description)) continue
    return {
      heightCm,
      source: 'generic_form_factor_prior',
      confidence: 'medium',
      sizeClass,
      explanation: 'Estimated from generic form-factor language in the supplied description; not a brand measurement.',
    }
  }
  return {
    heightCm: input.fallbackHeightCm ?? 10,
    source: 'generic_default_fallback',
    confidence: 'low',
    sizeClass: 'unknown',
    explanation: 'No recognized form factor; used the configured fallback.',
  }
}

export function resolveCompositeFraming(input: Partial<CompositeFramingProfile> = {}): CompositeFramingProfile {
  const resolved = { ...DEFAULT_COMPOSITE_FRAMING, ...input }
  if (resolved.verticalSpanCmAtLandingPlane <= 0) throw new Error('verticalSpanCmAtLandingPlane must be positive')
  if (resolved.minHeightFraction <= 0 || resolved.maxHeightFraction > 1 || resolved.minHeightFraction > resolved.maxHeightFraction) {
    throw new Error('invalid composite height-fraction bounds')
  }
  if (resolved.surfaceDepthFraction <= 0 || resolved.surfaceDepthFraction >= 1) {
    throw new Error('surfaceDepthFraction must be between 0 and 1')
  }
  return resolved
}

export function projectedHeightFraction(size: CompositeSizeResolution, framing: CompositeFramingProfile): number {
  return Math.max(framing.minHeightFraction, Math.min(framing.maxHeightFraction, size.heightCm / framing.verticalSpanCmAtLandingPlane))
}

export function compileEmptyPlatePrompt(
  request: CompositeRequest,
  analysis: CutoutAnalysis,
  size: CompositeSizeResolution,
  framing: CompositeFramingProfile,
): string {
  const projected = projectedHeightFraction(size, framing)
  const percent = Math.round(projected * 100)
  const contact = Math.max(0.60, Math.min(0.76, 0.5 + projected / 2))
  const rear = Math.max(0.48, Math.min(0.69, contact - 0.07))
  const front = Math.max(0.68, Math.min(0.84, contact + 0.07))
  const scaleContract = request.size.mode === 'measured'
    ? `The future canonical foreground is declared to be ${size.heightCm.toFixed(1)} cm tall. At its landing depth it should read at approximately ${percent}% of frame height under the ${framing.name} framing profile. Calibrate nearby props and the surface perspective to that real-world scale.`
    : `No numeric product dimension is available. Infer natural real-world scale only from the supplied product description: ${request.canonicalCutout.description} It must read as a supporting object at a realistic scale relative to nearby props, not an oversized hero object.`
  return `The following is the customer's exact original creative brief. Use it for topic, mood, palette, and editorial intent.
--- ORIGINAL USER PROMPT ---
${request.originalPrompt.trim()}
--- END ORIGINAL USER PROMPT ---

The following reference metadata describes the foreground that will be composited locally after generation.
DESCRIPTION: ${request.canonicalCutout.description.trim()}
ROLE: ${request.canonicalCutout.role.trim()}

Create only an EMPTY photorealistic 16:9 background plate. Automatically choose a scene that satisfies the customer brief. Include two or three scene-appropriate, recognizable context props near the outer thirds so relative scale can be judged, while keeping the central landing area empty and unobstructed.
SCALE CONTRACT: ${scaleContract}
SUPPORT-PLANE CONTRACT: Provide one broad, flat, physically usable support surface in the lower half. Rear-side and front-side horizontal cues on that plane should be visually readable across the empty central landing zone. The future object must land around the middle depth of that top surface, on the same plane and at the same scale as nearby props. Do not put the landing point below the front rim.
LIGHTING CONTRACT: ${analysis.lighting.soft ? 'soft diffused' : 'defined directional'} key light from the ${directionWords(analysis.lighting.direction)}, ${analysis.lighting.whiteBalance} white balance, bright natural exposure, gentle contrast, realistic surface falloff.
SHADOW COMPATIBILITY CONTRACT: ${analysis.lighting.soft
    ? 'Use a large diffused source or open shade. All props and support surfaces must have broad, soft-edged shadows; no hard-edged cast shadows, direct-sun patches, or sharp high-contrast shadow boundaries.'
    : 'Use one coherent directional key. Props and support surfaces must show readable cast shadows with one consistent direction and defined but natural edges.'}
CAMERA COMPATIBILITY CONTRACT: ${analysis.view.backgroundCameraContract}.
FOCUS CONTRACT — HARD ACCEPTANCE REQUIREMENT: Render a focus-stacked background plate with effectively infinite depth of field. Resolve every visible distance plane with equal optical sharpness: the complete support surface, empty central landing zone, scale-reference props, architecture, and distant scenery. Fine texture and individual edges in the far background must remain readable instead of dissolving into soft shapes. Use the visual grammar of focus-stacked commercial catalogue or architectural photography, not cinematic portrait photography. No bokeh, no circles of confusion, no shallow depth of field, no selective focus, no foreground or background defocus, no lens blur, no dreamy blur, and no tilt-shift effect. Do not simulate a wide physical aperture. Do not rely on post-generation sharpening or deblurring.
DEPTH-SAFE STAGING CONTRACT: Keep visible scene content within a narrow focus-distance range. Prefer one context-appropriate seamless opaque wall, continuous fabric plane, or studio backdrop directly behind the support surface. Across the central 60% of the frame, that backdrop must have no horizontal seams, rails, molding, ledges, shelves, panel boundaries, or false tabletop-like lines. Express the broader location through materials, lighting, and the outer-third props. Do not compose a distant vista, receding corridor, layered foliage field, or faraway practical lights behind the landing zone. If the original brief absolutely requires a distant element, render it with the same focus-stacked edge clarity as the support plane.
OPTICAL-AXIS / SURFACE GEOMETRY CONTRACT: The future foreground is ${percent}% of frame height. Put its physical contact row at approximately ${Math.round(contact * 100)}% of frame height. Keep the support surface's distinct rear junction around ${Math.round(rear * 100)}% and its front rim around ${Math.round(front * 100)}% of frame height. The visible top surface must remain a shallow band between those cues, not a broad tabletop.
No product, no bottle, no stick, no tube, no package, no cosmetic, no proxy object, no placeholder, no person, no hands, no typography, no logo, no watermark, no frame, and no pre-rendered product shadow.`
}

function rowMedianRgb(data: Uint8Array, width: number, channels: number, y: number, x0: number, x1: number): [number, number, number] {
  const histograms = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)]
  for (let x = x0; x < x1; x += 1) {
    const offset = (y * width + x) * channels
    histograms[0][data[offset]] += 1
    histograms[1][data[offset + 1]] += 1
    histograms[2][data[offset + 2]] += 1
  }
  const target = Math.floor((x1 - x0 - 1) / 2)
  return histograms.map((histogram) => {
    let total = 0
    for (let value = 0; value < 256; value += 1) {
      total += histogram[value]
      if (total > target) return value
    }
    return 255
  }) as [number, number, number]
}

function smooth(values: number[], radius: number): number[] {
  const weights: number[] = []
  for (let value = 1; value <= radius; value += 1) weights.push(value)
  for (let value = radius - 1; value >= 1; value -= 1) weights.push(value)
  const total = weights.reduce((sum, value) => sum + value, 0)
  return values.map((_, index) => {
    let result = 0
    for (let offset = 0; offset < weights.length; offset += 1) {
      const source = index + offset - radius + 1
      if (source >= 0 && source < values.length) result += values[source] * weights[offset]
    }
    return result / total
  })
}

async function detectSupportPlane(background: Buffer, framing: CompositeFramingProfile): Promise<SupportPlane> {
  const raw = await sharp(background).removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true })
  const { width, height, channels } = raw.info
  type Candidate = SupportPlane & { rank: number }
  const center = 0.52
  const widths = [0.48, 0.34, 0.24, 0.16]
  const candidates: Candidate[] = widths.map((widthFraction) => {
    const x0 = Math.max(0, Math.round(width * (center - widthFraction / 2)))
    const x1 = Math.min(width, Math.round(width * (center + widthFraction / 2)))
    const rows = Array.from({ length: height }, (_, y) => rowMedianRgb(raw.data, width, channels, y, x0, x1))
    const deltas = rows.map((row, y) => y === 0 ? 0 : Math.hypot(row[0] - rows[y - 1][0], row[1] - rows[y - 1][1], row[2] - rows[y - 1][2]))
    const scores = smooth(deltas, Math.max(3, Math.round(height * 0.006)))
    const sample = scores.slice(Math.round(height * 0.44), Math.round(height * 0.92))
    const mean = sample.reduce((sum, value) => sum + value, 0) / sample.length
    const spread = Math.sqrt(sample.reduce((sum, value) => sum + (value - mean) ** 2, 0) / sample.length)
    const threshold = median(sample) + 0.55 * spread
    const best = (low: number, high: number): [number, number] => {
      let index = Math.max(1, low)
      let score = -Infinity
      for (let y = index; y < Math.min(height - 1, high); y += 1) {
        if (scores[y] <= score) continue
        index = y
        score = scores[y]
      }
      return [index, score]
    }
    const pairLow = Math.round(height * 0.44)
    const pairHigh = Math.round(height * 0.88)
    const minimumDepth = Math.round(height * 0.035)
    const maximumDepth = Math.round(height * 0.22)
    const peaks: number[] = []
    for (let y = Math.max(1, pairLow); y < Math.min(height - 1, pairHigh); y += 1) {
      if (scores[y] < threshold || scores[y] < scores[y - 1] || scores[y] < scores[y + 1]) continue
      peaks.push(y)
    }
    // Collapse double edges and narrow texture seams before reasoning about a
    // shelf/slab. Provider plates often contain two adjacent antialiased peaks
    // for one physical edge. Treating both as separate geometry lets a wall or
    // backsplash masquerade as a usable horizontal top.
    const structuralPeaks: number[] = []
    for (const peak of peaks) {
      const previous = structuralPeaks.at(-1)
      if (previous === undefined || peak - previous >= minimumDepth) {
        structuralPeaks.push(peak)
      } else if (scores[peak] > scores[previous]) {
        structuralPeaks[structuralPeaks.length - 1] = peak
      }
    }
    let pair: { backY: number; frontY: number; rank: number } | undefined
    let selectedSlabTop = false
    // Thick shelves and tables commonly yield three horizontal edges:
    // rear/top junction, front edge of the usable top, then the lower fascia.
    // The strongest edge is often the fascia bottom. When a coherent triple is
    // present, use its upper pair so the product lands on the top surface rather
    // than halfway down the vertical front face.
    let slab: { backY: number; frontY: number; rank: number } | undefined
    for (let first = 0; first < structuralPeaks.length - 2; first += 1) {
      // A physical top and fascia are adjacent structural bands. Skipping an
      // intervening structural edge is what caused a backsplash or the whole
      // slab face to be selected as the landing plane in real provider plates.
      const [candidateBack, candidateFront, fasciaBottom] = structuralPeaks.slice(first, first + 3)
      const topDepth = candidateFront - candidateBack
      const fasciaDepth = fasciaBottom - candidateFront
      if (candidateBack > height * 0.72 || candidateFront < height * 0.56 || candidateFront > height * 0.82) continue
      if (fasciaBottom > height * 0.88) continue
      if (topDepth < minimumDepth || topDepth > Math.round(height * 0.15)) continue
      if (fasciaDepth < Math.round(height * 0.025) || fasciaDepth > Math.round(height * 0.16)) continue
      if (fasciaBottom - candidateBack > maximumDepth) continue
      const depthRatio = topDepth / Math.max(fasciaDepth, 1)
      // A much deeper first band followed by a thin second band usually means
      // wall/backsplash + top, not top + fascia. Broad tops still fall through
      // to the generic two-edge detector when no slab triple is available.
      if (depthRatio < 0.42 || depthRatio > 1.85) continue
      const normalizedEvidence = (scores[candidateBack] + scores[candidateFront] + scores[fasciaBottom])
        / Math.max(threshold * 3, 1e-6)
      const topMidpoint = (candidateBack + candidateFront) / 2 / height
      // Multiple stacked ledges can form more than one valid triple. The
      // compiled plate contract places the usable top around the middle of
      // the landing band, so strongly prefer that surface over a lower shelf.
      const slabRank = normalizedEvidence - Math.abs(topMidpoint - 0.68) * 8
      if (!slab || slabRank > slab.rank) slab = { backY: candidateBack, frontY: candidateFront, rank: slabRank }
    }
    if (slab) {
      pair = slab
      selectedSlabTop = true
    } else {
      for (const candidateBack of peaks) {
        for (const candidateFront of peaks) {
          if (candidateBack > height * 0.70 || candidateFront < height * 0.58 || candidateFront > height * 0.82) continue
          const depth = candidateFront - candidateBack
          if (depth < minimumDepth || depth > maximumDepth) continue
          const weakerEdge = Math.min(scores[candidateBack], scores[candidateFront]) / Math.max(threshold, 1e-6)
          const combinedEdge = (scores[candidateBack] + scores[candidateFront]) / Math.max(threshold * 2, 1e-6)
          const midpoint = (candidateBack + candidateFront) / 2 / height
          const midpointPenalty = Math.abs(midpoint - 0.66) * 2.0
          const pairRank = weakerEdge * 2 + combinedEdge - midpointPenalty
          if (!pair || pairRank > pair.rank) pair = { backY: candidateBack, frontY: candidateFront, rank: pairRank }
        }
      }
    }
    let [backY, backScore] = pair
      ? [pair.backY, scores[pair.backY]]
      : best(Math.round(height * 0.48), Math.round(height * 0.73))
    let [frontY, frontScore] = pair
      ? [pair.frontY, scores[pair.frontY]]
      : best(Math.max(backY + Math.round(height * 0.07), Math.round(height * 0.70)), Math.round(height * 0.91))
    const fallbacks: string[] = []
    if (backScore < threshold) {
      backY = Math.round(height * 0.62)
      fallbacks.push('back')
    }
    if (frontScore < threshold || frontY - backY < minimumDepth) {
      frontY = Math.round(height * 0.84)
      fallbacks.push('front')
    }
    if (frontY <= backY + 2) {
      backY = Math.round(height * 0.62)
      frontY = Math.round(height * 0.84)
      fallbacks.splice(0, fallbacks.length, 'back', 'front')
    }
    const confidence = fallbacks.length === 0 ? 'high' : fallbacks.length === 1 ? 'medium' : 'low'
    const confidenceRank = confidence === 'high' ? 3 : confidence === 'medium' ? 2 : 1
    const evidence = Math.min(backScore, frontScore) / Math.max(threshold, 1e-6)
    // Prefer a wider equally-confident surface, but allow a narrow local podium
    // to win when its two edge cues are materially stronger.
    const rank = confidenceRank * 1_000 + (selectedSlabTop ? 100 : 0) + evidence * 10 + widthFraction
    return {
      backY,
      frontY,
      contactY: Math.round(backY + (frontY - backY) * framing.surfaceDepthFraction),
      confidence,
      method: `adaptive_central_surface_pair_${Math.round(widthFraction * 100)}pct${selectedSlabTop ? '+upper_surface_from_three_edge_slab' : ''}${fallbacks.length ? `+fallback_${fallbacks.join('_')}` : ''}`,
      analysisWindow: { x0, x1, widthFraction },
      backScore,
      frontScore,
      rank,
    }
  })
  candidates.sort((a, b) => b.rank - a.rank)
  const { rank: _rank, ...selected } = candidates[0]
  return selected
}

async function horizontalAnchorTilt(
  background: Buffer,
  anchorY: number,
  analysisWindow: SupportPlane['analysisWindow'],
): Promise<number> {
  const raw = await sharp(background).removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true })
  const { width, height, channels } = raw.info
  const centers: number[] = []
  const peaks: number[] = []
  const radius = Math.max(5, Math.round(height * 0.025))
  const span = analysisWindow.x1 - analysisWindow.x0
  for (const [low, high] of [[0, 0.30], [0.35, 0.65], [0.70, 1]]) {
    const x0 = Math.round(analysisWindow.x0 + span * low)
    const x1 = Math.round(analysisWindow.x0 + span * high)
    const rows = Array.from({ length: height }, (_, y) => rowMedianRgb(raw.data, width, channels, y, x0, x1))
    const deltas = rows.map((row, y) => y === 0 ? 0 : Math.hypot(row[0] - rows[y - 1][0], row[1] - rows[y - 1][1], row[2] - rows[y - 1][2]))
    const scores = smooth(deltas, 3)
    let peak = Math.max(1, anchorY - radius)
    for (let y = peak; y <= Math.min(height - 2, anchorY + radius); y += 1) if (scores[y] > scores[peak]) peak = y
    centers.push((x0 + x1 - 1) / 2)
    peaks.push(peak)
  }
  return Math.atan(regressionSlope(centers, peaks)) * 180 / Math.PI
}

export function supportCueTiltRequiresRetry(backTiltDegrees: number, frontTiltDegrees: number): boolean {
  const sameTiltDirection = Math.sign(backTiltDegrees) === Math.sign(frontTiltDegrees)
  const coherentTilt = sameTiltDirection && Math.abs(backTiltDegrees) > 2 && Math.abs(frontTiltDegrees) > 2
  const extremeSingleCue = Math.max(Math.abs(backTiltDegrees), Math.abs(frontTiltDegrees)) > 5
  return coherentTilt || extremeSingleCue
}

async function placeCanonical(
  background: Buffer,
  cutout: Buffer,
  analysis: CutoutAnalysis,
  size: CompositeSizeResolution,
  framing: CompositeFramingProfile,
  support: SupportPlane,
): Promise<{ layer: Buffer; placement: CompositePlacement; backgroundSize: [number, number] }> {
  const backgroundMetadata = await sharp(background).metadata()
  const width = backgroundMetadata.width
  const height = backgroundMetadata.height
  if (!width || !height) throw new Error('background dimensions are unavailable')
  const [left, top, right, bottom] = analysis.alphaBbox
  const sourceWidth = right - left
  const sourceHeight = bottom - top
  const targetHeight = Math.max(1, Math.round(height * projectedHeightFraction(size, framing)))
  const sourceRatio = sourceWidth / sourceHeight
  const candidates: Array<[number, number, number, number]> = []
  for (let candidateHeight = Math.max(1, targetHeight - 3); candidateHeight <= targetHeight + 3; candidateHeight += 1) {
    const candidateWidth = Math.max(1, Math.round(candidateHeight * sourceRatio))
    candidates.push([Math.abs(candidateWidth / candidateHeight / sourceRatio - 1), Math.abs(candidateHeight - targetHeight), candidateWidth, candidateHeight])
  }
  candidates.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const [, , placedWidth, placedHeight] = candidates[0]
  const layer = await sharp(cutout)
    .extract({ left, top, width: sourceWidth, height: sourceHeight })
    .resize(placedWidth, placedHeight, { kernel: sharp.kernel.lanczos3 })
    .png()
    .toBuffer()
  const x = Math.round(width * 0.52 - placedWidth / 2)
  const y = support.contactY - placedHeight
  if (x < 0 || y < 0 || x + placedWidth > width || y + placedHeight > height) {
    throw new Error('resolved canonical placement falls outside the background')
  }
  return {
    layer,
    placement: { x, y, width: placedWidth, height: placedHeight, sourceBbox: analysis.alphaBbox, scale: placedHeight / sourceHeight },
    backgroundSize: [width, height],
  }
}

function shadowOffset(directionValue: string, width: number): [number, number] {
  const amount = Math.max(3, Math.round(width * 0.025))
  const x = directionValue.includes('left') ? amount : directionValue.includes('right') ? -amount : 0
  const y = directionValue.includes('upper') ? amount : directionValue.includes('lower') ? -amount : Math.round(amount / 2)
  return [x, y]
}

async function compositeWithShadow(
  background: Buffer,
  layer: Buffer,
  placement: CompositePlacement,
  shadowProfile: ProceduralShadowProfile,
  backgroundSize: [number, number],
  support: SupportPlane,
): Promise<Buffer> {
  const [width, height] = backgroundSize
  const layerRaw = await sharp(layer).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const alpha = Buffer.alloc(placement.width * placement.height)
  for (let index = 0; index < alpha.length; index += 1) alpha[index] = layerRaw.data[index * layerRaw.info.channels + 3]
  const compressedHeight = Math.max(4, Math.round(placement.height * 0.065))
  const compressed = await sharp(alpha, { raw: { width: placement.width, height: placement.height, channels: 1 } })
    .resize(placement.width, compressedHeight, { kernel: sharp.kernel.lanczos3 })
    .raw()
    .toBuffer()
  const [dx, dy] = shadowOffset(shadowProfile.direction, placement.width)
  const shadowY = placement.y + placement.height - Math.round(compressedHeight / 2) + Math.max(0, Math.round(dy / 3))
  const canvas = Buffer.alloc(width * height)
  for (let y = 0; y < compressedHeight; y += 1) {
    const targetY = shadowY + y
    if (targetY < support.backY || targetY >= Math.min(height, support.frontY)) continue
    for (let x = 0; x < placement.width; x += 1) {
      const targetX = placement.x + dx + x
      if (targetX < 0 || targetX >= width) continue
      canvas[targetY * width + targetX] = Math.max(canvas[targetY * width + targetX], compressed[y * placement.width + x])
    }
  }
  const sigma = Math.max(3, placement.width * shadowProfile.castBlurSigmaFraction)
  const blurred = await sharp(canvas, { raw: { width, height, channels: 1 } }).blur(sigma).raw().toBuffer()
  const shadow = Buffer.alloc(width * height * 4)
  for (let index = 0; index < width * height; index += 1) {
    shadow[index * 4] = shadowProfile.colorRgb[0]
    shadow[index * 4 + 1] = shadowProfile.colorRgb[1]
    shadow[index * 4 + 2] = shadowProfile.colorRgb[2]
    shadow[index * 4 + 3] = Math.round(blurred[index] * shadowProfile.castOpacity)
  }

  // A second, tight ambient-occlusion footprint anchors the object exactly at
  // the landing row. It is derived only from the canonical alpha and remains
  // behind the canonical layer, so it cannot alter product pixels.
  const footprint = Buffer.alloc(placement.width)
  const bottomBandStart = Math.max(0, Math.floor(placement.height * 0.82))
  for (let x = 0; x < placement.width; x += 1) {
    let maximum = 0
    for (let y = bottomBandStart; y < placement.height; y += 1) {
      maximum = Math.max(maximum, alpha[y * placement.width + x])
    }
    footprint[x] = maximum
  }
  const contactHeight = Math.max(3, Math.round(placement.width * 0.025))
  const contactCanvas = Buffer.alloc(width * height)
  const contactTop = placement.y + placement.height - Math.ceil(contactHeight / 2)
  for (let y = 0; y < contactHeight; y += 1) {
    const targetY = contactTop + y
    if (targetY < support.backY || targetY >= Math.min(height, support.frontY)) continue
    const verticalWeight = 1 - Math.abs((y + 0.5) / contactHeight - 0.5) * 1.35
    for (let x = 0; x < placement.width; x += 1) {
      const targetX = placement.x + x
      if (targetX < 0 || targetX >= width) continue
      contactCanvas[targetY * width + targetX] = Math.round(footprint[x] * Math.max(0, verticalWeight))
    }
  }
  const contactBlurred = await sharp(contactCanvas, { raw: { width, height, channels: 1 } })
    .blur(Math.max(1.2, placement.width * shadowProfile.contactBlurSigmaFraction))
    .raw()
    .toBuffer()
  const contactShadow = Buffer.alloc(width * height * 4)
  for (let index = 0; index < width * height; index += 1) {
    contactShadow[index * 4] = Math.round(shadowProfile.colorRgb[0] * 0.65)
    contactShadow[index * 4 + 1] = Math.round(shadowProfile.colorRgb[1] * 0.65)
    contactShadow[index * 4 + 2] = Math.round(shadowProfile.colorRgb[2] * 0.65)
    contactShadow[index * 4 + 3] = Math.round(contactBlurred[index] * shadowProfile.contactOpacity)
  }

  // A very narrow occlusion core prevents the familiar "floating cutout"
  // seam. The product layer is composited last, so this remains entirely
  // behind the canonical pixels and cannot alter labels or package geometry.
  const coreHeight = Math.max(2, Math.round(placement.width * 0.010))
  const coreCanvas = Buffer.alloc(width * height)
  const coreTop = placement.y + placement.height - 1
  for (let y = 0; y < coreHeight; y += 1) {
    const targetY = coreTop + y
    if (targetY < support.backY || targetY >= Math.min(height, support.frontY)) continue
    const verticalWeight = 1 - y / Math.max(coreHeight, 1) * 0.55
    for (let x = 0; x < placement.width; x += 1) {
      const targetX = placement.x + x
      if (targetX < 0 || targetX >= width) continue
      coreCanvas[targetY * width + targetX] = Math.round(footprint[x] * verticalWeight)
    }
  }
  const coreBlurred = await sharp(coreCanvas, { raw: { width, height, channels: 1 } })
    .blur(Math.max(0.5, placement.width * shadowProfile.occlusionCoreBlurSigmaFraction))
    .raw()
    .toBuffer()
  const occlusionCore = Buffer.alloc(width * height * 4)
  for (let index = 0; index < width * height; index += 1) {
    occlusionCore[index * 4] = Math.round(shadowProfile.colorRgb[0] * 0.45)
    occlusionCore[index * 4 + 1] = Math.round(shadowProfile.colorRgb[1] * 0.45)
    occlusionCore[index * 4 + 2] = Math.round(shadowProfile.colorRgb[2] * 0.45)
    occlusionCore[index * 4 + 3] = Math.round(coreBlurred[index] * shadowProfile.occlusionCoreOpacity)
  }
  return sharp(background)
    .ensureAlpha()
    .composite([
      { input: shadow, raw: { width, height, channels: 4 }, blend: 'over' },
      { input: contactShadow, raw: { width, height, channels: 4 }, blend: 'over' },
      { input: occlusionCore, raw: { width, height, channels: 4 }, blend: 'over' },
      { input: layer, left: placement.x, top: placement.y, blend: 'over' },
    ])
    .png()
    .toBuffer()
}

function srgbChannel(value: number): number {
  const normalized = value / 255
  return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
}

function rgbToLab(red: number, green: number, blue: number): [number, number, number] {
  const r = srgbChannel(red)
  const g = srgbChannel(green)
  const b = srgbChannel(blue)
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047
  const y = 0.2126729 * r + 0.7151522 * g + 0.0721750 * b
  const z = (0.0193339 * r + 0.1191920 * g + 0.9503041 * b) / 1.08883
  const delta = 6 / 29
  const convert = (value: number): number => value > delta ** 3 ? Math.cbrt(value) : value / (3 * delta ** 2) + 4 / 29
  const fx = convert(x)
  const fy = convert(y)
  const fz = convert(z)
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)]
}

export function deltaE2000(first: [number, number, number], second: [number, number, number]): number {
  const [l1, a1, b1] = first
  const [l2, a2, b2] = second
  const c1 = Math.hypot(a1, b1)
  const c2 = Math.hypot(a2, b2)
  const cbar = (c1 + c2) / 2
  const g = 0.5 * (1 - Math.sqrt(cbar ** 7 / (cbar ** 7 + 25 ** 7 + 1e-20)))
  const ap1 = (1 + g) * a1
  const ap2 = (1 + g) * a2
  const cp1 = Math.hypot(ap1, b1)
  const cp2 = Math.hypot(ap2, b2)
  const hue = (b: number, a: number, chroma: number): number => chroma === 0 ? 0 : (Math.atan2(b, a) * 180 / Math.PI + 360) % 360
  const hp1 = hue(b1, ap1, cp1)
  const hp2 = hue(b2, ap2, cp2)
  const dl = l2 - l1
  const dc = cp2 - cp1
  const rawDh = hp2 - hp1
  const dh = cp1 * cp2 === 0 ? 0 : rawDh > 180 ? rawDh - 360 : rawDh < -180 ? rawDh + 360 : rawDh
  const dH = 2 * Math.sqrt(cp1 * cp2) * Math.sin(dh * Math.PI / 360)
  const lbar = (l1 + l2) / 2
  const cpbar = (cp1 + cp2) / 2
  const sum = hp1 + hp2
  const diff = Math.abs(hp1 - hp2)
  const hpbar = cp1 * cp2 === 0 ? sum : diff <= 180 ? sum / 2 : sum < 360 ? (sum + 360) / 2 : (sum - 360) / 2
  const radians = (degrees: number): number => degrees * Math.PI / 180
  const t = 1 - 0.17 * Math.cos(radians(hpbar - 30)) + 0.24 * Math.cos(radians(2 * hpbar)) + 0.32 * Math.cos(radians(3 * hpbar + 6)) - 0.20 * Math.cos(radians(4 * hpbar - 63))
  const sl = 1 + 0.015 * (lbar - 50) ** 2 / Math.sqrt(20 + (lbar - 50) ** 2)
  const sc = 1 + 0.045 * cpbar
  const sh = 1 + 0.015 * cpbar * t
  const rt = -2 * Math.sqrt(cpbar ** 7 / (cpbar ** 7 + 25 ** 7 + 1e-20)) * Math.sin(radians(60 * Math.exp(-(((hpbar - 275) / 25) ** 2))))
  return Math.sqrt((dl / sl) ** 2 + (dc / sc) ** 2 + (dH / sh) ** 2 + rt * (dc / sc) * (dH / sh))
}

function linearChannelToSrgb(value: number): number {
  const bounded = clamp(value, 0, 1)
  const encoded = bounded <= 0.0031308 ? bounded * 12.92 : 1.055 * bounded ** (1 / 2.4) - 0.055
  return Math.round(clamp(encoded * 255, 0, 255))
}

export async function sampleLocalBackgroundColor(
  background: Buffer,
  placement: CompositePlacement,
  support: SupportPlane,
  fallbackRgb: [number, number, number],
  options: LocalBackgroundColorSamplingOptions = {},
): Promise<LocalBackgroundColorSample> {
  const metadata = await sharp(background).metadata()
  if (!metadata.width || !metadata.height) {
    return { rgb: fallbackRgb, pixelCount: 0, method: 'global_plate_neutral_fallback' }
  }
  const marginX = Math.max(placement.width, Math.round(metadata.width * 0.06))
  const x0 = Math.max(0, placement.x - marginX)
  const x1 = Math.min(metadata.width, placement.x + placement.width + marginX)
  const halfBand = Math.max(8, Math.round((support.frontY - support.backY) * 0.36))
  const y0 = Math.max(0, support.contactY - halfBand)
  const y1 = Math.min(metadata.height, support.contactY + halfBand)
  if (x1 <= x0 || y1 <= y0) return { rgb: fallbackRgb, pixelCount: 0, method: 'global_plate_neutral_fallback' }
  const sampled = await sharp(background)
    .removeAlpha()
    .toColourspace('srgb')
    .extract({ left: x0, top: y0, width: x1 - x0, height: y1 - y0 })
    .resize(160, 64, { fit: 'fill', kernel: sharp.kernel.lanczos3 })
    .raw()
    .toBuffer({ resolveWithObject: true })
  const red: number[] = []
  const green: number[] = []
  const blue: number[] = []
  const maxNeutralChromaFraction = options.maxNeutralChromaFraction ?? 0.14
  for (let offset = 0; offset < sampled.data.length; offset += sampled.info.channels) {
    const pixelIndex = offset / sampled.info.channels
    const sampleX = pixelIndex % sampled.info.width
    const sampleY = Math.floor(pixelIndex / sampled.info.width)
    const sourceX = x0 + (sampleX + 0.5) / sampled.info.width * (x1 - x0)
    const sourceY = y0 + (sampleY + 0.5) / sampled.info.height * (y1 - y0)
    if (options.excludePlacement
      && sourceX >= placement.x
      && sourceX < placement.x + placement.width
      && sourceY >= placement.y
      && sourceY < placement.y + placement.height) continue
    const r = sampled.data[offset]
    const g = sampled.data[offset + 1]
    const b = sampled.data[offset + 2]
    const value = 0.2126 * r + 0.7152 * g + 0.0722 * b
    const chroma = Math.max(r, g, b) - Math.min(r, g, b)
    if (value < 40 || value > 245 || chroma > Math.max(18, value * maxNeutralChromaFraction)) continue
    red.push(r)
    green.push(g)
    blue.push(b)
  }
  if (red.length < 48) return { rgb: fallbackRgb, pixelCount: red.length, method: 'global_plate_neutral_fallback' }
  return {
    rgb: [median(red), median(green), median(blue)],
    pixelCount: red.length,
    method: 'placement_local_neutral_pixels',
  }
}

function pixelDifferenceStats(
  source: Uint8Array,
  comparison: Uint8Array,
  channels: number,
): PixelDifferenceStats {
  let pixelCount = 0
  let absoluteDiff = 0
  let maxAbsoluteRgbDiff = 0
  let maxDeltaE2000 = 0
  const deltaValues: number[] = []
  for (let offset = 0; offset < source.length; offset += channels) {
    if (source[offset + 3] !== 255) continue
    const first: [number, number, number] = [source[offset], source[offset + 1], source[offset + 2]]
    const second: [number, number, number] = [comparison[offset], comparison[offset + 1], comparison[offset + 2]]
    for (let channel = 0; channel < 3; channel += 1) {
      const diff = Math.abs(first[channel] - second[channel])
      absoluteDiff += diff
      maxAbsoluteRgbDiff = Math.max(maxAbsoluteRgbDiff, diff)
    }
    const delta = deltaE2000(rgbToLab(...first), rgbToLab(...second))
    deltaValues.push(delta)
    maxDeltaE2000 = Math.max(maxDeltaE2000, delta)
    pixelCount += 1
  }
  return {
    pixelCount,
    meanAbsoluteRgbDiff: pixelCount ? absoluteDiff / (pixelCount * 3) : 0,
    maxAbsoluteRgbDiff,
    meanDeltaE2000: deltaValues.length ? deltaValues.reduce((sum, value) => sum + value, 0) / deltaValues.length : 0,
    p95DeltaE2000: percentile(deltaValues, 0.95),
    maxDeltaE2000,
  }
}

function desiredAmbientGains(
  sourceRgb: [number, number, number],
  targetRgb: [number, number, number],
): [number, number, number] {
  const source = sourceRgb.map(srgbChannel)
  const target = targetRgb.map(srgbChannel)
  const sourceLuma = 0.2126 * source[0] + 0.7152 * source[1] + 0.0722 * source[2]
  const targetLuma = 0.2126 * target[0] + 0.7152 * target[1] + 0.0722 * target[2]
  const exposure = clamp(targetLuma / Math.max(sourceLuma, 1e-5), 0.88, 1.15)
  return source.map((value, channel) => {
    const ratio = target[channel] / Math.max(value, 1e-5)
    const chromatic = clamp(ratio / Math.max(targetLuma / Math.max(sourceLuma, 1e-5), 1e-5), 0.84, 1.16)
    return clamp(chromatic * exposure, 0.84, 1.18)
  }) as [number, number, number]
}

function applyAmbientTransform(
  source: Uint8Array,
  width: number,
  height: number,
  channels: number,
  desiredGains: [number, number, number],
  strength: number,
): { output: Buffer; detailProtectedPixelCount: number } {
  const output = Buffer.from(source)
  let detailProtectedPixelCount = 0
  const lumaAt = (pixelIndex: number): number => {
    const offset = pixelIndex * channels
    return 0.2126 * source[offset] + 0.7152 * source[offset + 1] + 0.0722 * source[offset + 2]
  }
  for (let offset = 0; offset < source.length; offset += channels) {
    if (source[offset + 3] === 0) continue
    const pixelIndex = offset / channels
    const x = pixelIndex % width
    const y = Math.floor(pixelIndex / width)
    const maximum = Math.max(source[offset], source[offset + 1], source[offset + 2])
    const minimum = Math.min(source[offset], source[offset + 1], source[offset + 2])
    const saturation = (maximum - minimum) / Math.max(maximum, 1)
    // Highly chromatic package colors retain more of the canonical RGB values;
    // neutrals receive the fuller white-balance correction.
    const chromaProtection = 1 - clamp(saturation, 0, 1) * 0.45
    let detailGradient = 0
    if (x > 0 && x + 1 < width) detailGradient = Math.max(detailGradient, Math.abs(lumaAt(pixelIndex - 1) - lumaAt(pixelIndex + 1)) / 2)
    if (y > 0 && y + 1 < height) detailGradient = Math.max(detailGradient, Math.abs(lumaAt(pixelIndex - width) - lumaAt(pixelIndex + width)) / 2)
    const highFrequency = clamp((detailGradient - 5) / 28, 0, 1)
    const antialiasProtection = source[offset + 3] < 250 ? 0 : 1
    const detailProtection = (1 - highFrequency * 0.88) * antialiasProtection
    if (detailProtection < 0.999) detailProtectedPixelCount += 1
    const localStrength = strength * chromaProtection * detailProtection
    for (let channel = 0; channel < 3; channel += 1) {
      const gain = 1 + (desiredGains[channel] - 1) * localStrength
      output[offset + channel] = linearChannelToSrgb(srgbChannel(source[offset + channel]) * gain)
    }
  }
  return { output, detailProtectedPixelCount }
}

export async function harmonizeCanonicalLayer(
  sourceLayer: Buffer,
  sourceNeutralRgb: [number, number, number],
  localBackgroundSample: LocalBackgroundColorSample,
  policy: ResolvedCompositeColorPolicy,
): Promise<{ layer: Buffer; report: CompositeColorReport }> {
  const source = await sharp(sourceLayer).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const identity = pixelDifferenceStats(source.data, source.data, source.info.channels)
  if (policy.mode === 'strict' || policy.strength === 0) {
    return {
      layer: sourceLayer,
      report: {
        policy,
        localBackgroundSample,
        sourceNeutralRgb,
        desiredLinearRgbGains: [1, 1, 1],
        appliedStrength: 0,
        detailProtectedPixelCount: 0,
        alphaChangedPixelCount: 0,
        intendedChangeFromCanonical: identity,
        passed: true,
        rejectionReasons: [],
      },
    }
  }

  const desiredGains = desiredAmbientGains(sourceNeutralRgb, localBackgroundSample.rgb)
  let low = 0
  let high = policy.strength
  let appliedStrength = 0
  let rendered: Buffer = Buffer.from(source.data)
  let detailProtectedPixelCount = 0
  let intended = identity
  for (let iteration = 0; iteration < 9; iteration += 1) {
    const candidateStrength = iteration === 0 ? high : (low + high) / 2
    const candidate = applyAmbientTransform(
      source.data,
      source.info.width,
      source.info.height,
      source.info.channels,
      desiredGains,
      candidateStrength,
    )
    const stats = pixelDifferenceStats(source.data, candidate.output, source.info.channels)
    const withinBudget = stats.meanDeltaE2000 <= policy.maxMeanDeltaE2000
      && stats.p95DeltaE2000 <= policy.maxP95DeltaE2000
    if (withinBudget) {
      low = candidateStrength
      appliedStrength = candidateStrength
      rendered = candidate.output
      detailProtectedPixelCount = candidate.detailProtectedPixelCount
      intended = stats
      if (iteration === 0) break
    } else {
      high = candidateStrength
    }
  }
  let alphaChangedPixelCount = 0
  for (let offset = 0; offset < source.data.length; offset += source.info.channels) {
    if (source.data[offset + 3] !== rendered[offset + 3]) alphaChangedPixelCount += 1
  }
  const rejectionReasons: string[] = []
  if (alphaChangedPixelCount !== 0) rejectionReasons.push('ambient_color_transform_changed_alpha')
  if (intended.meanDeltaE2000 > policy.maxMeanDeltaE2000 || intended.p95DeltaE2000 > policy.maxP95DeltaE2000) {
    rejectionReasons.push('ambient_color_transform_exceeded_delta_e_budget')
  }
  const layer = await sharp(rendered, {
    raw: { width: source.info.width, height: source.info.height, channels: source.info.channels },
  }).png().toBuffer()
  return {
    layer,
    report: {
      policy,
      localBackgroundSample,
      sourceNeutralRgb,
      desiredLinearRgbGains: desiredGains,
      appliedStrength,
      detailProtectedPixelCount,
      alphaChangedPixelCount,
      intendedChangeFromCanonical: intended,
      passed: rejectionReasons.length === 0,
      rejectionReasons,
    },
  }
}

async function cameraCompatibility(
  background: Buffer,
  placement: CompositePlacement,
  support: SupportPlane,
  analysis: CutoutAnalysis,
  backgroundSize: [number, number],
): Promise<CameraCompatibility> {
  const [, height] = backgroundSize
  const productCenter = (placement.y + placement.height / 2) / height
  const axisOffset = Math.abs(productCenter - 0.5)
  const bandDepth = (support.frontY - support.backY) / height
  const backFraction = support.backY / height
  const frontFraction = support.frontY / height
  const contactFraction = support.contactY / height
  const [backTilt, frontTilt] = await Promise.all([
    horizontalAnchorTilt(background, support.backY, support.analysisWindow),
    horizontalAnchorTilt(background, support.frontY, support.analysisWindow),
  ])
  const projection = analysis.view.projectionClass
  const maxAxisOffset = projection === 'frontal_low_perspective' ? 0.15 : projection === 'roughly_frontal' ? 0.18 : 0
  const maxBandDepth = projection === 'frontal_low_perspective' ? 0.20 : projection === 'roughly_frontal' ? 0.25 : 0
  const reasons: string[] = []
  if (!['frontal_low_perspective', 'roughly_frontal'].includes(projection)) reasons.push('cutout_view_requires_explicit_camera_metadata')
  if (axisOffset > maxAxisOffset) reasons.push('product_center_too_far_from_optical_axis')
  if (bandDepth > maxBandDepth) reasons.push('support_plane_reads_too_top_down')
  if (backFraction > 0.70 || frontFraction > 0.84 || contactFraction < 0.58 || contactFraction > 0.76) {
    reasons.push('support_surface_outside_expected_landing_band')
  }
  // A round podium produces opposite/non-parallel contour slopes even though its
  // physical top plane is level. Reject a coherent tilt shared by both cues, or
  // one extreme cue, rather than treating any single curved contour as a plane.
  if (supportCueTiltRequiresRetry(backTilt, frontTilt)) reasons.push('support_horizontal_cues_are_not_level')
  if (support.confidence !== 'high') reasons.push('support_plane_detection_not_high_confidence')
  return {
    projectionClass: projection,
    productCenterYFraction: productCenter,
    opticalAxisOffsetFraction: axisOffset,
    supportBandDepthFraction: bandDepth,
    backAnchorTiltDegrees: backTilt,
    frontAnchorTiltDegrees: frontTilt,
    passed: reasons.length === 0,
    rejectionReasons: reasons,
  }
}

async function qaComposite(
  final: Buffer,
  renderedLayer: Buffer,
  placement: CompositePlacement,
  support: SupportPlane,
  analysis: CutoutAnalysis,
  size: CompositeSizeResolution,
  background: Buffer,
  backgroundSize: [number, number],
  backgroundLighting: BackgroundLightingAnalysis,
  lightingCompatibility: LightingCompatibility,
  shadowProfile: ProceduralShadowProfile,
  colorReport: CompositeColorReport,
): Promise<CompositeQaReport> {
  const finalRaw = await sharp(final).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const layerRaw = await sharp(renderedLayer).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  let corePixels = 0
  let absoluteDiff = 0
  let maxDiff = 0
  let maxDelta = 0
  const deltaValues: number[] = []
  for (let y = 0; y < placement.height; y += 1) {
    for (let x = 0; x < placement.width; x += 1) {
      const layerOffset = (y * placement.width + x) * layerRaw.info.channels
      if (layerRaw.data[layerOffset + 3] !== 255) continue
      const finalOffset = ((placement.y + y) * finalRaw.info.width + placement.x + x) * finalRaw.info.channels
      const first: [number, number, number] = [layerRaw.data[layerOffset], layerRaw.data[layerOffset + 1], layerRaw.data[layerOffset + 2]]
      const second: [number, number, number] = [finalRaw.data[finalOffset], finalRaw.data[finalOffset + 1], finalRaw.data[finalOffset + 2]]
      for (let channel = 0; channel < 3; channel += 1) {
        const diff = Math.abs(first[channel] - second[channel])
        absoluteDiff += diff
        maxDiff = Math.max(maxDiff, diff)
      }
      const delta = deltaE2000(rgbToLab(...first), rgbToLab(...second))
      deltaValues.push(delta)
      maxDelta = Math.max(maxDelta, delta)
      corePixels += 1
    }
  }
  const camera = await cameraCompatibility(background, placement, support, analysis, backgroundSize)
  const placedRatio = placement.width / placement.height
  const ratioError = (placedRatio / analysis.cutoutWidthHeightRatio - 1) * 100
  const placementBottomMatchesContact = placement.y + placement.height === support.contactY
  const contactInsideLandingBand = support.backY < support.contactY && support.contactY < support.frontY
  const productDoesNotCrossFrontAnchor = placement.y + placement.height <= support.frontY
  const rejectionReasons: string[] = []
  if (corePixels === 0) rejectionReasons.push('canonical_opaque_core_missing')
  if (maxDiff !== 0 || maxDelta >= 1e-9) rejectionReasons.push('canonical_product_pixels_changed')
  if (Math.abs(ratioError) > 0.1) rejectionReasons.push('canonical_width_height_ratio_changed')
  if (!placementBottomMatchesContact) rejectionReasons.push('product_bottom_does_not_match_contact_row')
  if (!contactInsideLandingBand) rejectionReasons.push('contact_row_is_outside_support_plane')
  if (!productDoesNotCrossFrontAnchor) rejectionReasons.push('product_crosses_support_front_edge')
  rejectionReasons.push(...camera.rejectionReasons)
  rejectionReasons.push(...lightingCompatibility.rejectionReasons)
  rejectionReasons.push(...colorReport.rejectionReasons)
  return {
    widthHeightRatioErrorPercent: ratioError,
    silhouetteIouAgainstPlacedCanonical: 1,
    opaqueCore: {
      pixelCount: corePixels,
      meanAbsoluteRgbDiff: corePixels ? absoluteDiff / (corePixels * 3) : 0,
      maxAbsoluteRgbDiff: maxDiff,
      meanDeltaE2000: deltaValues.length ? deltaValues.reduce((sum, value) => sum + value, 0) / deltaValues.length : 0,
      p95DeltaE2000: percentile(deltaValues, 0.95),
      maxDeltaE2000: maxDelta,
    },
    color: colorReport,
    sizeResolution: size,
    projectedHeightFraction: placement.height / backgroundSize[1],
    supportPlane: support,
    cameraCompatibility: camera,
    backgroundLighting,
    lightingCompatibility,
    shadowProfile,
    geometry: {
      transform: 'uniform_scale_and_translation',
      warpApplied: false,
      incompatiblePlateAction: 'retry_empty_background_plate',
    },
    placement,
    placementBottomMatchesContact,
    contactInsideLandingBand,
    productDoesNotCrossFrontAnchor,
    pass: rejectionReasons.length === 0,
    rejectionReasons,
  }
}

export function evaluateCompositeQa(report: CompositeQaReport): CompositeQaAcceptance {
  return {
    accepted: report.pass,
    retryRecommended: !report.pass,
    reasons: [...report.rejectionReasons],
  }
}

async function qaOverlay(final: Buffer, placement: CompositePlacement, support: SupportPlane, backgroundSize: [number, number]): Promise<Buffer> {
  const [width, height] = backgroundSize
  const line = Math.max(2, Math.round(width / 700))
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <line x1="0" y1="${support.backY}" x2="${width}" y2="${support.backY}" stroke="#ffdc00" stroke-width="${line}"/>
    <line x1="0" y1="${support.frontY}" x2="${width}" y2="${support.frontY}" stroke="#ff00d2" stroke-width="${line}"/>
    <line x1="0" y1="${support.contactY}" x2="${width}" y2="${support.contactY}" stroke="#00ffff" stroke-width="${line}"/>
    <rect x="${placement.x}" y="${placement.y}" width="${placement.width}" height="${placement.height}" fill="none" stroke="#ff2323" stroke-width="${line}"/>
  </svg>`)
  return sharp(final).composite([{ input: svg, blend: 'over' }]).png().toBuffer()
}

export async function compositeCanonicalCutout(
  background: Buffer,
  cutout: Buffer,
  analysis: CutoutAnalysis,
  size: CompositeSizeResolution,
  framing: CompositeFramingProfile,
  colorPolicy: ResolvedCompositeColorPolicy = resolveCompositeColorPolicy(),
): Promise<CompositeOutput> {
  const [support, globalBackgroundLighting] = await Promise.all([
    detectSupportPlane(background, framing),
    analyzeBackgroundLighting(background),
  ])
  const { layer: canonicalLayer, placement, backgroundSize } = await placeCanonical(background, cutout, analysis, size, framing, support)
  const [backgroundWidth, backgroundHeight] = backgroundSize
  const lightingMarginX = Math.max(placement.width, Math.round(backgroundWidth * 0.05))
  const lightingLeft = Math.max(0, placement.x - lightingMarginX)
  const lightingRight = Math.min(backgroundWidth, placement.x + placement.width + lightingMarginX)
  const supportInset = Math.max(2, Math.round((support.contactY - support.backY) * 0.06))
  const lightingTop = Math.max(0, support.backY + supportInset)
  const lightingBottom = Math.min(backgroundHeight, support.contactY - supportInset)
  const localLighting = lightingRight - lightingLeft >= 8 && lightingBottom - lightingTop >= 8
    ? await analyzeBackgroundLighting(background, {
      left: lightingLeft,
      top: lightingTop,
      width: lightingRight - lightingLeft,
      height: lightingBottom - lightingTop,
    })
    : globalBackgroundLighting
  const backgroundLighting: BackgroundLightingAnalysis = {
    ...globalBackgroundLighting,
    edgeHardnessScore: localLighting.edgeHardnessScore,
    hardEdgeFraction: localLighting.hardEdgeFraction,
    quality: localLighting.quality,
    qualitySource: localLighting.qualitySource,
    globalQuality: globalBackgroundLighting.quality,
    globalEdgeHardnessScore: globalBackgroundLighting.edgeHardnessScore,
    globalHardEdgeFraction: globalBackgroundLighting.hardEdgeFraction,
  }
  const lightingCompatibility = evaluateLightingCompatibility(analysis.lighting, backgroundLighting)
  const localBackgroundSample = await sampleLocalBackgroundColor(
    background,
    placement,
    support,
    backgroundLighting.neutralSampleRgb,
  )
  const { layer: renderedLayer, report: colorReport } = await harmonizeCanonicalLayer(
    canonicalLayer,
    analysis.lighting.neutralSampleRgb,
    localBackgroundSample,
    colorPolicy,
  )
  const shadowProfile = resolveProceduralShadowProfile(
    analysis.lighting,
    backgroundLighting,
    lightingCompatibility,
    localBackgroundSample.rgb,
  )
  const result = await compositeWithShadow(background, renderedLayer, placement, shadowProfile, backgroundSize, support)
  const report = await qaComposite(
    result,
    renderedLayer,
    placement,
    support,
    analysis,
    size,
    background,
    backgroundSize,
    backgroundLighting,
    lightingCompatibility,
    shadowProfile,
    colorReport,
  )
  const overlay = await qaOverlay(result, placement, support, backgroundSize)
  return { result, overlay, report, acceptance: evaluateCompositeQa(report) }
}
