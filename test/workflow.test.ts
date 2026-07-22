import sharp from 'sharp'
import { describe, expect, it } from 'vitest'

import {
  finalizeGeneration,
  prepareGeneration,
  type BinaryAssetStore,
} from '../src/workflow.js'

class MemoryStore implements BinaryAssetStore {
  private readonly values = new Map<string, Buffer>()
  private counter = 0

  async put(input: Parameters<BinaryAssetStore['put']>[0]) {
    this.counter += 1
    const url = `memory://${input.purpose}/${this.counter}`
    this.values.set(url, Buffer.from(input.data))
    return { url }
  }

  async get(url: string) {
    const value = this.values.get(url)
    if (!value) throw new Error(`missing asset: ${url}`)
    return Buffer.from(value)
  }
}

async function rectangleDrawing(): Promise<Buffer> {
  const width = 8
  const height = 4
  const rgb = Buffer.alloc(width * height * 3, 255)
  const black = (x: number, y: number) => {
    const offset = (y * width + x) * 3
    rgb[offset] = 0
    rgb[offset + 1] = 0
    rgb[offset + 2] = 0
  }
  for (let x = 1; x <= 6; x += 1) {
    black(x, 0)
    black(x, 3)
  }
  for (let y = 0; y <= 3; y += 1) {
    black(1, y)
    black(6, y)
  }
  return sharp(rgb, { raw: { width, height, channels: 3 } }).png().toBuffer()
}

async function canonicalCutout(): Promise<Buffer> {
  const width = 80
  const height = 120
  const rgba = Buffer.alloc(width * height * 4)
  for (let y = 10; y < 110; y += 1) {
    for (let x = 20; x < 60; x += 1) {
      const offset = (y * width + x) * 4
      rgba[offset] = 20 + Math.round((110 - y) * 0.4 + (60 - x) * 0.3)
      rgba[offset + 1] = 55 + Math.round((110 - y) * 0.3 + (60 - x) * 0.25)
      rgba[offset + 2] = 130 + Math.round((110 - y) * 0.5 + (60 - x) * 0.35)
      rgba[offset + 3] = 255
    }
  }
  return sharp(rgba, { raw: { width, height, channels: 4 } }).png().toBuffer()
}

async function labeledCanonicalCutout(): Promise<Buffer> {
  const base = await sharp(await canonicalCutout()).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  for (let y = 42; y < 62; y += 1) {
    for (let x = 28; x < 52; x += 1) {
      if (y > 45 && y < 50 && x > 32 && x < 48) continue
      const offset = (y * base.info.width + x) * base.info.channels
      base.data[offset] = 244
      base.data[offset + 1] = 246
      base.data[offset + 2] = 242
    }
  }
  return sharp(base.data, {
    raw: { width: base.info.width, height: base.info.height, channels: base.info.channels },
  }).png().toBuffer()
}

async function backgroundPlate(): Promise<Buffer> {
  const width = 640
  const height = 360
  const rgb = Buffer.alloc(width * height * 3)
  for (let y = 0; y < height; y += 1) {
    const color = y < 220 ? [245, 242, 236] : y < 275 ? [218, 205, 184] : [185, 169, 145]
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3
      rgb[offset] = color[0]
      rgb[offset + 1] = color[1]
      rgb[offset + 2] = color[2]
    }
  }
  return sharp(rgb, { raw: { width, height, channels: 3 } }).png().toBuffer()
}

async function localizedPodiumPlate(): Promise<Buffer> {
  const width = 640
  const height = 360
  const rgb = Buffer.alloc(width * height * 3)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const onPodium = x >= 270 && x < 395 && y >= 210
      const color = !onPodium ? [245, 242, 236] : y < 270 ? [218, 205, 184] : [185, 169, 145]
      const offset = (y * width + x) * 3
      rgb[offset] = color[0]
      rgb[offset + 1] = color[1]
      rgb[offset + 2] = color[2]
    }
  }
  return sharp(rgb, { raw: { width, height, channels: 3 } }).png().toBuffer()
}

async function topDownPlate(): Promise<Buffer> {
  const width = 640
  const height = 360
  const rgb = Buffer.alloc(width * height * 3)
  for (let y = 0; y < height; y += 1) {
    const color = y < 180 ? [245, 242, 236] : y < 300 ? [218, 205, 184] : [185, 169, 145]
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3
      rgb[offset] = color[0]
      rgb[offset + 1] = color[1]
      rgb[offset + 2] = color[2]
    }
  }
  return sharp(rgb, { raw: { width, height, channels: 3 } }).png().toBuffer()
}

async function thickShelfPlate(): Promise<Buffer> {
  const width = 640
  const height = 360
  const rgb = Buffer.alloc(width * height * 3)
  for (let y = 0; y < height; y += 1) {
    const color = y < 200 ? [242, 239, 232] : y < 230 ? [222, 214, 201] : y < 270 ? [174, 162, 145] : [112, 103, 91]
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3
      rgb[offset] = color[0]
      rgb[offset + 1] = color[1]
      rgb[offset + 2] = color[2]
    }
  }
  return sharp(rgb, { raw: { width, height, channels: 3 } }).png().toBuffer()
}

async function backsplashShelfPlate(): Promise<Buffer> {
  const width = 640
  const height = 360
  const rgb = Buffer.alloc(width * height * 3)
  for (let y = 0; y < height; y += 1) {
    const color = y < 175
      ? [242, 239, 232]
      : y < 235
        ? [220, 211, 198]
        : y < 255
          ? [238, 232, 221]
          : y < 280
            ? [176, 163, 144]
            : [113, 103, 91]
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3
      rgb[offset] = color[0]
      rgb[offset + 1] = color[1]
      rgb[offset + 2] = color[2]
    }
  }
  return sharp(rgb, { raw: { width, height, channels: 3 } }).png().toBuffer()
}

describe('workflow adapter', () => {
  it('routes general and swap modes to existing Aeolo dispatch targets', async () => {
    const store = new MemoryStore()
    const general = await prepareGeneration({
      mode: 'generate',
      originalPrompt: 'Create a product still life.',
      references: [{
        id: 'product',
        kind: 'product',
        url: 'https://example.test/product.png',
        description: 'Canonical product reference.',
        role: 'Shape, color and label only.',
      }],
    }, store)
    expect(general.dispatchTarget).toBe('visual-generation')
    expect(general.providerRequest.input.image_input).toEqual(['https://example.test/product.png'])

    const swap = await prepareGeneration({
      mode: 'swap',
      originalPrompt: 'Show the canonical closed product replacing the scene object.',
      productStateInstruction: 'The product is fully assembled and closed.',
      references: [
        {
          id: 'scene',
          kind: 'scene',
          url: 'https://example.test/scene.png',
          description: 'Scene reference.',
          role: 'Scene and lighting only.',
        },
        {
          id: 'product',
          kind: 'product',
          url: 'https://example.test/product.png',
          description: 'Canonical product.',
          role: 'Product form and identity only.',
        },
      ],
    }, store)
    expect(swap.dispatchTarget).toBe('thumbnail-swap')
    expect(swap.providerRequest.input.aspect_ratio).toBe('16:9')
    expect(swap.providerRequest.input.resolution).toBe('1K')
  })

  it('prepares a serializable dieline job and finalizes QA after callback', async () => {
    const store = new MemoryStore()
    const prepared = await prepareGeneration({
      mode: 'dieline',
      originalPrompt: 'Render one dark paper package.',
      dielineImage: {
        source: await rectangleDrawing(),
        description: 'Closed orthographic drawing.',
      },
      finalSize: 16,
      supportReferences: [
        {
          id: 'lighting',
          kind: 'support',
          url: 'https://example.test/light.png',
          description: 'Studio reference.',
          role: 'Depth and lighting only.',
        },
      ],
    }, store)
    expect(prepared.dispatchTarget).toBe('visual-generation')
    expect(prepared.providerRequest.input.aspect_ratio).toBe('1:1')
    expect(prepared.providerRequest.input.resolution).toBe('2K')
    expect(prepared.providerRequest.input.image_input[0]).toMatch(/^memory:\/\/dieline-model-input\//)
    expect(prepared.providerRequest.input.image_input[1]).toBe('https://example.test/light.png')
    expect(JSON.parse(JSON.stringify(prepared.state))).toEqual(prepared.state)
    expect(prepared.state.mode).toBe('dieline')
    if (prepared.state.mode !== 'dieline') throw new Error('expected dieline state')
    expect(prepared.providerRequest.input.image_input).not.toContain(prepared.state.silhouetteMaskUrl)

    const mask = await store.get(prepared.state.silhouetteMaskUrl)
    const rawMask = await sharp(mask).greyscale().raw().toBuffer({ resolveWithObject: true })
    const rgb = Buffer.alloc(rawMask.info.width * rawMask.info.height * 3, 255)
    for (let index = 0; index < rawMask.info.width * rawMask.info.height; index += 1) {
      if (rawMask.data[index] === 0) continue
      rgb[index * 3] = 80
      rgb[index * 3 + 1] = 80
      rgb[index * 3 + 2] = 80
    }
    const rawResult = await sharp(rgb, {
      raw: { width: rawMask.info.width, height: rawMask.info.height, channels: 3 },
    }).png().toBuffer()
    const finalized = await finalizeGeneration({ rawResult, state: prepared.state, assetStore: store })
    expect(finalized.rawResult.equals(rawResult)).toBe(true)
    expect(finalized.qaOverlay).toBeDefined()
    expect(finalized.qaReport?.silhouetteIou).toBe(1)
    expect(finalized.qaAcceptance?.accepted).toBe(true)
    expect(finalized.qaAcceptance?.retryRecommended).toBe(false)
  })

  it('generates only an empty plate and deterministically composites canonical cutout pixels', async () => {
    const store = new MemoryStore()
    const prepared = await prepareGeneration({
      mode: 'composite',
      originalPrompt: 'Create a bright editorial still life.',
      canonicalCutout: {
        source: await canonicalCutout(),
        description: 'Front-view compact packaged product.',
        role: 'Local-only canonical foreground geometry, color and label pixels; never send to the generator.',
      },
      size: { mode: 'measured', physicalHeightCm: 10 },
    }, store)
    expect(prepared.dispatchTarget).toBe('visual-generation')
    expect(prepared.providerRequest.input.image_input).toEqual([])
    expect(prepared.providerRequest.input.prompt).toContain('Create only an EMPTY photorealistic 16:9 background plate')
    expect(prepared.providerRequest.input.prompt).toContain('no hard-edged cast shadows')
    expect(prepared.providerRequest.input.prompt).toContain('FOCUS CONTRACT')
    expect(prepared.providerRequest.input.prompt).toContain('No bokeh')
    expect(prepared.providerRequest.input.prompt).toContain('DEPTH-SAFE STAGING CONTRACT')
    expect(prepared.providerRequest.input.prompt).toContain('Do not rely on post-generation sharpening or deblurring')
    expect(prepared.providerRequest.input.prompt).toContain('future foreground is 25% of frame height')
    expect(prepared.state.mode).toBe('composite')
    if (prepared.state.mode !== 'composite') throw new Error('expected composite state')
    expect(prepared.state.analysis.lighting.direction).toBe('upper_left')
    const plate = await backgroundPlate()
    const finalized = await finalizeGeneration({ rawResult: plate, state: prepared.state, assetStore: store })
    expect(finalized.rawResult.equals(plate)).toBe(true)
    expect(finalized.compositedResult).toBeDefined()
    expect(finalized.compositeReport?.opaqueCore.maxAbsoluteRgbDiff).toBe(0)
    expect(finalized.compositeReport?.opaqueCore.maxDeltaE2000).toBe(0)
    expect(finalized.compositeReport?.backgroundLighting.sampleSize).toEqual({ width: 160, height: 90 })
    expect(finalized.compositeReport?.lightingCompatibility.passed).toBe(true)
    expect(finalized.compositeReport?.shadowProfile.hardnessBlend).toBeGreaterThanOrEqual(0)
    expect(finalized.compositeReport?.shadowProfile.occlusionCoreOpacity).toBeGreaterThan(0)
    expect(finalized.compositeReport?.projectedHeightFraction).toBeCloseTo(0.25, 2)
    expect(Math.abs(finalized.compositeReport?.widthHeightRatioErrorPercent ?? Infinity)).toBeLessThan(0.1)
    expect(finalized.compositeAcceptance).toEqual({ accepted: true, retryRecommended: false, reasons: [] })
  })

  it('keeps geometry exact while applying an explicit Delta-E-bounded ambient color transform', async () => {
    const store = new MemoryStore()
    const prepared = await prepareGeneration({
      mode: 'composite',
      originalPrompt: 'Create a warm editorial still life.',
      canonicalCutout: {
        source: await labeledCanonicalCutout(),
        description: 'Front-view compact packaged product.',
        role: 'Local-only canonical foreground geometry and label pixels.',
      },
      size: { mode: 'measured', physicalHeightCm: 10 },
      color: { mode: 'ambient', strength: 0.5, maxMeanDeltaE2000: 1.5, maxP95DeltaE2000: 2.5 },
    }, store)
    if (prepared.state.mode !== 'composite') throw new Error('expected composite state')
    expect(prepared.state.colorPolicy?.mode).toBe('ambient')
    const finalized = await finalizeGeneration({
      rawResult: await backgroundPlate(),
      state: prepared.state,
      assetStore: store,
    })
    const report = finalized.compositeReport
    expect(report?.color.policy.mode).toBe('ambient')
    expect(report?.color.appliedStrength).toBeGreaterThan(0)
    expect(report?.color.detailProtectedPixelCount).toBeGreaterThan(0)
    expect(report?.color.alphaChangedPixelCount).toBe(0)
    expect(report?.color.intendedChangeFromCanonical.meanDeltaE2000).toBeGreaterThan(0)
    expect(report?.color.intendedChangeFromCanonical.meanDeltaE2000).toBeLessThanOrEqual(1.5)
    expect(report?.color.intendedChangeFromCanonical.p95DeltaE2000).toBeLessThanOrEqual(2.5)
    expect(report?.opaqueCore.maxAbsoluteRgbDiff).toBe(0)
    expect(report?.opaqueCore.maxDeltaE2000).toBe(0)
    expect(Math.abs(report?.widthHeightRatioErrorPercent ?? Infinity)).toBeLessThan(0.1)
    expect(finalized.compositeAcceptance?.accepted, JSON.stringify(report, null, 2)).toBe(true)
  })

  it('finds a localized central podium without requiring a full-width horizontal ledge', async () => {
    const store = new MemoryStore()
    const prepared = await prepareGeneration({
      mode: 'composite',
      originalPrompt: 'Create a bright editorial still life on a small central podium.',
      canonicalCutout: {
        source: await canonicalCutout(),
        description: 'Front-view compact packaged product.',
        role: 'Local-only canonical foreground pixels; never send to the generator.',
      },
      size: { mode: 'measured', physicalHeightCm: 10 },
    }, store)
    if (prepared.state.mode !== 'composite') throw new Error('expected composite state')
    const finalized = await finalizeGeneration({
      rawResult: await localizedPodiumPlate(),
      state: prepared.state,
      assetStore: store,
    })
    expect(finalized.compositeReport?.supportPlane.confidence).toBe('high')
    expect(finalized.compositeReport?.supportPlane.analysisWindow.widthFraction).toBeLessThanOrEqual(0.34)
    expect(finalized.compositeAcceptance?.accepted, JSON.stringify(finalized.compositeReport, null, 2)).toBe(true)
    expect(finalized.compositeReport?.opaqueCore.maxDeltaE2000).toBe(0)
  })

  it('lands on the upper pair of a three-edge thick shelf instead of its lower fascia', async () => {
    const store = new MemoryStore()
    const prepared = await prepareGeneration({
      mode: 'composite',
      originalPrompt: 'Create a quiet studio still life.',
      canonicalCutout: {
        source: await canonicalCutout(),
        description: 'Front-view compact packaged product.',
        role: 'Local-only canonical foreground geometry and label pixels.',
      },
      size: { mode: 'measured', physicalHeightCm: 10 },
    }, store)
    if (prepared.state.mode !== 'composite') throw new Error('expected composite state')
    const finalized = await finalizeGeneration({
      rawResult: await thickShelfPlate(),
      state: prepared.state,
      assetStore: store,
    })
    expect(finalized.compositeReport?.supportPlane.method).toContain('upper_surface_from_three_edge_slab')
    expect(finalized.compositeReport?.supportPlane.backY).toBeCloseTo(200, -1)
    expect(finalized.compositeReport?.supportPlane.frontY).toBeCloseTo(230, -1)
    expect(finalized.compositeReport?.placementBottomMatchesContact).toBe(true)
    expect(finalized.compositeAcceptance?.accepted, JSON.stringify(finalized.compositeReport, null, 2)).toBe(true)
  })

  it('does not mistake a backsplash band for the support top', async () => {
    const store = new MemoryStore()
    const prepared = await prepareGeneration({
      mode: 'composite',
      originalPrompt: 'Create a quiet kitchen still life with a shallow shelf.',
      canonicalCutout: {
        source: await canonicalCutout(),
        description: 'Front-view compact packaged product.',
        role: 'Local-only canonical foreground geometry and label pixels.',
      },
      size: { mode: 'measured', physicalHeightCm: 10 },
    }, store)
    if (prepared.state.mode !== 'composite') throw new Error('expected composite state')
    const finalized = await finalizeGeneration({
      rawResult: await backsplashShelfPlate(),
      state: prepared.state,
      assetStore: store,
    })
    expect(finalized.compositeReport?.supportPlane.method).toContain('upper_surface_from_three_edge_slab')
    expect(finalized.compositeReport?.supportPlane.backY).toBeCloseTo(235, -1)
    expect(finalized.compositeReport?.supportPlane.frontY).toBeCloseTo(255, -1)
    expect(finalized.compositeReport?.placementBottomMatchesContact).toBe(true)
    expect(finalized.compositeAcceptance?.accepted, JSON.stringify(finalized.compositeReport, null, 2)).toBe(true)
  })

  it('returns an explicit retry decision for an incompatible top-down plate', async () => {
    const store = new MemoryStore()
    const prepared = await prepareGeneration({
      mode: 'composite',
      originalPrompt: 'Create a product still life.',
      canonicalCutout: {
        source: await canonicalCutout(),
        description: 'Front-view compact packaged product.',
        role: 'Local-only canonical foreground pixels; never send to the generator.',
      },
      size: { mode: 'measured', physicalHeightCm: 10 },
    }, store)
    if (prepared.state.mode !== 'composite') throw new Error('expected composite state')
    const finalized = await finalizeGeneration({
      rawResult: await topDownPlate(),
      state: prepared.state,
      assetStore: store,
    })
    expect(finalized.compositeAcceptance?.accepted).toBe(false)
    expect(finalized.compositeAcceptance?.retryRecommended).toBe(true)
    expect(finalized.compositeAcceptance?.reasons).toContain('support_plane_reads_too_top_down')
  })

  it('rejects a geometry-like reference sent through the general reference slot at runtime', async () => {
    const store = new MemoryStore()
    await expect(prepareGeneration({
      mode: 'generate',
      originalPrompt: 'Render this.',
      references: [{
        id: 'drawing',
        kind: 'geometry',
        url: 'https://example.test/drawing.png',
        description: 'Drawing.',
        role: 'Geometry.',
      }] as never,
    }, store)).rejects.toThrow('unsupported reference kind: geometry')
  })
})
