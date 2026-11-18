                                                                            
                                                                            
export function shoreReviewLayout(layout, review) {
  if (review == null) return layout;
  const {bounds, cellMetres} = review;
  if (!Array.isArray(bounds) || bounds.length !== 4 || !bounds.every(Number.isFinite) ||
      bounds[2] <= bounds[0] || bounds[3] <= bounds[1]) throw Error('Shore review needs finite [xmin,zmin,xmax,zmax] bounds');
  if (![1, .5, .25].includes(cellMetres)) throw Error('Shore review cellMetres must be 1, 0.5 or 0.25');
  const m = layout.tileMetres, cells = m / cellMetres;
  if (!Number.isInteger(cells)) throw Error('Shore review resolution must divide the fixed world page');
  for (let i = 0; i < 4; i++) {
    const origin = layout.origin[i % 2];
    if (Math.abs((bounds[i] - origin) / m - Math.round((bounds[i] - origin) / m)) > 1e-8)
      throw Error('Shore review bounds must align to existing world pages');
  }
  const tiles = layout.tiles.filter(t => t.origin[0] >= bounds[0] && t.origin[1] >= bounds[1] &&
    t.origin[0] + m <= bounds[2] && t.origin[1] + m <= bounds[3]).map((t, id) => ({...t, id}));
  const rawBytes = tiles.length * (cells + 2 * layout.halo) ** 2 * 4 * 4 * 4;
  if (!tiles.length || tiles.length > 16 || rawBytes > 256 * 1024 ** 2)
    throw Error('Shore review must occupy 1–16 existing pages and at most 256 MiB of four RGBA32F arrays');
  return {...layout, tiles, cells, resolutionAdapted: cellMetres !== .25,
    review: {bounds: [...bounds], cell_metres: cellMetres, original_pages: layout.tiles.length,
      raw_array_bytes: rawBytes, allocation: 'fixed bounded review only',
      outside_region: 'no shoreline state; inspect the guarded interior only', native_dem_cropped: false,adaptive:review.adaptive===true}};
}
