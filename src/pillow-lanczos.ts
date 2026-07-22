/**
 * RGB Lanczos resize compatible with Pillow's 8-bit `Image.resize(..., LANCZOS)`.
 *
 * The successful dieline experiment used Pillow, while Sharp/libvips produces
 * different edge pixels for the same nominal Lanczos3 operation. Keeping this
 * tiny deterministic implementation in the Node package makes the model input
 * reproducible without adding Python to the Aeolo server runtime.
 *
 * Algorithm reference:
 * https://github.com/python-pillow/Pillow/blob/12.3.0/src/libImaging/Resample.c
 */

const SUPPORT = 3
const PRECISION_BITS = 22
const PRECISION_SCALE = 1 << PRECISION_BITS
const ROUNDING_BIAS = 1 << (PRECISION_BITS - 1)

interface Coefficients {
  ksize: number
  bounds: Int32Array
  weights: Int32Array
}

function sinc(value: number): number {
  if (value === 0) return 1
  const radians = value * Math.PI
  return Math.sin(radians) / radians
}

function lanczos(value: number): number {
  if (value < -SUPPORT || value >= SUPPORT) return 0
  return sinc(value) * sinc(value / SUPPORT)
}

function cTrunc(value: number): number {
  return value < 0 ? Math.ceil(value) : Math.floor(value)
}

function precomputeCoefficients(inputSize: number, outputSize: number): Coefficients {
  const scale = inputSize / outputSize
  const filterScale = Math.max(scale, 1)
  const support = SUPPORT * filterScale
  const ksize = Math.ceil(support) * 2 + 1
  const bounds = new Int32Array(outputSize * 2)
  const weights = new Int32Array(outputSize * ksize)

  for (let output = 0; output < outputSize; output += 1) {
    const center = (output + 0.5) * scale
    let xmin = cTrunc(center - support + 0.5)
    if (xmin < 0) xmin = 0
    let xmax = cTrunc(center + support + 0.5)
    if (xmax > inputSize) xmax = inputSize
    const count = xmax - xmin
    const floating = new Float64Array(count)
    let total = 0
    for (let index = 0; index < count; index += 1) {
      const weight = lanczos((index + xmin - center + 0.5) / filterScale)
      floating[index] = weight
      total += weight
    }
    bounds[output * 2] = xmin
    bounds[output * 2 + 1] = count
    for (let index = 0; index < count; index += 1) {
      const normalized = total === 0 ? floating[index] : floating[index] / total
      weights[output * ksize + index] = cTrunc(
        normalized < 0
          ? -0.5 + normalized * PRECISION_SCALE
          : 0.5 + normalized * PRECISION_SCALE,
      )
    }
  }
  return { ksize, bounds, weights }
}

function clip8(fixedPoint: number): number {
  const value = Math.floor(fixedPoint / PRECISION_SCALE)
  return Math.max(0, Math.min(255, value))
}

function resizeHorizontal(
  input: Uint8Array,
  inputWidth: number,
  inputHeight: number,
  outputWidth: number,
): Buffer {
  const coefficients = precomputeCoefficients(inputWidth, outputWidth)
  const output = Buffer.alloc(outputWidth * inputHeight * 3)
  for (let y = 0; y < inputHeight; y += 1) {
    for (let outputX = 0; outputX < outputWidth; outputX += 1) {
      const xmin = coefficients.bounds[outputX * 2]
      const count = coefficients.bounds[outputX * 2 + 1]
      const weightOffset = outputX * coefficients.ksize
      let red = ROUNDING_BIAS
      let green = ROUNDING_BIAS
      let blue = ROUNDING_BIAS
      for (let index = 0; index < count; index += 1) {
        const sourceOffset = (y * inputWidth + xmin + index) * 3
        const weight = coefficients.weights[weightOffset + index]
        red += input[sourceOffset] * weight
        green += input[sourceOffset + 1] * weight
        blue += input[sourceOffset + 2] * weight
      }
      const outputOffset = (y * outputWidth + outputX) * 3
      output[outputOffset] = clip8(red)
      output[outputOffset + 1] = clip8(green)
      output[outputOffset + 2] = clip8(blue)
    }
  }
  return output
}

function resizeVertical(
  input: Uint8Array,
  width: number,
  inputHeight: number,
  outputHeight: number,
): Buffer {
  const coefficients = precomputeCoefficients(inputHeight, outputHeight)
  const output = Buffer.alloc(width * outputHeight * 3)
  for (let outputY = 0; outputY < outputHeight; outputY += 1) {
    const ymin = coefficients.bounds[outputY * 2]
    const count = coefficients.bounds[outputY * 2 + 1]
    const weightOffset = outputY * coefficients.ksize
    for (let x = 0; x < width; x += 1) {
      let red = ROUNDING_BIAS
      let green = ROUNDING_BIAS
      let blue = ROUNDING_BIAS
      for (let index = 0; index < count; index += 1) {
        const sourceOffset = ((ymin + index) * width + x) * 3
        const weight = coefficients.weights[weightOffset + index]
        red += input[sourceOffset] * weight
        green += input[sourceOffset + 1] * weight
        blue += input[sourceOffset + 2] * weight
      }
      const outputOffset = (outputY * width + x) * 3
      output[outputOffset] = clip8(red)
      output[outputOffset + 1] = clip8(green)
      output[outputOffset + 2] = clip8(blue)
    }
  }
  return output
}

export function resizeRgbPillowLanczos(
  input: Uint8Array,
  inputWidth: number,
  inputHeight: number,
  outputWidth: number,
  outputHeight: number,
): Buffer {
  if (input.length !== inputWidth * inputHeight * 3) {
    throw new Error('Pillow Lanczos input must be tightly packed RGB')
  }
  if ([inputWidth, inputHeight, outputWidth, outputHeight].some((value) => !Number.isInteger(value) || value <= 0)) {
    throw new Error('Pillow Lanczos dimensions must be positive integers')
  }
  const horizontal = inputWidth === outputWidth
    ? Buffer.from(input)
    : resizeHorizontal(input, inputWidth, inputHeight, outputWidth)
  return inputHeight === outputHeight
    ? horizontal
    : resizeVertical(horizontal, outputWidth, inputHeight, outputHeight)
}
