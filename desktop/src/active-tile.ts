/** Candidate tile with a colored rectangular outline. Multiple highlighted tiles carry ambiguous evidence. */
export function activeTile(data: Uint8ClampedArray, width: number, height: number) {
  interface Edge { x: number; y: number; end: number }
  const edges: Edge[] = []
  const color = (x: number, y: number) => {
    const i = 4 * (y * width + x), r = data[i]!, g = data[i + 1]!, b = data[i + 2]!
    return Math.max(r, g, b) >= 100 && Math.max(r, g, b) - Math.min(r, g, b) > 55
  }
  const similar = (a: number, b: number) => Math.abs(data[a]! - data[b]!) + Math.abs(data[a + 1]! - data[b + 1]!) + Math.abs(data[a + 2]! - data[b + 2]!) < 70
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      if (!color(x, y) || color(x, y - 1) && color(x, y + 1)) continue
      const start = x, first = 4 * (y * width + x)
      while (x + 1 < width && similar(first, 4 * (y * width + x + 1))) x++
      if (x - start >= 80 && edges.length < 500) edges.push({ x: start, y, end: x })
    }
  }
  let found: { x: number; y: number; width: number; height: number } | null = null
  for (const top of edges) for (const bottom of edges) {
    const h = bottom.y - top.y, w = top.end - top.x
    if (h < 48 || h > w * 2 || Math.abs(bottom.x - top.x) > 8 || Math.abs(bottom.end - top.end) > 8) continue
    // Screen sharing may antialias the first row more strongly than the vertical sides.
    const mid = Math.floor((top.x + top.end) / 2)
    const seeds = [-2, -1, 0, 1, 2].map(offset => top.y + offset).filter(y => y >= 0 && y < height && color(mid, y)).map(y => 4 * (y * width + mid))
    const matchesSide = (x: number) => [0.25, 0.5, 0.75].every(f => {
      const y = Math.round(top.y + h * f)
      for (let dx = -9; dx <= 9; dx++) if (x + dx >= 0 && x + dx < width && seeds.some(seed => similar(seed, 4 * (y * width + x + dx)))) return true
      return false
    })
    if (!matchesSide(top.x) || !matchesSide(top.end)) continue
    if (found && (Math.abs(found.x - top.x) > 10 || Math.abs(found.y - top.y) > 10 || Math.abs(found.height - h) > 10)) return null
    found = { x: top.x, y: top.y, width: w, height: h }
  }
  return found
}
