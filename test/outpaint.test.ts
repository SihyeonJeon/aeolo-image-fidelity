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

async function canonicalCutout(): Promise<Buffer> {
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="160" height="240">
    <defs><linearGradient id="body" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#1550aa"/><stop offset="1" stop-color="#06245d"/></linearGradient></defs>
    <rect x="35" y="20" width="90" height="200" rx="9" fill="url(#body)"/>
    <rect x="48" y="76" width="64" height="34" fill="#eafcff"/>
    <path d="M52 84h55M52 92h50M52 100h44" stroke="#092b62" stroke-width="3"/>
  </svg>`)
  return sharp(svg).png().toBuffer()
}

async function prepareOutpaint(
  store: MemoryStore,
  resolution?: '1K' | '2K',
  maxRawBoundaryOffsetPx?: number,
) {
  return prepareGeneration({
    mode: 'outpaint',
    originalPrompt: 'Create a crisp mineral spa still life with a pale stone support and no bokeh.',
    canonicalCutout: {
      source: await canonicalCutout(),
      description: 'Front-view compact packaged product in its canonical closed state.',
      role: 'Locked canonical foreground geometry, color, label and edge pixels.',
    },
    size: { mode: 'measured', physicalHeightCm: 10 },
    resolution,
    placement: {
      heightFraction: 0.38,
      centerXFraction: 0.52,
      contactYFraction: 0.71,
      maxRawBoundaryOffsetPx,
    },
  }, store)
}

describe('outpaint lane', () => {
  it('prepositions the canonical product on the tested 2K canvas and restores exact opaque pixels', async () => {
    const store = new MemoryStore()
    const prepared = await prepareOutpaint(store)
    expect(prepared.providerRequest.input.resolution).toBe('2K')
    expect(prepared.providerRequest.input.aspect_ratio).toBe('16:9')
    expect(prepared.providerRequest.input.image_input[0]).toMatch(/^memory:\/\/outpaint-model-input\//)
    expect(prepared.providerRequest.input.prompt).toContain('OUTPAINT AND REPLACE ONLY THE PURE-WHITE AREA')
    expect(prepared.providerRequest.input.prompt).toContain('Create a crisp mineral spa still life')
    expect(prepared.providerRequest.input.prompt).toContain('10.0 cm tall')
    expect(prepared.providerRequest.input.prompt).toContain('FOCUS CONTRACT')
    if (prepared.state.mode !== 'outpaint') throw new Error('expected outpaint state')
    expect(prepared.state.placement.canvas).toEqual({ width: 2752, height: 1536 })
    expect(prepared.state.placement.heightFraction).toBeCloseTo(0.38, 2)
    expect(prepared.state.placement.y + prepared.state.placement.height).toBe(prepared.state.placement.contactY)
    expect(Math.abs(prepared.state.placement.widthHeightRatioErrorPercent)).toBeLessThan(0.1)

    const rawResult = await store.get(prepared.state.modelInputCanvasUrl)
    const finalized = await finalizeGeneration({ rawResult, state: prepared.state, assetStore: store })
    expect(finalized.rawResult.equals(rawResult)).toBe(true)
    expect(finalized.outpaintedResult).toBeDefined()
    expect(finalized.outpaintReport?.finalOpaqueCoreDifference?.changedOpaquePixelCount).toBe(0)
    expect(finalized.outpaintReport?.finalOpaqueCoreDifference?.maxAbsoluteRgbDifference).toBe(0)
    expect(finalized.outpaintReport?.silhouetteIouAgainstPlacedCanonical).toBe(1)
    expect(finalized.outpaintReport?.rawBoundaryRegistration?.distancePx).toBeLessThanOrEqual(4)
    expect(finalized.outpaintAcceptance?.accepted).toBe(true)
  })

  it('uses the provider scene and shadow but overwrites a provider-redrawn product with the exact canonical layer', async () => {
    const store = new MemoryStore()
    const prepared = await prepareOutpaint(store, '1K')
    if (prepared.state.mode !== 'outpaint') throw new Error('expected outpaint state')
    const placement = prepared.state.placement
    const canonicalLayer = await store.get(prepared.state.canonicalLayerUrl)
    const redrawnLayer = await sharp(canonicalLayer).linear(0.78, 16).png().toBuffer()
    const rawResult = await sharp({
      create: { ...placement.canvas, channels: 3, background: '#d8d1c5' },
    }).composite([{ input: redrawnLayer, left: placement.x, top: placement.y }]).png().toBuffer()

    const finalized = await finalizeGeneration({ rawResult, state: prepared.state, assetStore: store })
    expect(finalized.outpaintReport?.rawForegroundDifference?.changedOpaquePixelCount).toBeGreaterThan(0)
    expect(finalized.outpaintReport?.warnings).toContain('provider_raw_redrew_foreground_pixels_reoverlay_required')
    expect(finalized.outpaintReport?.finalOpaqueCoreDifference?.changedOpaquePixelCount).toBe(0)
    expect(finalized.outpaintReport?.finalOpaqueCoreDifference?.maxAbsoluteRgbDifference).toBe(0)
    expect(finalized.outpaintAcceptance?.accepted).toBe(true)
  })

  it('optionally applies the shared Delta-E-bounded ambient adapter without changing alpha or final geometry', async () => {
    const store = new MemoryStore()
    const prepared = await prepareGeneration({
      mode: 'outpaint',
      originalPrompt: 'Create a warm stone spa scene with a level support surface.',
      canonicalCutout: {
        source: await canonicalCutout(),
        description: 'Front-view compact packaged product in its canonical closed state.',
        role: 'Locked canonical geometry, label and edge pixels with bounded ambient RGB adaptation allowed.',
      },
      size: { mode: 'measured', physicalHeightCm: 10 },
      resolution: '1K',
      color: { mode: 'ambient', strength: 1, maxMeanDeltaE2000: 2, maxP95DeltaE2000: 3.5 },
    }, store)
    if (prepared.state.mode !== 'outpaint') throw new Error('expected outpaint state')
    expect(prepared.state.colorPolicy?.mode).toBe('ambient')
    const placement = prepared.state.placement
    const canonicalLayer = await store.get(prepared.state.canonicalLayerUrl)
    const rawResult = await sharp({
      create: { ...placement.canvas, channels: 3, background: '#dbc8b0' },
    }).composite([{ input: canonicalLayer, left: placement.x, top: placement.y }]).png().toBuffer()

    const finalized = await finalizeGeneration({ rawResult, state: prepared.state, assetStore: store })
    const color = finalized.outpaintReport?.color
    expect(color?.policy.mode).toBe('ambient')
    expect(color?.appliedStrength).toBeGreaterThan(0)
    expect(color?.detailProtectedPixelCount).toBeGreaterThan(0)
    expect(color?.alphaChangedPixelCount).toBe(0)
    expect(color?.intendedChangeFromCanonical.meanDeltaE2000).toBeGreaterThan(0)
    expect(color?.intendedChangeFromCanonical.meanDeltaE2000).toBeLessThanOrEqual(2)
    expect(color?.intendedChangeFromCanonical.p95DeltaE2000).toBeLessThanOrEqual(3.5)
    expect(finalized.outpaintReport?.finalOpaqueCoreDifference?.changedOpaquePixelCount).toBe(0)
    expect(finalized.outpaintReport?.finalOpaqueCoreDifference?.maxAbsoluteRgbDifference).toBe(0)
    expect(finalized.outpaintAcceptance?.accepted).toBe(true)
  })

  it('rejects a provider result whose redrawn foreground boundary moved beyond the stored placement tolerance', async () => {
    const store = new MemoryStore()
    const prepared = await prepareOutpaint(store, '1K', 2)
    if (prepared.state.mode !== 'outpaint') throw new Error('expected outpaint state')
    const placement = prepared.state.placement
    const canonicalLayer = await store.get(prepared.state.canonicalLayerUrl)
    const rawResult = await sharp({
      create: { ...placement.canvas, channels: 3, background: '#ded6ca' },
    }).composite([{ input: canonicalLayer, left: placement.x + 7, top: placement.y }]).png().toBuffer()

    const finalized = await finalizeGeneration({ rawResult, state: prepared.state, assetStore: store })
    expect(finalized.outpaintReport?.rawBoundaryRegistration?.dx).toBeGreaterThanOrEqual(6)
    expect(finalized.outpaintAcceptance?.accepted).toBe(false)
    expect(finalized.outpaintAcceptance?.retryRecommended).toBe(true)
    expect(finalized.outpaintAcceptance?.reasons).toContain('provider_raw_foreground_boundary_shifted')
  })

  it('rejects provider output dimensions that do not match the saved canvas contract', async () => {
    const store = new MemoryStore()
    const prepared = await prepareOutpaint(store, '1K')
    const wrongSize = await sharp({
      create: { width: 640, height: 640, channels: 3, background: '#ffffff' },
    }).png().toBuffer()
    const finalized = await finalizeGeneration({ rawResult: wrongSize, state: prepared.state, assetStore: store })
    expect(finalized.outpaintedResult).toBeUndefined()
    expect(finalized.outpaintAcceptance).toEqual({
      accepted: false,
      retryRecommended: true,
      reasons: ['provider_canvas_dimensions_changed'],
    })
  })
})
