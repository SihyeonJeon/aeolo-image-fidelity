import { describe, expect, it } from 'vitest'

import {
  SWAP_EDIT_CONTRACT,
  PRODUCT_STATE_FIDELITY_CONTRACT,
  compileReferencePrompt,
  compileSwapPrompt,
  formatReferenceRoles,
  type ImageReferenceRole,
} from '../src/reference-roles.js'

const references: ImageReferenceRole[] = [
  {
    id: 'scene',
    kind: 'scene',
    url: 'https://example.test/scene.png',
    description: 'Scene reference',
    role: 'Framing, background, camera and lighting only.',
  },
  {
    id: 'open',
    kind: 'product',
    url: 'https://example.test/open.png',
    description: 'Canonical open-state product',
    role: 'Open-state silhouette, proportions, color and exposed product only.',
  },
  {
    id: 'label',
    kind: 'detail',
    url: 'https://example.test/label.png',
    description: 'Canonical closed-state label',
    role: 'Label text and placement only.',
  },
]

describe('reference role compiler', () => {
  it('preserves reference order and injects every description and role', () => {
    const compiled = compileReferencePrompt({ originalPrompt: 'Original user prompt.', references })
    expect(compiled.prompt.startsWith('Original user prompt.')).toBe(true)
    expect(compiled.imageInput).toEqual(references.map((reference) => reference.url))
    for (const reference of references) {
      expect(compiled.prompt).toContain(reference.description)
      expect(compiled.prompt).toContain(reference.role)
    }
  })

  it('uses a swap mechanics block without pose-coupling vocabulary', () => {
    expect(SWAP_EDIT_CONTRACT).not.toMatch(/\b(hand|hands|held|holding)\b/i)
    const compiled = compileSwapPrompt({
      originalPrompt: 'Show the open product being applied directly to skin.',
      references,
      productStateInstruction: 'The cap is removed and the exposed product touches skin.',
    })
    expect(compiled.imageInput[0]).toBe(references[0].url)
    expect(compiled.prompt).not.toContain('do not independently generate')
    expect(compiled.prompt).toContain('Do not bend, reshape, stretch, tilt, or flip')
    expect(compiled.prompt).toContain(PRODUCT_STATE_FIDELITY_CONTRACT)
    expect(compiled.prompt).toContain('Never relocate an attribute to another component')
  })

  it('keeps the successful reference order while making action and state mandatory', () => {
    const successfulReferences: ImageReferenceRole[] = [
      {
        id: 'scene', kind: 'scene', url: 'scene', description: 'Scene reference.',
        role: 'Framing, camera angle, background, subject, and lighting only.',
      },
      {
        id: 'open', kind: 'product', url: 'open', description: 'Product master reference, open state.',
        role: 'Primary component with its removable cover detached: shape and proportions only.',
      },
      {
        id: 'usage', kind: 'usage', url: 'usage', description: 'Open product usage reference.',
        role: 'How the exposed functional surface contacts the target surface only.',
      },
      {
        id: 'closed', kind: 'detail', url: 'closed', description: 'Canonical closed product, front view.',
        role: 'Label text and label placement only.',
      },
      {
        id: 'detail', kind: 'detail', url: 'detail', description: 'Canonical closed product, slightly angled view.',
        role: 'Side construction and cap-body seam only.',
      },
    ]
    const state = 'The product is OPEN — the removable cover is detached. The exposed functional surface on the plain inner component (IMAGE 2, IMAGE 3) is the active part.'
    const original = 'Show the OPEN product in use with its exposed functional surface contacting the target surface.'
    const expected = `ORIGINAL USER PROMPT — REQUIRED VISIBLE RESULT:
${original}

MANDATORY PRODUCT STATE AND INTERACTION:
${state}

REFERENCE IMAGE DESCRIPTIONS AND ROLES (same order as image input):
${formatReferenceRoles(successfulReferences)}

${PRODUCT_STATE_FIDELITY_CONTRACT}

${SWAP_EDIT_CONTRACT}`
    expect(compileSwapPrompt({ originalPrompt: original, references: successfulReferences, productStateInstruction: state }).prompt).toBe(expected)
  })

  it('refuses a swap when the visible user result or final product state is missing', () => {
    expect(() => compileSwapPrompt({
      originalPrompt: ' ',
      references,
      productStateInstruction: 'Use the open state.',
    })).toThrow('swap originalPrompt must not be empty')
    expect(() => compileSwapPrompt({
      originalPrompt: 'Show the product in use.',
      references,
      productStateInstruction: ' ',
    })).toThrow('swap productStateInstruction must not be empty')
  })
})
