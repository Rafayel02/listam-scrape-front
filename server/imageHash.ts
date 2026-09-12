import imghash from 'imghash'

export async function computePHash(buffer: Buffer): Promise<string> {
  return imghash.hash(buffer)
}
