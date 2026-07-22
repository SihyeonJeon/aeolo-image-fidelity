export type ReferenceKind = 'scene' | 'product' | 'usage' | 'detail' | 'support'

export interface ReferenceRoleFields {
  id: string
  url: string
  description: string
  role: string
}

export interface ImageReferenceRole extends ReferenceRoleFields {
  kind: ReferenceKind
}

export interface CompiledImageEditInput<TReference extends ReferenceRoleFields = ImageReferenceRole> {
  prompt: string
  imageInput: string[]
  references: TReference[]
}

export interface CompileReferencePromptInput {
  originalPrompt: string
  references: ImageReferenceRole[]
  instruction?: string
}

export interface CompileSwapPromptInput {
  /** Exact customer request, including the visible interaction/action to render. */
  originalPrompt: string
  references: ImageReferenceRole[]
  /** Mandatory final product state and component relationship for this output. */
  productStateInstruction: string
}

function nonEmpty(value: string, label: string): string {
  const trimmed = value.trim()
  if (!trimmed) throw new Error(`${label} must not be empty`)
  return trimmed
}

const REFERENCE_KINDS = new Set<ReferenceKind>(['scene', 'product', 'usage', 'detail', 'support'])

export function validateReferences<TReference extends ImageReferenceRole>(references: TReference[]): TReference[] {
  if (references.length === 0) throw new Error('at least one reference is required')
  const ids = new Set<string>()
  return references.map((reference, index) => {
    if (!REFERENCE_KINDS.has(reference.kind)) {
      throw new Error(`unsupported reference kind: ${String(reference.kind)}`)
    }
    const normalized = {
      ...reference,
      id: nonEmpty(reference.id, `reference ${index + 1} id`),
      url: nonEmpty(reference.url, `reference ${index + 1} url`),
      description: nonEmpty(reference.description, `reference ${index + 1} description`),
      role: nonEmpty(reference.role, `reference ${index + 1} role`),
    } as TReference
    if (ids.has(normalized.id)) throw new Error(`duplicate reference id: ${normalized.id}`)
    ids.add(normalized.id)
    return normalized
  })
}

export function formatReferenceRoles(references: ReferenceRoleFields[]): string {
  if (references.length === 0) throw new Error('at least one reference is required')
  return references
    .map((reference, index) => [
      `IMAGE ${index + 1} — ${reference.description}`,
      `Role: ${reference.role}`,
    ].join('\n'))
    .join('\n\n')
}

/**
 * Swap mechanics only. Product identity/state belongs in the supplied reference
 * descriptions, roles, and mandatory productStateInstruction.
 *
 * Deliberately contains no grip/limb vocabulary: the previous production prompt
 * coupled package geometry to the pose of an existing object and caused flips and
 * form-factor drift.
 */
export const SWAP_EDIT_CONTRACT = `SWAP / EDIT INSTRUCTION:
Use IMAGE 1 as the scene authority. Replace the existing product-like object at the scene's visual focus; do not add a second product or leave the previous object visible.
Use every remaining image only within its declared role. Render the canonical product with its own silhouette, proportions, orientation, construction, color, and declared state. Do not bend, reshape, stretch, tilt, or flip it to imitate the object being replaced.
Preserve IMAGE 1's framing, camera angle, background, subject, depth of field, and lighting. Integrate the canonical product at the scene's focal location without inheriting geometry from the previous object.
Copy package text only from a reference whose role explicitly grants label or text authority. Do not invent, autocomplete, blur, or stylize package text.
Return one edited image with no caption, watermark, frame, border, or extra text overlay.`

/**
 * Keeps attributes from a reference showing another product state from leaking
 * onto the wrong physical component in the requested state.
 */
export const PRODUCT_STATE_FIDELITY_CONTRACT = `PRODUCT STATE FIDELITY CONTRACT:
The ORIGINAL USER PROMPT's visible action and the MANDATORY PRODUCT STATE AND INTERACTION are hard output requirements, not optional reference notes. Show that exact state and interaction in the result.
A reference showing another state may supply only the attributes granted by its declared role. Keep every marking, label, seam, material, and exposed or covered feature attached to the same physical component shown in its authority reference.
Never relocate an attribute to another component to make it visible. If the physical component carrying an attribute is absent in the requested state, omit that attribute rather than moving it elsewhere.
Do not merge components from open, closed, assembled, disassembled, or usage references into a hybrid construction.`

export function compileReferencePrompt(input: CompileReferencePromptInput): CompiledImageEditInput {
  const originalPrompt = nonEmpty(input.originalPrompt, 'originalPrompt')
  const references = validateReferences(input.references)
  const sections = [
    originalPrompt,
    input.instruction?.trim(),
    `REFERENCE IMAGE DESCRIPTIONS AND ROLES (same order as image input):\n${formatReferenceRoles(references)}`,
  ].filter((section): section is string => Boolean(section))
  return {
    prompt: sections.join('\n\n'),
    imageInput: references.map((reference) => reference.url),
    references,
  }
}

export function compileSwapPrompt(input: CompileSwapPromptInput): CompiledImageEditInput {
  const original = nonEmpty(input.originalPrompt, 'swap originalPrompt')
  const productState = nonEmpty(input.productStateInstruction, 'swap productStateInstruction')
  const references = validateReferences(input.references)
  if (references[0]?.kind !== 'scene') {
    throw new Error('swap reference 1 must have kind=scene')
  }
  if (!references.slice(1).some((reference) => reference.kind === 'product' || reference.kind === 'detail')) {
    throw new Error('swap requires at least one product/detail reference after the scene')
  }
  const sections = [
    `ORIGINAL USER PROMPT — REQUIRED VISIBLE RESULT:\n${original}`,
    `MANDATORY PRODUCT STATE AND INTERACTION:\n${productState}`,
    `REFERENCE IMAGE DESCRIPTIONS AND ROLES (same order as image input):\n${formatReferenceRoles(references)}`,
    PRODUCT_STATE_FIDELITY_CONTRACT,
    SWAP_EDIT_CONTRACT,
  ]
  return {
    prompt: sections.join('\n\n'),
    imageInput: references.map((reference) => reference.url),
    references,
  }
}
