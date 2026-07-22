import { describe, expect, it } from 'vitest'

import {
  deltaE2000,
  evaluateLightingCompatibility,
  resolveProceduralShadowProfile,
  supportCueTiltRequiresRetry,
  type BackgroundLightingAnalysis,
  type CutoutLightingAnalysis,
} from '../src/composite.js'

const foreground: CutoutLightingAnalysis = {
  direction: 'upper_left',
  directionVectorNormalized: { dx: -0.05, dy: -0.10 },
  soft: true,
  softnessScore: 0.04,
  whiteBalance: 'neutral',
  neutralSampleRgb: [160, 162, 160],
}

function background(overrides: Partial<BackgroundLightingAnalysis> = {}): BackgroundLightingAnalysis {
  return {
    sampleSize: { width: 160, height: 90 },
    luma: { p10: 90, median: 170, p90: 230, dynamicRange: 140 },
    whiteBalance: 'neutral',
    neutralSampleRgb: [170, 170, 164],
    direction: 'lower_right',
    directionVectorNormalized: { dx: 0.05, dy: 0.05 },
    directionConfidence: 0.4,
    edgeHardnessScore: 0.25,
    hardEdgeFraction: 0.21,
    quality: 'defined',
    ...overrides,
  }
}

describe('low-cost background lighting gate', () => {
  it('rejects a clearly hard plate for a soft-lit cutout and keeps the foreground direction', () => {
    const plate = background()
    const compatibility = evaluateLightingCompatibility(foreground, plate)
    expect(compatibility.passed).toBe(false)
    expect(compatibility.rejectionReasons).toContain('background_light_is_harder_than_product_light')
    expect(compatibility.shadowDirectionSource).toBe('foreground_fallback')
    const shadow = resolveProceduralShadowProfile(foreground, plate, compatibility)
    expect(shadow.direction).toBe('upper_left')
    expect(shadow.hardnessBlend).toBeGreaterThan(0.8)
  })

  it('uses the background direction when a compatible soft plate agrees with the product', () => {
    const plate = background({
      direction: 'upper_left',
      directionConfidence: 0.8,
      edgeHardnessScore: 0.10,
      hardEdgeFraction: 0.05,
      quality: 'soft',
    })
    const compatibility = evaluateLightingCompatibility(foreground, plate)
    expect(compatibility.passed).toBe(true)
    expect(compatibility.shadowDirectionSource).toBe('background')
    const shadow = resolveProceduralShadowProfile(foreground, plate, compatibility)
    expect(shadow.direction).toBe('upper_left')
    expect(shadow.castBlurSigmaFraction).toBeGreaterThan(0.03)
  })
})

describe('support-plane camera gate', () => {
  it('does not mistake one curved podium contour for a tilted physical plane', () => {
    expect(supportCueTiltRequiresRetry(2.22, -0.37)).toBe(false)
    expect(supportCueTiltRequiresRetry(2.4, 2.2)).toBe(true)
    expect(supportCueTiltRequiresRetry(5.1, 0.2)).toBe(true)
  })
})

describe('CIEDE2000 implementation', () => {
  it('matches the Sharma-Wu-Dalal supplementary reference pairs', () => {
    expect(deltaE2000([50, 2.6772, -79.7751], [50, 0, -82.7485])).toBeCloseTo(2.0425, 4)
    expect(deltaE2000([50, 3.1571, -77.2803], [50, 0, -82.7485])).toBeCloseTo(2.8615, 4)
    expect(deltaE2000([50, 2.8361, -74.0200], [50, 0, -82.7485])).toBeCloseTo(3.4412, 4)
  })
})
