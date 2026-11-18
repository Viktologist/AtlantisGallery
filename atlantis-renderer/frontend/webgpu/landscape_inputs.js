import {landscapePageLayout} from './landscape_pages.js';
                                                                              
                                                                                
                                         
const tile = value => Array.isArray(value) && value.length === 2 && value.every(v => Number.isFinite(v) && v > 0) ? [...value] : [1, 1];
function normalizeMaterials(value) {
  const roles = ['rock', 'soil', 'sand', 'mud', 'gravel', 'litter'];
  const rows = Array.isArray(value) ? value.slice(0, 8) : [];
  const materials = rows.map((row, i) => ({...row, role: typeof row?.role === 'string' ? row.role : roles[i % roles.length], tile_size_m: tile(row?.tile_size_m)}));
  if (!materials.length) materials.push({role: 'soil', tile_size_m: [1, 1]});
  return materials;
}
export async function loadLandscapeInputs(reference, scene, base, {get, digest, limit = 8192, maxBytes = 512 * 1024 ** 2} = {}) {
  if (!reference) return null;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1024 ** 3) throw Error('Invalid landscape resident budget');
  function local(path, directory) {
    const url = new URL(path, directory);
    if (typeof path !== 'string' || !path || /^[a-z]+:|^[/\\]/i.test(path) || path.includes('\\') || path.split('/').includes('..') || !url.href.startsWith(directory.href)) throw Error('Landscape reference escapes package');
    return url.href;
  }
  const manifestUrl = local(reference.file, base), bytes = await get(manifestUrl);
  const manifest = JSON.parse(new TextDecoder().decode(bytes));
  const materials = normalizeMaterials(manifest.materials);
  manifest.materials = materials;
  if (!Number.isInteger(manifest.seed)) manifest.seed = 0;
  if (!Number.isFinite(manifest.detail_strength)) manifest.detail_strength = 0.5;
  if (!Number.isFinite(manifest.normal_strength)) manifest.normal_strength = 1;
  const worldShape = Array.isArray(manifest.world_shape) && manifest.world_shape.length === 2 && manifest.world_shape.every(n => Number.isInteger(n) && n > 0)
    ? [...manifest.world_shape] : scene.shape.map(n => n - 1);
  manifest.world_shape = worldShape;
  const directory = new URL('.', manifestUrl);
  const result = {manifest};
  const layout = manifest.streaming ? landscapePageLayout(manifest) : null;
  let total = 0;
  for (const [name, layers] of [['source_textures', materials.length * 2], ['macro_fields', 3], ['world_mips', 3]]) {
    const stack = manifest[name];
    if (layout && name !== 'source_textures') {
      const first = stack?.levels?.[0];
      if (first && Number.isInteger(first.width) && Number.isInteger(first.height) && Math.max(first.width, first.height) > limit) throw Error('Virtual landscape node exceeds GPU limit');
      for (const row of stack?.levels ?? []) for (const page of row.pages ?? []) local(page.file, directory);
      continue;
    }
    if (!stack) { result[name] = {stack: {layers, levels: []}, levels: []}; continue; }
    const effectiveLayers = Number.isInteger(stack.layers) && stack.layers > 0 ? stack.layers : layers;
    const levels = Array.isArray(stack.levels) ? stack.levels : [];
    const first = levels[0];
    if (!first) { result[name] = {stack: {...stack, layers: effectiveLayers}, levels: []}; continue; }
    let width = first.width, height = first.height;
    if (Number.isInteger(width) && Number.isInteger(height) && Math.max(width, height) > limit) throw Error('Landscape texture exceeds GPU limit');
    const decoded = [];
    for (const row of levels) {
      const data = await get(local(row.file, directory));
      total += data.byteLength;
      if (total > maxBytes) throw Error('Landscape resident budget exceeded');
      decoded.push(new Uint16Array(data));
      width = Math.max(1, width >> 1); height = Math.max(1, height >> 1);
    }
    result[name] = {stack: {...stack, layers: effectiveLayers, levels}, levels: decoded};
  }
  if (layout) {
    total += layout.cacheBytes + layout.tableBytes + layout.feedbackBytes * 3;
    if (total > maxBytes) throw Error('Virtual landscape resident budget exceeded');
    result.virtual = {layout, async fetchPage(page, {signal} = {}) {
      const data = await get(local(page.file, directory), {signal});
      return new Uint16Array(data);
    }};
  }
  result.residentBytes = total;
  return result;
}
