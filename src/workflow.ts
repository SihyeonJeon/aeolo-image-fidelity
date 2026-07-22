import {
  analyzeCanonicalCutout,
  compileEmptyPlatePrompt,
  compositeCanonicalCutout,
  resolveCompositeColorPolicy,
  resolveCompositeFraming,
  resolveCompositeSize,
  type CompositeFramingProfile,
  type CompositeColorPolicy,
  type CompositeQaAcceptance,
  type CompositeQaReport,
  type CompositeRequest,
  type ResolvedCompositeColorPolicy,
  type CompositeSizeInput,
  type CompositeSizeResolution,
  type CutoutAnalysis,
} from './composite.js'
import {
  compileDielineEdit,
  evaluateDielineQa,
  prepareDieline,
  qaDielineResult,
  type DielineImageSlot,
  type DielineAcceptanceCriteria,
  type DielineQaAcceptance,
  type DielinePreparationMetadata,
  type DielineQaReport,
  type DielineSupportReference,
  type PreparedDieline,
} from './dieline.js'
import {
  compileOutpaintPrompt,
  finalizeOutpaint,
  prepareOutpaintCanvas,
  type OutpaintPlacementInput,
  type OutpaintQaAcceptance,
  type OutpaintQaReport,
  type OutpaintResolution,
  type ResolvedOutpaintPlacement,
} from './outpaint.js'
import {
  compileReferencePrompt,
  compileSwapPrompt,
  type ImageReferenceRole,
} from './reference-roles.js'

export type ImageFidelityMode = 'generate' | 'swap' | 'composite' | 'outpaint' | 'dieline'
export type DispatchTarget = 'visual-generation' | 'thumbnail-swap'

export interface ProviderImageRequest {
  model: string
  input: {
    prompt: string
    image_input: string[]
    aspect_ratio: string
    resolution: string
    output_format: 'png'
  }
}

export interface StoredBinaryAsset {
  url: string
}

export interface BinaryAssetStore {
  put(input: {
    purpose:
      | 'composite-canonical-cutout'
      | 'outpaint-model-input'
      | 'outpaint-canonical-layer'
      | 'dieline-model-input'
      | 'dieline-qa-mask'
    contentType: 'image/png'
    data: Buffer
  }): Promise<StoredBinaryAsset>
  get(url: string): Promise<Buffer>
}

interface CommonGenerationInput {
  model?: string
  aspectRatio?: string
  resolution?: string
}

export interface PrepareGeneralGenerationInput extends CommonGenerationInput {
  mode: 'generate'
  originalPrompt: string
  references: ImageReferenceRole[]
  instruction?: string
}

export interface PrepareSwapGenerationInput {
  mode: 'swap'
  originalPrompt: string
  references: ImageReferenceRole[]
  productStateInstruction: string
}

export interface PrepareDielineGenerationInput {
  mode: 'dieline'
  originalPrompt: string
  /** Dedicated drawing slot. It is always padded and sent as IMAGE 1. */
  dielineImage: DielineImageSlot & { source: Buffer }
  /** Optional non-geometry references, sent after the drawing. */
  supportReferences?: DielineSupportReference[]
  finalSize?: number
}

export interface PrepareCompositeGenerationInput extends CompositeRequest {
  mode: 'composite'
  /** Canonical RGBA pixels. This is stored for callback use and never sent to KIE. */
  canonicalCutout: CompositeRequest['canonicalCutout'] & { source: Buffer }
}

export interface PrepareOutpaintGenerationInput {
  mode: 'outpaint'
  originalPrompt: string
  /** Canonical RGBA pixels. They are pre-positioned for KIE and stored again for exact callback re-overlay. */
  canonicalCutout: CompositeRequest['canonicalCutout'] & { source: Buffer }
  size: CompositeSizeInput
  /** 2K is the tested default. */
  resolution?: OutpaintResolution
  placement?: OutpaintPlacementInput
  /** Strict is default; ambient applies the same bounded RGB-only adapter used by composite. */
  color?: CompositeColorPolicy
}

export type PrepareGenerationInput =
  | PrepareGeneralGenerationInput
  | PrepareSwapGenerationInput
  | PrepareCompositeGenerationInput
  | PrepareOutpaintGenerationInput
  | PrepareDielineGenerationInput

export interface BasicGenerationState {
  version: 1
  mode: 'generate' | 'swap'
}

export interface CompositeGenerationState {
  version: 1
  mode: 'composite'
  canonicalCutoutUrl: string
  analysis: CutoutAnalysis
  size: CompositeSizeResolution
  framing: CompositeFramingProfile
  /** Optional for backward compatibility with jobs prepared before color modes existed. */
  colorPolicy?: ResolvedCompositeColorPolicy
}

export interface OutpaintGenerationState {
  version: 1
  mode: 'outpaint'
  /** Exact white-canvas provider input, retained for provenance/debugging. */
  modelInputCanvasUrl: string
  /** Exact resized RGBA layer used before and after KIE. */
  canonicalLayerUrl: string
  analysis: CutoutAnalysis
  size: CompositeSizeResolution
  placement: ResolvedOutpaintPlacement
  /** Optional for jobs prepared before outpaint ambient support existed. */
  colorPolicy?: ResolvedCompositeColorPolicy
}

export interface DielineGenerationState {
  version: 1
  mode: 'dieline'
  paddedDrawingUrl: string
  silhouetteMaskUrl: string
  metadata: DielinePreparationMetadata
}

export type GenerationState =
  | BasicGenerationState
  | CompositeGenerationState
  | OutpaintGenerationState
  | DielineGenerationState

export interface PreparedGeneration {
  mode: ImageFidelityMode
  dispatchTarget: DispatchTarget
  providerRequest: ProviderImageRequest
  /** JSON-serializable state to persist on the async job until callback. */
  state: GenerationState
}

export interface FinalizeGenerationInput {
  rawResult: Buffer
  state: GenerationState
  assetStore: BinaryAssetStore
  threshold?: number
  acceptanceCriteria?: DielineAcceptanceCriteria
}

export interface FinalizedGeneration {
  /** Exact provider bytes. Persist this as the customer-facing raw result. */
  rawResult: Buffer
  /** Separate QA copy for composite, outpaint or dieline jobs; never replaces rawResult. */
  qaOverlay?: Buffer
  /** Present only for dieline jobs. */
  qaReport?: DielineQaReport
  /** Host should retry/fallback when this is present and accepted=false. */
  qaAcceptance?: DielineQaAcceptance
  /** Present only for composite jobs. Canonical cutout pixels over the empty provider plate. */
  compositedResult?: Buffer
  /** Present only for composite jobs. */
  compositeReport?: CompositeQaReport
  /** Host should retry the empty background plate when accepted=false. */
  compositeAcceptance?: CompositeQaAcceptance
  /** Present only for outpaint jobs. Exact canonical pixels re-overlaid over the provider result. */
  outpaintedResult?: Buffer
  /** Present only for outpaint jobs. */
  outpaintReport?: OutpaintQaReport
  /** Host should retry when provider dimensions or raw silhouette registration fail. */
  outpaintAcceptance?: OutpaintQaAcceptance
}

export async function prepareGeneration(
  input: PrepareGenerationInput,
  assetStore: BinaryAssetStore,
): Promise<PreparedGeneration> {
  if (input.mode === 'swap') {
    const compiled = compileSwapPrompt(input)
    return {
      mode: input.mode,
      dispatchTarget: 'thumbnail-swap',
      providerRequest: {
        model: 'nano-banana-pro',
        input: {
          prompt: compiled.prompt,
          image_input: compiled.imageInput,
          aspect_ratio: '16:9',
          resolution: '1K',
          output_format: 'png',
        },
      },
      state: { version: 1, mode: input.mode },
    }
  }

  if (input.mode === 'generate') {
    const compiled = compileReferencePrompt(input)
    return {
      mode: input.mode,
      dispatchTarget: 'visual-generation',
      providerRequest: {
        model: input.model ?? 'nano-banana-pro',
        input: {
          prompt: compiled.prompt,
          image_input: compiled.imageInput,
          aspect_ratio: input.aspectRatio ?? '16:9',
          resolution: input.resolution ?? '1K',
          output_format: 'png',
        },
      },
      state: { version: 1, mode: input.mode },
    }
  }

  if (input.mode === 'composite') {
    const description = input.canonicalCutout.description.trim()
    const role = input.canonicalCutout.role.trim()
    if (!input.originalPrompt.trim() || !description || !role) {
      throw new Error('composite originalPrompt, canonical description and role must not be empty')
    }
    const [analysis, cutoutAsset] = await Promise.all([
      analyzeCanonicalCutout(input.canonicalCutout.source, description),
      assetStore.put({
        purpose: 'composite-canonical-cutout',
        contentType: 'image/png',
        data: input.canonicalCutout.source,
      }),
    ])
    const size = resolveCompositeSize(input.size, description)
    const framing = resolveCompositeFraming(input.framing)
    const colorPolicy = resolveCompositeColorPolicy(input.color)
    const prompt = compileEmptyPlatePrompt({
      originalPrompt: input.originalPrompt,
      canonicalCutout: { description, role },
      size: input.size,
      framing: input.framing,
    }, analysis, size, framing)
    return {
      mode: input.mode,
      dispatchTarget: 'visual-generation',
      providerRequest: {
        model: 'nano-banana-pro',
        input: {
          prompt,
          image_input: [],
          aspect_ratio: '16:9',
          resolution: '1K',
          output_format: 'png',
        },
      },
      state: {
        version: 1,
        mode: input.mode,
        canonicalCutoutUrl: cutoutAsset.url,
        analysis,
        size,
        framing,
        colorPolicy,
      },
    }
  }

  if (input.mode === 'outpaint') {
    const description = input.canonicalCutout.description.trim()
    const role = input.canonicalCutout.role.trim()
    if (!input.originalPrompt.trim() || !description || !role) {
      throw new Error('outpaint originalPrompt, canonical description and role must not be empty')
    }
    const analysis = await analyzeCanonicalCutout(input.canonicalCutout.source, description)
    const size = resolveCompositeSize(input.size, description)
    const colorPolicy = resolveCompositeColorPolicy(input.color)
    const prepared = await prepareOutpaintCanvas(
      input.canonicalCutout.source,
      analysis,
      input.resolution ?? '2K',
      input.placement,
    )
    const [modelInputCanvasAsset, canonicalLayerAsset] = await Promise.all([
      assetStore.put({
        purpose: 'outpaint-model-input',
        contentType: 'image/png',
        data: prepared.inputCanvas,
      }),
      assetStore.put({
        purpose: 'outpaint-canonical-layer',
        contentType: 'image/png',
        data: prepared.canonicalLayer,
      }),
    ])
    const prompt = compileOutpaintPrompt({
      originalPrompt: input.originalPrompt,
      canonicalCutout: { description, role },
      size,
      resolution: input.resolution,
      placement: input.placement,
    }, analysis, prepared.placement)
    return {
      mode: input.mode,
      dispatchTarget: 'visual-generation',
      providerRequest: {
        model: 'nano-banana-pro',
        input: {
          prompt,
          image_input: [modelInputCanvasAsset.url],
          aspect_ratio: '16:9',
          resolution: prepared.placement.resolution,
          output_format: 'png',
        },
      },
      state: {
        version: 1,
        mode: input.mode,
        modelInputCanvasUrl: modelInputCanvasAsset.url,
        canonicalLayerUrl: canonicalLayerAsset.url,
        analysis,
        size,
        placement: prepared.placement,
        colorPolicy,
      },
    }
  }

  const prepared = await prepareDieline(input.dielineImage.source, { finalSize: input.finalSize })
  const [drawingAsset, maskAsset] = await Promise.all([
    assetStore.put({
      purpose: 'dieline-model-input',
      contentType: 'image/png',
      data: prepared.paddedDrawing,
    }),
    assetStore.put({
      purpose: 'dieline-qa-mask',
      contentType: 'image/png',
      data: prepared.silhouetteMask,
    }),
  ])
  const compiled = compileDielineEdit({
    request: {
      originalPrompt: input.originalPrompt,
      dielineImage: { description: input.dielineImage.description },
      supportReferences: input.supportReferences,
    },
    metadata: prepared.metadata,
    paddedDrawingUrl: drawingAsset.url,
  })
  return {
    mode: input.mode,
    dispatchTarget: 'visual-generation',
    providerRequest: {
      model: 'nano-banana-pro',
      input: {
        prompt: compiled.prompt,
        image_input: compiled.imageInput,
        aspect_ratio: '1:1',
        resolution: '2K',
        output_format: 'png',
      },
    },
    state: {
      version: 1,
      mode: input.mode,
      paddedDrawingUrl: drawingAsset.url,
      silhouetteMaskUrl: maskAsset.url,
      metadata: prepared.metadata,
    },
  }
}

export async function finalizeGeneration(input: FinalizeGenerationInput): Promise<FinalizedGeneration> {
  if (input.state.mode === 'generate' || input.state.mode === 'swap') return { rawResult: input.rawResult }
  if (input.state.mode === 'composite') {
    const cutout = await input.assetStore.get(input.state.canonicalCutoutUrl)
    const finalized = await compositeCanonicalCutout(
      input.rawResult,
      cutout,
      input.state.analysis,
      input.state.size,
      input.state.framing,
      input.state.colorPolicy ?? resolveCompositeColorPolicy(),
    )
    return {
      rawResult: input.rawResult,
      compositedResult: finalized.result,
      qaOverlay: finalized.overlay,
      compositeReport: finalized.report,
      compositeAcceptance: finalized.acceptance,
    }
  }
  if (input.state.mode === 'outpaint') {
    const canonicalLayer = await input.assetStore.get(input.state.canonicalLayerUrl)
    const finalized = await finalizeOutpaint(input.rawResult, canonicalLayer, input.state.placement, {
      sourceNeutralRgb: input.state.analysis.lighting.neutralSampleRgb,
      colorPolicy: input.state.colorPolicy ?? resolveCompositeColorPolicy(),
    })
    return {
      rawResult: input.rawResult,
      outpaintedResult: finalized.result,
      qaOverlay: finalized.overlay,
      outpaintReport: finalized.report,
      outpaintAcceptance: finalized.acceptance,
    }
  }
  if (input.state.mode !== 'dieline') return { rawResult: input.rawResult }
  const [paddedDrawing, silhouetteMask] = await Promise.all([
    input.assetStore.get(input.state.paddedDrawingUrl),
    input.assetStore.get(input.state.silhouetteMaskUrl),
  ])
  const prepared: PreparedDieline = {
    paddedDrawing,
    silhouetteMask,
    metadata: input.state.metadata,
  }
  const qa = await qaDielineResult(input.rawResult, prepared, input.threshold)
  return {
    rawResult: input.rawResult,
    qaOverlay: qa.overlay,
    qaReport: qa.report,
    qaAcceptance: evaluateDielineQa(qa.report, input.acceptanceCriteria),
  }
}
