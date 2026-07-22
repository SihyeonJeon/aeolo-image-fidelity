/**
 * Framework-neutral host integration example.
 * Adapt the repository/blob/KIE interfaces to Aeolo's existing implementations.
 */
import {
  finalizeGeneration,
  prepareGeneration,
  type BinaryAssetStore,
  type GenerationState,
  type PrepareGenerationInput,
  type ProviderImageRequest,
} from '@geo/image-fidelity'

type UrlBackedInput =
  | Extract<PrepareGenerationInput, { mode: 'generate' }>
  | Extract<PrepareGenerationInput, { mode: 'swap' }>
  | (Omit<Extract<PrepareGenerationInput, { mode: 'composite' }>, 'canonicalCutout'> & {
      canonicalCutout: Omit<Extract<PrepareGenerationInput, { mode: 'composite' }>['canonicalCutout'], 'source'> & { sourceUrl: string }
    })
  | (Omit<Extract<PrepareGenerationInput, { mode: 'outpaint' }>, 'canonicalCutout'> & {
      canonicalCutout: Omit<Extract<PrepareGenerationInput, { mode: 'outpaint' }>['canonicalCutout'], 'source'> & { sourceUrl: string }
    })
  | (Omit<Extract<PrepareGenerationInput, { mode: 'dieline' }>, 'dielineImage'> & {
      dielineImage: Omit<Extract<PrepareGenerationInput, { mode: 'dieline' }>['dielineImage'], 'source'> & { sourceUrl: string }
    })

interface JobRecord {
  id: string
  providerRequest: ProviderImageRequest
  fidelityState: GenerationState
  attempt: number
}

interface JobRepository {
  insert(job: JobRecord): Promise<void>
  get(id: string): Promise<JobRecord>
  attachTask(id: string, taskId: string): Promise<void>
  saveOutputs(id: string, output: {
    providerRawUrl: string
    finalUrl: string
    qaOverlayUrl?: string
    qaReport?: unknown
    status: 'completed' | 'retrying' | 'needs_review'
  }): Promise<void>
  incrementAttempt(id: string): Promise<void>
}

interface OutputStore {
  put(name: string, bytes: Buffer, contentType: 'image/png'): Promise<string>
}

interface KieClient {
  createTask(request: ProviderImageRequest, callbackUrl: string): Promise<{ taskId: string }>
}

interface Dependencies {
  assets: BinaryAssetStore
  outputs: OutputStore
  jobs: JobRepository
  kie: KieClient
  callbackBaseUrl: string
}

async function fetchBuffer(url: string): Promise<Buffer> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`asset fetch failed: ${response.status}`)
  return Buffer.from(await response.arrayBuffer())
}

async function materializeInput(input: UrlBackedInput): Promise<PrepareGenerationInput> {
  if (input.mode === 'composite' || input.mode === 'outpaint') {
    const { sourceUrl, ...canonicalCutout } = input.canonicalCutout
    return { ...input, canonicalCutout: { ...canonicalCutout, source: await fetchBuffer(sourceUrl) } }
  }
  if (input.mode === 'dieline') {
    const { sourceUrl, ...dielineImage } = input.dielineImage
    return { ...input, dielineImage: { ...dielineImage, source: await fetchBuffer(sourceUrl) } }
  }
  return input
}

export async function createImageJob(jobId: string, input: UrlBackedInput, deps: Dependencies): Promise<string> {
  const prepared = await prepareGeneration(await materializeInput(input), deps.assets)
  await deps.jobs.insert({
    id: jobId,
    providerRequest: prepared.providerRequest,
    fidelityState: prepared.state,
    attempt: 1,
  })
  const callbackUrl = `${deps.callbackBaseUrl}/api/kie/callback?jobId=${encodeURIComponent(jobId)}`
  const { taskId } = await deps.kie.createTask(prepared.providerRequest, callbackUrl)
  await deps.jobs.attachTask(jobId, taskId)
  return taskId
}

export async function handleKieResult(jobId: string, providerResultUrl: string, deps: Dependencies): Promise<void> {
  const job = await deps.jobs.get(jobId)
  const rawResult = await fetchBuffer(providerResultUrl)
  const finalized = await finalizeGeneration({
    rawResult,
    state: job.fidelityState,
    assetStore: deps.assets,
  })
  const providerRawUrl = await deps.outputs.put(`${jobId}/provider-raw.png`, finalized.rawResult, 'image/png')
  const finalBytes = finalized.outpaintedResult ?? finalized.compositedResult ?? finalized.rawResult
  const finalUrl = await deps.outputs.put(`${jobId}/final.png`, finalBytes, 'image/png')
  const qaOverlayUrl = finalized.qaOverlay
    ? await deps.outputs.put(`${jobId}/qa-overlay.png`, finalized.qaOverlay, 'image/png')
    : undefined
  const qaReport = finalized.outpaintReport ?? finalized.compositeReport ?? finalized.qaReport
  const retryRecommended = finalized.qaAcceptance?.retryRecommended === true
    || finalized.compositeAcceptance?.retryRecommended === true
    || finalized.outpaintAcceptance?.retryRecommended === true
  const mayRetry = retryRecommended && job.attempt < 3

  await deps.jobs.saveOutputs(jobId, {
    providerRawUrl,
    finalUrl,
    qaOverlayUrl,
    qaReport,
    status: mayRetry ? 'retrying' : retryRecommended ? 'needs_review' : 'completed',
  })
  if (!mayRetry) return

  await deps.jobs.incrementAttempt(jobId)
  const callbackUrl = `${deps.callbackBaseUrl}/api/kie/callback?jobId=${encodeURIComponent(jobId)}`
  const { taskId } = await deps.kie.createTask(job.providerRequest, callbackUrl)
  await deps.jobs.attachTask(jobId, taskId)
}
