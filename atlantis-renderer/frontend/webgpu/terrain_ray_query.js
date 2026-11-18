                                                           
  
                                                                               
                                                                                
                                                                               
                                                                            
                                                           
  
                        
                        
                                                                  
                                                                              
                                                                               
                                                                         
                                                                               
                                                                          
                                                                          
                                                                             
                                                                        
                                                                           
                                                                     
                                                                            
                                                                               
                                        


export const TERRAIN_RAY_TILE_CELLS = 8;
export const TERRAIN_RAY_EPS_M = 1e-4;
export const TERRAIN_RAY_TRI_EPS = 1e-6;
export const TERRAIN_RAY_INF = 3.0e38;

export const terrainOcclusionWGSL =           `
const APS_TERRAIN_EPS: f32 = 1e-4;
const APS_TERRAIN_TRI_EPS: f32 = 1e-6;
const APS_TERRAIN_INF: f32 = 3.0e38;

struct APSTerrainHit {
  hit: u32,
  distance: f32,
  position: vec3f,
  normal: vec3f,
  cell: vec2u,
  triangle: u32,
};

struct APSStaticHit {
  hit: u32,
  distance: f32,
  source: u32,
  position: vec3f,
  normal: vec3f,
  instance: u32,
  primitive: u32,
  chunk: u32,
  geometry: u32,
  cell: vec2u,
  triangle: u32,
  albedo: vec3f,
};

fn apsTerrainMiss() -> APSTerrainHit {
  return APSTerrainHit(0u, APS_TERRAIN_INF, vec3f(0.0), vec3f(0.0), vec2u(0u), 0u);
}

fn apsStaticMiss() -> APSStaticHit {
  return APSStaticHit(0u, APS_TERRAIN_INF, 0u, vec3f(0.0), vec3f(0.0), 0u, 0u, 0u, 0u, vec2u(0u), 0u, vec3f(0.0));
}

fn apsTerrainQueryEnabled() -> bool { return apsTerrainP.shapeTile.w != 0u; }

fn apsTerrainVertex(q: vec2i) -> f32 {
  let shape = vec2i(apsTerrainP.shapeTile.xy);
  return textureLoad(apsTerrainHeight, clamp(q, vec2i(0), shape - vec2i(1)), 0).r;
}

fn apsTerrainTileMax(t: vec2u) -> f32 {
  return textureLoad(apsTerrainMax, vec2i(t), 0).r;
}

fn apsTerrainNormal(slope: vec2f) -> vec3f {
  return normalize(vec3f(-slope.x, 1.0, -slope.y));
}

// Clip one axis.  Returns (-1,-1) on a miss; otherwise the (possibly narrowed)
// ray parameter interval.  The interval starts at zero so terrain behind the
// origin never contributes.
fn apsTerrainAxisClip(o: f32, d: f32, lo: f32, hi: f32, t0in: f32, t1in: f32) -> vec2f {
  var t0 = t0in;
  var t1 = t1in;
  if (abs(d) < 1e-20) {
    if (o < lo || o > hi) { return vec2f(-1.0, -1.0); }
  } else {
    let a = (lo - o) / d;
    let b = (hi - o) / d;
    t0 = max(t0, min(a, b));
    t1 = min(t1, max(a, b));
  }
  if (!(t1 >= t0) || !(t1 > 0.0)) { return vec2f(-1.0, -1.0); }
  return vec2f(t0, t1);
}

// Moller-Trumbore over the native heightfield triangle.  The caller direction is
// not renormalised, so the returned parameter is directly comparable to the
// building SMBSP distance.  Both windings are accepted; the heightfield normal
// is computed from the analytic cell slope below instead of face winding.
fn apsTerrainTriangle(o: vec3f, d: vec3f, a: vec3f, b: vec3f, c: vec3f, t0: f32, t1: f32) -> vec2f {
  let e1 = b - a;
  let e2 = c - a;
  let p = cross(d, e2);
  let det = dot(e1, p);
  if (abs(det) < 1e-9) { return vec2f(-1.0, 0.0); }
  let inv = 1.0 / det;
  let s = o - a;
  let u = dot(s, p) * inv;
  if (u < -APS_TERRAIN_TRI_EPS || u > 1.0 + APS_TERRAIN_TRI_EPS) { return vec2f(-1.0, 0.0); }
  let q = cross(s, e1);
  let v = dot(d, q) * inv;
  if (v < -APS_TERRAIN_TRI_EPS || u + v > 1.0 + APS_TERRAIN_TRI_EPS) { return vec2f(-1.0, 0.0); }
  let t = dot(e2, q) * inv;
  if (!(t > t0 + APS_TERRAIN_TRI_EPS) || !(t <= t1)) { return vec2f(-1.0, 0.0); }
  return vec2f(1.0, t);
}

fn apsTerrainTileHit(o: vec3f, d: vec3f, tIn: f32, tOut: f32, ix: i32, iz: i32, anyHit: bool) -> APSTerrainHit {
  var best = apsTerrainMiss();
  let shape = vec2i(apsTerrainP.shapeTile.xy);
  let origin = apsTerrainP.originSpacing.xy;
  let spacing = apsTerrainP.originSpacing.zw;
  let x0 = ix * i32(max(1u, apsTerrainP.shapeTile.z));
  let z0 = iz * i32(max(1u, apsTerrainP.shapeTile.z));
  let x1 = min(x0 + i32(max(1u, apsTerrainP.shapeTile.z)), shape.x - 1);
  let z1 = min(z0 + i32(max(1u, apsTerrainP.shapeTile.z)), shape.y - 1);
  for (var cz = z0; cz < z1; cz++) {
    for (var cx = x0; cx < x1; cx++) {
      let lo = vec2f(origin.x + f32(cx) * spacing.x, origin.y + f32(cz) * spacing.y);
      let hi = lo + spacing;
      var seg = apsTerrainAxisClip(o.x, d.x, lo.x, hi.x, tIn, tOut);
      if (seg.x < 0.0) { continue; }
      seg = apsTerrainAxisClip(o.z, d.z, lo.y, hi.y, seg.x, seg.y);
      if (seg.x < 0.0) { continue; }
      let y00 = apsTerrainVertex(vec2i(cx, cz));
      let y10 = apsTerrainVertex(vec2i(cx + 1, cz));
      let y01 = apsTerrainVertex(vec2i(cx, cz + 1));
      let y11 = apsTerrainVertex(vec2i(cx + 1, cz + 1));
      let cmax = max(max(y00, y10), max(y01, y11));
      let minY = min(o.y + d.y * seg.x, o.y + d.y * seg.y);
      if (minY > cmax + APS_TERRAIN_EPS) { continue; }
      let pa = vec3f(lo.x, y00, lo.y);
      let pb = vec3f(hi.x, y10, lo.y);
      let pc = vec3f(lo.x, y01, hi.y);
      let pd = vec3f(hi.x, y11, hi.y);
      var tri = apsTerrainTriangle(o, d, pa, pb, pc, seg.x, seg.y);
      if (tri.x > 0.0) {
        let n = apsTerrainNormal(vec2f((y10 - y00) / spacing.x, (y01 - y00) / spacing.y));
        if (anyHit) { return APSTerrainHit(1u, tri.y, o + d * tri.y, n, vec2u(vec2i(cx, cz)), 0u); }
        if (tri.y < best.distance) { best = APSTerrainHit(1u, tri.y, o + d * tri.y, n, vec2u(vec2i(cx, cz)), 0u); }
      }
      tri = apsTerrainTriangle(o, d, pb, pd, pc, seg.x, seg.y);
      if (tri.x > 0.0) {
        let n = apsTerrainNormal(vec2f((y11 - y01) / spacing.x, (y11 - y10) / spacing.y));
        if (anyHit) { return APSTerrainHit(1u, tri.y, o + d * tri.y, n, vec2u(vec2i(cx, cz)), 1u); }
        if (tri.y < best.distance) { best = APSTerrainHit(1u, tri.y, o + d * tri.y, n, vec2u(vec2i(cx, cz)), 1u); }
      }
    }
  }
  return best;
}

fn apsTerrainRayQuery(o: vec3f, d: vec3f, maxDistance: f32, anyHit: bool) -> APSTerrainHit {
  if (!apsTerrainQueryEnabled()) { return apsTerrainMiss(); }
  if (!(maxDistance > 0.0) || dot(d, d) <= 0.0) { return apsTerrainMiss(); }
  let shape = apsTerrainP.shapeTile.xy;
  let maxShape = apsTerrainP.maxShapeRevision.xy;
  if (shape.x < 2u || shape.y < 2u || maxShape.x == 0u || maxShape.y == 0u) { return apsTerrainMiss(); }
  let origin = apsTerrainP.originSpacing.xy;
  let spacing = apsTerrainP.originSpacing.zw;
  var range = apsTerrainAxisClip(o.x, d.x, origin.x, origin.x + f32(shape.x - 1u) * spacing.x, 0.0, maxDistance);
  if (range.x < 0.0) { return apsTerrainMiss(); }
  range = apsTerrainAxisClip(o.z, d.z, origin.y, origin.y + f32(shape.y - 1u) * spacing.y, range.x, range.y);
  if (range.x < 0.0) { return apsTerrainMiss(); }
  let t0 = range.x;
  let t1 = range.y;
  if (!(t1 > t0)) { return apsTerrainMiss(); }

  let cells = i32(max(1u, apsTerrainP.shapeTile.z));
  let tile = f32(cells) * spacing;
  let p0 = o + d * t0;
  var ix = i32(clamp(floor((p0.x - origin.x) / tile.x), 0.0, f32(maxShape.x) - 1.0));
  var iz = i32(clamp(floor((p0.z - origin.y) / tile.y), 0.0, f32(maxShape.y) - 1.0));
  var sx = 0;
  var sz = 0;
  if (d.x > 1e-20) { sx = 1; } else if (d.x < -1e-20) { sx = -1; }
  if (d.z > 1e-20) { sz = 1; } else if (d.z < -1e-20) { sz = -1; }
  var tnx = APS_TERRAIN_INF;
  var tnz = APS_TERRAIN_INF;
  var dtx = APS_TERRAIN_INF;
  var dtz = APS_TERRAIN_INF;
  if (sx != 0) {
    let boundary = origin.x + (f32(ix) + select(0.0, 1.0, sx > 0)) * tile.x;
    tnx = t0 + (boundary - p0.x) / d.x;
    dtx = tile.x / abs(d.x);
  }
  if (sz != 0) {
    let boundary = origin.y + (f32(iz) + select(0.0, 1.0, sz > 0)) * tile.y;
    tnz = t0 + (boundary - p0.z) / d.z;
    dtz = tile.y / abs(d.z);
  }
  if (tnx < t0) { tnx = t0; }
  if (tnz < t0) { tnz = t0; }

  var best = apsTerrainMiss();
  var t = t0;
  // A 2D DDA can enter at most maxShape.x + maxShape.y tiles.  This is a
  // completeness bound, not a step budget: every iteration advances one axis.
  let limit = maxShape.x + maxShape.y + 8u;
  for (var steps = 0u; steps < limit; steps++) {
    let tx = u32(clamp(ix, 0, i32(maxShape.x) - 1));
    let tz = u32(clamp(iz, 0, i32(maxShape.y) - 1));
    let nextT = max(t, min(min(tnx, tnz), t1));
    let segEnd = max(t, nextT);
    let minY = min(o.y + d.y * t, o.y + d.y * segEnd);
    if (minY <= apsTerrainTileMax(vec2u(tx, tz)) + APS_TERRAIN_EPS) {
      let hit = apsTerrainTileHit(o, d, t, segEnd, ix, iz, anyHit);
      if (hit.hit != 0u) {
        if (anyHit) { return hit; }
        if (hit.distance < best.distance) { best = hit; }
      }
    }
    if (!(nextT < t1)) { break; }
    t = nextT;
    if (tnx <= tnz) {
      ix += sx;
      if (ix < 0 || ix >= i32(maxShape.x)) { break; }
      tnx += dtx;
    } else {
      iz += sz;
      if (iz < 0 || iz >= i32(maxShape.y)) { break; }
      tnz += dtz;
    }
  }
  return best;
}

fn apsTerrainOccluded(o: vec3f, d: vec3f, maxDistance: f32) -> bool {
  return apsTerrainRayQuery(o, d, maxDistance, true).hit != 0u;
}

`;

                                                                                
export const terrainRayQueryWGSL = terrainOcclusionWGSL +           `
// Unified static query: the shared building SMBSP and the terrain accelerator
// are independent; the returned hit is their minimum t.
fn apsSMBSPTerrainOccluded(o: vec3f, d: vec3f, maxDistance: f32) -> bool {
  if (apsSMBSPOccluded(o, d, maxDistance)) { return true; }
  return apsTerrainOccluded(o, d, maxDistance);
}

fn apsSMBSPTerrainHit(o: vec3f, d: vec3f, maxDistance: f32) -> APSStaticHit {
  let mesh = apsSMBSPHit(o, d, maxDistance);
  let terrain = apsTerrainRayQuery(o, d, maxDistance, false);
  if (mesh.hit != 0u && (terrain.hit == 0u || mesh.distance <= terrain.distance)) {
    return APSStaticHit(1u, mesh.distance, 1u, mesh.position, mesh.normal, mesh.instance, mesh.primitive, mesh.chunk, mesh.geometry, vec2u(0u), 0u, mesh.albedo);
  }
  if (terrain.hit != 0u) {
    return APSStaticHit(1u, terrain.distance, 2u, terrain.position, terrain.normal, 0u, terrain.triangle, 0u, 0u, terrain.cell, terrain.triangle, vec3f(0.0));
  }
  return apsStaticMiss();
}
`;

                                                                              
                                                                           

const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const clampInt = (value, lo, hi) => Math.min(Math.max(value, lo), hi);

function interior(value, lo, hi) {
  return value >= lo && value <= hi;
}

export function buildTerrainRayQuery(native, { targetHeight = null, tileCells = TERRAIN_RAY_TILE_CELLS } = {}) {
  if (!native || !Array.isArray(native.shape) || native.shape.length !== 2) return null;
  const [nz, nx] = native.shape;
  if (!Number.isInteger(nx) || !Number.isInteger(nz) || nx < 2 || nz < 2) throw Error('Terrain ray query needs a 2D grid of at least 2x2 samples');
  if (!Array.isArray(native.spacing) || native.spacing.length !== 2 || !native.spacing.every(isFiniteNumber) || native.spacing.some((v) => v <= 0)) throw Error('Terrain ray query needs positive metric spacing');
  if (!Array.isArray(native.origin) || native.origin.length !== 2 || !native.origin.every(isFiniteNumber)) throw Error('Terrain ray query needs finite origin_xz');
  if (!(native.data instanceof Float32Array) || native.data.length !== nx * nz) throw Error('Terrain ray query height data does not match shape');
  if (targetHeight !== null && targetHeight !== undefined) {
    if (!(targetHeight instanceof Float32Array) || targetHeight.length !== nx * nz) throw Error('Terrain ray query intervention target does not match shape');
  }
  if (!Number.isInteger(tileCells) || tileCells < 1 || tileCells > 64) throw Error('Terrain ray tile size must be an integer in [1,64]');
  const maxWidth = Math.ceil((nx - 1) / tileCells);
  const maxHeight = Math.ceil((nz - 1) / tileCells);
  const maxData = new Float32Array(maxWidth * maxHeight);
  let minY = Infinity;
  let maxY = -Infinity;
  for (let tz = 0; tz < maxHeight; tz += 1) {
    for (let tx = 0; tx < maxWidth; tx += 1) {
      let bound = -Infinity;
      const z0 = tz * tileCells;
      const x0 = tx * tileCells;
      const z1 = Math.min(z0 + tileCells, nz - 1);
      const x1 = Math.min(x0 + tileCells, nx - 1);
      for (let z = z0; z <= z1; z += 1) {
        for (let x = x0; x <= x1; x += 1) {
          const i = z * nx + x;
          const base = native.data[i];
          const value = targetHeight ? Math.max(base, targetHeight[i]) : base;
          if (value > bound) bound = value;
          if (base < minY) minY = base;
          if (base > maxY) maxY = base;
          if (targetHeight) {
            if (targetHeight[i] < minY) minY = targetHeight[i];
            if (targetHeight[i] > maxY) maxY = targetHeight[i];
          }
        }
      }
      maxData[tz * maxWidth + tx] = bound;
    }
  }
  const x0 = native.origin[0];
  const z0 = native.origin[1];
  const x1 = x0 + (nx - 1) * native.spacing[0];
  const z1 = z0 + (nz - 1) * native.spacing[1];
  return {
    enabled: true,
    native,
    heightSha256: native.sha256 ?? null,
    shape: [nz, nx],
    origin: [...native.origin],
    spacing: [...native.spacing],
    data: native.data,
    targetHeight: targetHeight ?? null,
    maxData,
    maxWidth,
    maxHeight,
    tileCells,
    globalMin: minY,
    globalMax: maxY,
    bounds: { min: [x0, minY, z0], max: [x1, maxY, z1] },
    conservative: 'tile max over native and intervention target; skip only above bound + 1e-4m',
    interpolation: 'native DEM triangles, diagonal (1,0)--(0,1)',
    errorBoundM: TERRAIN_RAY_EPS_M,
  };
}

function terrainAxisClip(o, d, lo, hi, t0in, t1in) {
  let t0 = t0in;
  let t1 = t1in;
  if (Math.abs(d) < 1e-20) {
    if (o < lo || o > hi) return null;
  } else {
    const a = (lo - o) / d;
    const b = (hi - o) / d;
    t0 = Math.max(t0, Math.min(a, b));
    t1 = Math.min(t1, Math.max(a, b));
  }
  if (!(t1 >= t0) || !(t1 > 0)) return null;
  return [t0, t1];
}

function terrainTriangle(o, d, a, b, c, t0, t1) {
  const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const p = [
    d[1] * e2[2] - d[2] * e2[1],
    d[2] * e2[0] - d[0] * e2[2],
    d[0] * e2[1] - d[1] * e2[0],
  ];
  const det = e1[0] * p[0] + e1[1] * p[1] + e1[2] * p[2];
  if (Math.abs(det) < 1e-9) return null;
  const inv = 1 / det;
  const s = [o[0] - a[0], o[1] - a[1], o[2] - a[2]];
  const u = (s[0] * p[0] + s[1] * p[1] + s[2] * p[2]) * inv;
  if (u < -TERRAIN_RAY_TRI_EPS || u > 1 + TERRAIN_RAY_TRI_EPS) return null;
  const q = [
    s[1] * e1[2] - s[2] * e1[1],
    s[2] * e1[0] - s[0] * e1[2],
    s[0] * e1[1] - s[1] * e1[0],
  ];
  const v = (d[0] * q[0] + d[1] * q[1] + d[2] * q[2]) * inv;
  if (v < -TERRAIN_RAY_TRI_EPS || u + v > 1 + TERRAIN_RAY_TRI_EPS) return null;
  const t = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) * inv;
  if (!(t > t0 + TERRAIN_RAY_TRI_EPS) || !(t <= t1)) return null;
  return t;
}

function copyTerrainHit(hit) {
  return { ...hit, cell: [...hit.cell], position: [...hit.position], normal: [...hit.normal] };
}

function terrainTileHit(query, o, d, tIn, tOut, ix, iz, anyHit, heightData) {
  let best = null;
  const [nz, nx] = query.shape;
  const [sx, sz] = query.spacing;
  const [ox, oz] = query.origin;
  const cells = query.tileCells;
  const x0 = ix * cells;
  const z0 = iz * cells;
  const x1 = Math.min(x0 + cells, nx - 1);
  const z1 = Math.min(z0 + cells, nz - 1);
  for (let cz = z0; cz < z1; cz += 1) {
    for (let cx = x0; cx < x1; cx += 1) {
      const lox = ox + cx * sx;
      const hix = lox + sx;
      const loz = oz + cz * sz;
      const hiz = loz + sz;
      let seg = terrainAxisClip(o[0], d[0], lox, hix, tIn, tOut);
      if (!seg) continue;
      seg = terrainAxisClip(o[2], d[2], loz, hiz, seg[0], seg[1]);
      if (!seg) continue;
      const y00 = heightData[cz * nx + cx];
      const y10 = heightData[cz * nx + cx + 1];
      const y01 = heightData[(cz + 1) * nx + cx];
      const y11 = heightData[(cz + 1) * nx + cx + 1];
      const cmax = Math.max(y00, y10, y01, y11);
      const minY = Math.min(o[1] + d[1] * seg[0], o[1] + d[1] * seg[1]);
      if (minY > cmax + TERRAIN_RAY_EPS_M) continue;
      const pa = [lox, y00, loz];
      const pb = [hix, y10, loz];
      const pc = [lox, y01, hiz];
      const pd = [hix, y11, hiz];
      let t = terrainTriangle(o, d, pa, pb, pc, seg[0], seg[1]);
      if (t !== null) {
        const hit = {
          hit: true,
          distance: t,
          position: [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t],
          normal: [-(y10 - y00) / sx, 1, -(y01 - y00) / sz],
          cell: [cx, cz],
          triangle: 0,
        };
        const length = Math.hypot(hit.normal[0], hit.normal[1], hit.normal[2]);
        hit.normal = hit.normal.map((v) => v / length);
        if (anyHit) return hit;
        if (!best || t < best.distance) best = hit;
      }
      t = terrainTriangle(o, d, pb, pd, pc, seg[0], seg[1]);
      if (t !== null) {
        const hit = {
          hit: true,
          distance: t,
          position: [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t],
          normal: [-(y11 - y01) / sx, 1, -(y11 - y10) / sz],
          cell: [cx, cz],
          triangle: 1,
        };
        const length = Math.hypot(hit.normal[0], hit.normal[1], hit.normal[2]);
        hit.normal = hit.normal.map((v) => v / length);
        if (anyHit) return hit;
        if (!best || t < best.distance) best = hit;
      }
    }
  }
  return best ? copyTerrainHit(best) : null;
}

export function traceTerrainRayCPU(query, origin, direction, maxDistance = Infinity, { heightData = null } = {}) {
  if (!query?.enabled || !Array.isArray(origin) || !Array.isArray(direction)) return null;
  if (!(maxDistance > 0) || !isFiniteNumber(maxDistance) || !origin.every(isFiniteNumber) || !direction.every(isFiniteNumber)) return null;
  const d2 = direction[0] ** 2 + direction[1] ** 2 + direction[2] ** 2;
  if (d2 <= 0 || query.maxWidth === 0 || query.maxHeight === 0) return null;
  const data = heightData ?? query.data;
  if (!(data instanceof Float32Array) || data.length !== query.shape[0] * query.shape[1]) throw Error('Terrain ray CPU heights do not match shape');
  const [nz, nx] = query.shape;
  const [sx, sz] = query.spacing;
  const [ox, oz] = query.origin;
  let range = terrainAxisClip(origin[0], direction[0], ox, ox + (nx - 1) * sx, 0, maxDistance);
  if (!range) return null;
  range = terrainAxisClip(origin[2], direction[2], oz, oz + (nz - 1) * sz, range[0], range[1]);
  if (!range) return null;
  let t = range[0];
  const t1 = range[1];
  if (!(t1 > t)) return null;
  const tileX = query.tileCells * sx;
  const tileZ = query.tileCells * sz;
  let ix = clampInt(Math.floor((origin[0] + direction[0] * t - ox) / tileX), 0, query.maxWidth - 1);
  let iz = clampInt(Math.floor((origin[2] + direction[2] * t - oz) / tileZ), 0, query.maxHeight - 1);
  const stepX = direction[0] > 1e-20 ? 1 : direction[0] < -1e-20 ? -1 : 0;
  const stepZ = direction[2] > 1e-20 ? 1 : direction[2] < -1e-20 ? -1 : 0;
  let tnx = Infinity;
  let tnz = Infinity;
  let dtx = Infinity;
  let dtz = Infinity;
  if (stepX !== 0) {
    const boundary = ox + (ix + (stepX > 0 ? 1 : 0)) * tileX;
    tnx = t + (boundary - (origin[0] + direction[0] * t)) / direction[0];
    dtx = tileX / Math.abs(direction[0]);
  }
  if (stepZ !== 0) {
    const boundary = oz + (iz + (stepZ > 0 ? 1 : 0)) * tileZ;
    tnz = t + (boundary - (origin[2] + direction[2] * t)) / direction[2];
    dtz = tileZ / Math.abs(direction[2]);
  }
  if (tnx < t) tnx = t;
  if (tnz < t) tnz = t;
  let best = null;
  const limit = query.maxWidth + query.maxHeight + 8;
  for (let steps = 0; steps < limit; steps += 1) {
    const tx = clampInt(ix, 0, query.maxWidth - 1);
    const tz = clampInt(iz, 0, query.maxHeight - 1);
    const nextT = Math.max(t, Math.min(tnx, tnz, t1));
    const segEnd = Math.max(t, nextT);
    const minY = Math.min(origin[1] + direction[1] * t, origin[1] + direction[1] * segEnd);
    if (minY <= query.maxData[tz * query.maxWidth + tx] + TERRAIN_RAY_EPS_M) {
      const hit = terrainTileHit(query, origin, direction, t, segEnd, ix, iz, false, data);
      if (hit && (!best || hit.distance < best.distance)) best = hit;
    }
    if (!(nextT < t1)) break;
    t = nextT;
    if (tnx <= tnz) {
      ix += stepX;
      if (ix < 0 || ix >= query.maxWidth) break;
      tnx += dtx;
    } else {
      iz += stepZ;
      if (iz < 0 || iz >= query.maxHeight) break;
      tnz += dtz;
    }
  }
  return best;
}

export function occludedTerrainCPU(query, origin, direction, maxDistance, options = {}) {
  const hit = traceTerrainRayCPU(query, origin, direction, maxDistance, options);
  return !!hit;
}

export function composedTerrainHeightCPU(native, targetHeight, blendMask, enabled) {
  if (!native?.data) throw Error('Terrain composition needs native data');
  const out = new Float32Array(native.data);
  if (!enabled) return out;
  if (!(targetHeight instanceof Float32Array) || targetHeight.length !== out.length) throw Error('Terrain composition target does not match native');
  if (!(blendMask instanceof Float32Array) || blendMask.length !== out.length) throw Error('Terrain composition mask does not match native');
  for (let i = 0; i < out.length; i += 1) {
    const a = blendMask[i];
    if (a > 0) out[i] = native.data[i] + (targetHeight[i] - native.data[i]) * a;
  }
  return out;
}

                                                                       
                                                                           
                                                       
export function lpvTerrainQueryKey(bsp, intervention, sun, color, sky) {
  const values = [bsp?.revision ?? 0, bsp?.terrainRevision ?? 0, intervention?.revision ?? 0, ...sun, ...color, ...sky];
  return JSON.stringify(values.map((value) => (Number.isFinite(value) ? Math.round(value * 1e4) : value)));
}

                                                                             
                                                                                 
                                                                     
export function terrainRaySourceKey(native, heightTextureId, intervention = null) {
  return JSON.stringify([
    native?.sha256 ?? null,
    native?.shape ?? null,
    native?.spacing ?? null,
    native?.origin ?? null,
    heightTextureId ?? 0,
    intervention?.manifestSha256 ?? null,
    intervention?.targetHeight ? intervention.targetHeight.length : 0,
  ]);
}

export function terrainQueryMetadata(query, intervention = null) {
  if (!query) {
    return {
      enabled: false,
      revision: 0,
      reason: 'no live heightfield / terrain query disabled',
      legacy_result: 'mesh-only apsSMBSPOccluded / apsSMBSPHit retained',
    };
  }
  return {
    enabled: true,
    height_sha256: query.heightSha256,
    height_source: 'viewer.heightfield.heightTexture (live after/before GPU composition; also display + solar caster source)',
    interpolation: query.interpolation,
    tile_cells: query.tileCells,
    tile_bounds: [query.maxWidth, query.maxHeight],
    source_bounds: query.bounds,
    native_origin_xz_m: query.origin,
    native_spacing_xz_m: query.spacing,
    native_shape: query.shape,
    conservative_bounds: query.conservative,
    error_bound_m: query.errorBoundM,
    traversal: '2D tile DDA -> conservative tile/cell max prune -> exact native ray/triangle',
    intervention: intervention
      ? {
          manifest_sha256: intervention.manifestSha256 ?? null,
          state: intervention.enabled ? 'after' : 'before',
          revision: intervention.revision ?? 0,
          target_included_in_bounds: !!query.targetHeight,
        }
      : null,
    composition: 'unified apsSMBSPTerrainOccluded / apsSMBSPTerrainHit: t = min(building mesh, terrain)',
  };
}
