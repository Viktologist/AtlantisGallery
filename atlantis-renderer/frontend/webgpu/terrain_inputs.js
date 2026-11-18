import {readFloat32Npy} from '../src/heightfield_grid.js';
import {loadLandscapeInputs} from './landscape_inputs.js';
import {loadGroundcoverInputs} from './groundcover_inputs.js';
import {loadSurfaceVariation} from './surface_variation_inputs.js';
import {loadGrassCells} from './grass_cells.js';
import {loadTerrainPBR} from './terrain_pbr.js';
import {loadTerrainGrassPBR,useDefaultGrassPBR} from './terrain_grass_pbr.js';
import {loadLakeMaskInputs} from './lake_mask_inputs.js';
import {classifySavedWaterKind,normalizeRiverFlow} from './inland_water_math.js';

export async function terrainDigest(buffer) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', buffer))].map(v => v.toString(16).padStart(2, '0')).join('');
}
const gridShape = (value, fallback) => {
  if (Array.isArray(value) && value.length === 2 && value.every(n => Number.isInteger(n) && n > 0)) return [...value];
  if (Number.isInteger(value) && value > 0) return [value, value];
  if (Array.isArray(fallback) && fallback.length === 2 && fallback.every(n => Number.isInteger(n) && n > 0)) return [...fallback];
  if (Number.isInteger(fallback) && fallback > 0) return [fallback, fallback];
  return [1, 1];
};
const gridLimit = (shape, limit, label) => {
  if (Number.isFinite(limit) && Math.max(...shape) > limit) throw Error(`${label} exceeds GPU texture limit`);
};
function elevationRange(data) {
  let min = Infinity, max = -Infinity;
  for (const value of data) { if (value < min) min = value; if (value > max) max = value; }
  return Number.isFinite(min) && Number.isFinite(max) ? [min, max] : [0, 0];
}
                                                                            
                                                                                
export function validateTerrainRegistration(scene, native, limit) {
  const shape = native?.shape;
  if (!Array.isArray(shape) || shape.length !== 2 || !shape.every(n => Number.isInteger(n) && n > 0)) throw Error('Native height grid shape missing');
  gridLimit(shape, limit, 'Native height texture');
}
export function validateCoastalRegistration(coastal, scene, limit) {
  if (coastal?.shape !== undefined) gridLimit(gridShape(coastal.shape), limit, 'Coastal surface texture');
  return coastal;
}

                                                                            
                                                                               
                                                                          
                                                                                
                                                            
export async function loadTerrainInputs(sceneUrl, {limit = 8192, guard = () => {}, fetcher = fetch} = {}) {
  const url = new URL(sceneUrl, globalThis.location?.href ?? 'http://localhost/');
  const base = new URL('.', url);
  async function get(path, options = {}) { const r = await fetcher(new URL(path, base).href, {cache:'no-store',...options}); guard(); if (!r.ok) throw Error(`Cannot load ${path} (${r.status})`); const b = await r.arrayBuffer(); guard(); return b; }
  const sceneData = JSON.parse(new TextDecoder().decode(await get(url.href)));
  const rawStage = Object.values(sceneData.stages || {})[0]; if (!rawStage?.file) throw Error('Native height stage missing');
  const native = readFloat32Npy(await get(rawStage.file));
  validateTerrainRegistration(sceneData, native, limit);
  const actualRange = elevationRange(native.data);
  const stage = {...rawStage};
  if (!Number.isFinite(stage.min_m)) stage.min_m = actualRange[0];
  if (!Number.isFinite(stage.peak_m)) stage.peak_m = actualRange[1];
  if (stage.min_m > stage.peak_m) { stage.min_m = actualRange[0]; stage.peak_m = actualRange[1]; }
  stage.min_m = Math.min(stage.min_m, actualRange[0]);
  stage.peak_m = Math.max(stage.peak_m, actualRange[1]);
  const surface = sceneData.surface ?? {};
  const fields = JSON.parse(new TextDecoder().decode(await get(surface.fields)));
  const shape = gridShape(fields.shape, fields.size);
  gridLimit(shape, limit, 'Saved material field');
                                                                                
                                                 
  const profileData = JSON.parse(new TextDecoder().decode(await get(surface.profile)));
  const distribution = profileData?.distribution && typeof profileData.distribution === 'object' ? profileData.distribution : {};
  const profile = {...profileData, distribution:{
    ...distribution,
    sea_level_m: distribution.sea_level_m ?? null,
    vegetation_amount: Number.isFinite(distribution.vegetation_amount) ? distribution.vegetation_amount : 0
  }};
  const library = new TextDecoder().decode(await get(surface.material_library));
  const rows = Array.isArray(fields.textures) ? fields.textures : [];
  const fieldBytes = [];
  for (const row of rows) {
    if (!row || typeof row.file !== 'string') { fieldBytes.push(null); continue; }
    fieldBytes.push(new Uint8Array(await get(row.file)));
  }
  let coastalBytes = null, coastalShape = null;
  if (fields.coastal_surface) {
    const row = fields.coastal_surface;
    const bytes = typeof row.file === 'string' ? await get(row.file) : new ArrayBuffer(0);
    coastalBytes = new Uint8Array(bytes);
    const count = Math.floor(bytes.byteLength / 4), side = Math.round(Math.sqrt(count));
    coastalShape = gridShape(row.shape, side > 0 && side * side === count ? side : [1, Math.max(1, count)]);
    validateCoastalRegistration({...row, shape:coastalShape}, sceneData, limit);
  }
  const water = [];
  for (const row of sceneData.water || []) {
    const bytes = await get(row.file);
    if (bytes.byteLength % 4) throw Error('Saved water geometry alignment mismatch');
    const points = new Float32Array(bytes); let indices = null;
    if (row.indices_file) {
      const ib = await get(row.indices_file);
      const ctor = {uint16: Uint16Array, uint32: Uint32Array}[row.index_component_type || 'uint32'];
      if (!ctor || ib.byteLength % ctor.BYTES_PER_ELEMENT) throw Error('Saved water index format mismatch');
      indices = new ctor(ib);
      if (points.length % 3 || indices.length % 3 || indices.some(i => i >= points.length / 3)) throw Error('Saved water indices mismatch');
    } else if (points.length % 9) throw Error('Saved water requires explicit triangles');
    if (!points.every(Number.isFinite)) throw Error('Nonfinite saved water geometry');
    if (!Array.isArray(row.color) || row.color.length !== 3 || !row.color.every(Number.isFinite)) throw Error('Saved water color missing');
                                                                                 
                                                                                
    const kind = classifySavedWaterKind(row.file, row.kind);
    const flow = kind === 'river' ? normalizeRiverFlow(row) : null;
    water.push({row, points, indices, kind, flow});
  }
  const landscape = await loadLandscapeInputs(surface.landscape_pbr, sceneData, base, {get, digest:terrainDigest, limit});
  const groundcover = await loadGroundcoverInputs(surface.groundcover,sceneData,base,{get,digest:terrainDigest,landscape,limit});
  const variation = await loadSurfaceVariation(surface.variation,sceneData,base,{get,digest:terrainDigest,limit});
  const grassCells=await loadGrassCells(surface.grass_cells,sceneData,base,{get,digest:terrainDigest,limit});
  const lakeMask=await loadLakeMaskInputs(surface.inland_lakes,{...native,spacing:sceneData.spacing_xz_m,origin:sceneData.origin_xz_m,sha256:sceneData.height_sha256},fields,base,{checked:get,digest:terrainDigest});
  const defaultPBR=!landscape&&surface.default_pbr!==false?await loadTerrainPBR({fetcher,digest:terrainDigest,limit}):null;
  const defaultGrassPBR=useDefaultGrassPBR(surface,grassCells,groundcover)?await loadTerrainGrassPBR({fetcher,digest:terrainDigest,limit}):null;
  guard();
  return {sceneData, stage, native: {...native, spacing: [...sceneData.spacing_xz_m], origin: [...sceneData.origin_xz_m], sha256: sceneData.height_sha256, sourceHash: sceneData.height_sha256},
    fields, fieldShape: shape, profile, library, fieldBytes, coastalBytes, coastalShape, water, landscape, groundcover, variation,grassCells,lakeMask,defaultPBR,defaultGrassPBR};
}
