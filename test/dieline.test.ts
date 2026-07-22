import { createHash } from 'node:crypto'

import sharp from 'sharp'
import { describe, expect, it } from 'vitest'

import {
  compileDielineEdit,
  evaluateDielineQa,
  prepareDieline,
  qaDielineResult,
  type DielineRequest,
} from '../src/dieline.js'

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

const request: DielineRequest = {
  originalPrompt: 'Render one paper package. The upper section is green.',
  dielineImage: {
    description: 'Orthographic drawing with one closed silhouette.',
  },
  supportReferences: [
    {
      id: 'lighting',
      kind: 'support',
      url: 'https://example.test/lighting.png',
      description: 'Neutral studio photograph.',
      role: 'Depth, scale and studio lighting only.',
    },
  ],
}

describe('dieline lane', () => {
  it('pads at native size, integer-upscales, and keeps the mask QA-only', async () => {
    const prepared = await prepareDieline(await rectangleDrawing(), { finalSize: 16 })
    expect(prepared.metadata.sourceSize).toEqual([8, 4])
    expect(prepared.metadata.nativeSquareSize).toBe(8)
    expect(prepared.metadata.sourceOffsetInNativeSquare).toEqual([0, 2])
    expect(prepared.metadata.integerScale).toBe(2)
    expect(prepared.metadata.targetBbox).toEqual([2, 4, 14, 12])
    expect(prepared.metadata.targetRatio).toBe(1.5)
    expect(prepared.metadata.modelInputs).toEqual(['paddedDrawing'])
    expect(prepared.metadata.qaOnlyAssets).toEqual(['silhouetteMask'])
    const raw = await sharp(prepared.paddedDrawing).removeAlpha().raw().toBuffer()
    expect(createHash('sha256').update(raw).digest('hex')).toBe(
      '7f553c88ccd527c79959dfbab3dcf7c4e0880df1d5e863ab0a8588c7e79e46d5',
    )
  })

  it('preserves the original prompt and puts the padded drawing in the dedicated first slot', async () => {
    const prepared = await prepareDieline(await rectangleDrawing(), { finalSize: 16 })
    const compiled = compileDielineEdit({
      request,
      metadata: prepared.metadata,
      paddedDrawingUrl: 'https://example.test/padded.png',
    })
    expect(compiled.prompt.startsWith(request.originalPrompt)).toBe(true)
    expect(compiled.imageInput).toEqual([
      'https://example.test/padded.png',
      request.supportReferences?.[0].url,
    ])
    expect(compiled.references[0]).toMatchObject({
      id: 'dieline-image',
      kind: 'geometry',
      url: 'https://example.test/padded.png',
    })
    expect(compiled.prompt).toContain('Use IMAGE 1 as the edit canvas and sole geometry authority')
    expect(compiled.prompt).toContain('width=12px, height=8px, W/H=1.500000000000')
    expect(compiled.prompt).not.toMatch(/jar|chrome|opal|closure/i)
  })

  it('keeps raw output separate and creates overlay/geometry QA', async () => {
    const prepared = await prepareDieline(await rectangleDrawing(), { finalSize: 16 })
    const mask = await sharp(prepared.silhouetteMask).greyscale().raw().toBuffer({ resolveWithObject: true })
    const rgb = Buffer.alloc(mask.info.width * mask.info.height * 3, 255)
    for (let index = 0; index < mask.info.width * mask.info.height; index += 1) {
      if (mask.data[index] === 0) continue
      rgb[index * 3] = 80
      rgb[index * 3 + 1] = 80
      rgb[index * 3 + 2] = 80
    }
    const rawResult = await sharp(rgb, {
      raw: { width: mask.info.width, height: mask.info.height, channels: 3 },
    }).png().toBuffer()
    const rawBefore = Buffer.from(rawResult)
    const qa = await qaDielineResult(rawResult, prepared)
    expect(rawResult.equals(rawBefore)).toBe(true)
    expect(qa.overlay.equals(rawResult)).toBe(false)
    expect(qa.report.pixelModification).toBe('none')
    expect(qa.report.rawRatioErrorPercent).toBe(0)
    expect(qa.report.silhouetteIou).toBe(1)
    expect(qa.report.outsideDriftPixels).toBe(0)
    expect(evaluateDielineQa(qa.report)).toMatchObject({
      accepted: true,
      retryRecommended: false,
    })
    expect(evaluateDielineQa({ ...qa.report, silhouetteIou: 0.8 })).toMatchObject({
      accepted: false,
      retryRecommended: true,
    })
  })
})
