                                                                                  
                                                                             
   
const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
const smooth = (a, b, v) => { const q = clamp((v - a) / (b - a)); return q * q * (3 - 2 * q); };
const BAND = 48;
const BUCKET = 12;

function imageSize(size) {
  if (!Number.isInteger(size) || size < 2) throw new RangeError('size must be an integer >= 2');
}

                                                               
                                                                            
                                                                            
                                                     
                                                                         
                                                                               
                                                                       
   
export function createCoastProfileMap({ data, shape, spacing, origin = [0, 0] }, sea, size = 128) {
  imageSize(size);
  const [nz, nx] = shape ?? [];
  const [dx, dz] = typeof spacing === 'number' ? [spacing, spacing] : (spacing ?? []);
  const ox = origin[0], oz = origin.length === 3 ? origin[2] : origin[1];
  if (![nx, nz].every(v => Number.isInteger(v) && v >= 2) || data?.length !== nx * nz ||
      ![dx, dz].every(v => Number.isFinite(v) && v > 0) || ![ox, oz, sea].every(Number.isFinite)) {
    throw new TypeError('Expected native row-major DEM, finite sea/origin and positive metric spacing');
  }
  const extent = [(nx - 1) * dx, (nz - 1) * dz];
  if (!extent.every(Number.isFinite)) throw new RangeError('Nonfinite DEM extent');
  const segments = [], parents = [], edgeOwner = new Map(), edgeDegree = new Map();
  const root = id => { while (parents[id] !== id) { parents[id] = parents[parents[id]]; id = parents[id]; } return id; };
  function add(a, b, h, ix, iz) {
    const vx = b.x - a.x, vz = b.z - a.z, length = Math.hypot(vx, vz);
    if (length < 1e-12) return;
    const fx = ((a.x + b.x) * .5 - ix * dx) / dx;
    const fz = ((a.z + b.z) * .5 - iz * dz) / dz;
    const gx = ((h[1] - h[0]) * (1 - fz) + (h[2] - h[3]) * fz) / dx;
    const gz = ((h[3] - h[0]) * (1 - fx) + (h[2] - h[1]) * fx) / dz;
    let sx = -vz / length, sz = vx / length;
    if (sx * gx + sz * gz > 0) { sx = -sx; sz = -sz; }
    const id = segments.length;
    segments.push({ a, b, vx, vz, length2: length * length, sx, sz });
    parents.push(id);
    for (const p of [a, b]) {
      edgeDegree.set(p.key, (edgeDegree.get(p.key) ?? 0) + 1);
      if (edgeOwner.has(p.key)) parents[root(id)] = root(edgeOwner.get(p.key));
      else edgeOwner.set(p.key, id);
    }
  }
                                                                             
                                                                                    
  for (let iz = 0; iz < nz - 1; iz++) for (let ix = 0; ix < nx - 1; ix++) {
    const index = iz * nx + ix;
    const h = [data[index] - sea, data[index + 1] - sea,
      data[index + nx + 1] - sea, data[index + nx] - sea];
    if (!h.every(Number.isFinite)) continue;
    const corners = [[ix * dx, iz * dz], [(ix + 1) * dx, iz * dz],
      [(ix + 1) * dx, (iz + 1) * dz], [ix * dx, (iz + 1) * dz]];
    const keys = [`h:${iz}:${ix}`, `v:${iz}:${ix + 1}`, `h:${iz + 1}:${ix}`, `v:${iz}:${ix}`];
    const crossings = [];
    for (let e = 0; e < 4; e++) {
      const j = (e + 1) % 4;
      if ((h[e] > 0) === (h[j] > 0)) continue;
      const t = h[e] / (h[e] - h[j]);
                                                                              
      const vertex = t === 0 ? e : t === 1 ? j : -1;
      const key = vertex < 0 ? keys[e] : `p:${ix + (vertex === 1 || vertex === 2 ? 1 : 0)}:${iz + (vertex >= 2 ? 1 : 0)}`;
      crossings.push({ x: corners[e][0] + t * (corners[j][0] - corners[e][0]),
        z: corners[e][1] + t * (corners[j][1] - corners[e][1]), key });
    }
    if (crossings.length === 2) add(crossings[0], crossings[1], h, ix, iz);
    else if (crossings.length === 4) {
      if (h[0] * h[2] - h[1] * h[3] >= 0) {
        add(crossings[0], crossings[1], h, ix, iz); add(crossings[2], crossings[3], h, ix, iz);
      } else {
        add(crossings[0], crossings[3], h, ix, iz); add(crossings[1], crossings[2], h, ix, iz);
      }
    }
  }
  const buckets = new Map();
  for (let id = 0; id < segments.length; id++) {
    const { a, b } = segments[id];
    for (let z = Math.floor(Math.min(a.z, b.z) / BUCKET); z <= Math.floor(Math.max(a.z, b.z) / BUCKET); z++) {
      for (let x = Math.floor(Math.min(a.x, b.x) / BUCKET); x <= Math.floor(Math.max(a.x, b.x) / BUCKET); x++) {
        const key = `${x}:${z}`;
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(id);
      }
    }
  }
  const output = new Float32Array(size * size * 4);
  const coast = new Int32Array(size * size).fill(-1);
  const feet = new Float64Array(size * size * 2);
  const tx = extent[0] / size, tz = extent[1] / size;
  const edgeFade = Math.min(4, Math.max(dx, dz, Math.min(tx, tz)));
                                                                               
                                                                              
                                                                            
  const endBuckets = new Map();
  for (const s of segments) for (const p of [s.a, s.b]) if (edgeDegree.get(p.key) === 1) {
    const key = `${Math.floor(p.x / BUCKET)}:${Math.floor(p.z / BUCKET)}`;
    if (!endBuckets.has(key)) endBuckets.set(key, []);
    endBuckets.get(key).push(p);
  }
  let found = 0, missing = 0, distanceMin = Infinity, distanceMax = -Infinity;
  const visited = new Int32Array(segments.length).fill(-1);
  for (let row = 0; row < size; row++) for (let col = 0; col < size; col++) {
    const i = row * size + col, k = i * 4, x = (col + .5) * tx, z = (row + .5) * tz;
    const ix = Math.min(nx - 2, Math.floor(x / dx)), iz = Math.min(nz - 2, Math.floor(z / dz));
    const q = iz * nx + ix, fx = x / dx - ix, fz = z / dz - iz;
    const h = [data[q], data[q + 1], data[q + nx], data[q + nx + 1]];
    if (!h.every(Number.isFinite)) { missing++; continue; }
    const wet = (1 - fz) * ((1 - fx) * h[0] + fx * h[1]) + fz * ((1 - fx) * h[2] + fx * h[3]) <= sea;
    const sign = wet ? 1 : -1;
    output[k] = sign * BAND;
    let best = BAND * BAND, chosen = -1, px = 0, pz = 0;
    for (let bz = Math.floor((z - BAND) / BUCKET); bz <= Math.floor((z + BAND) / BUCKET); bz++) {
      for (let bx = Math.floor((x - BAND) / BUCKET); bx <= Math.floor((x + BAND) / BUCKET); bx++) {
        for (const id of buckets.get(`${bx}:${bz}`) ?? []) {
          if (visited[id] === i) continue;
          visited[id] = i;
          const s = segments[id], t = clamp(((x - s.a.x) * s.vx + (z - s.a.z) * s.vz) / s.length2);
          const cx = s.a.x + t * s.vx, cz = s.a.z + t * s.vz;
          const d2 = (x - cx) ** 2 + (z - cz) ** 2;
          if (d2 < best) { best = d2; chosen = id; px = cx; pz = cz; }
        }
      }
    }
    if (chosen < 0) continue;
    const distance = Math.sqrt(best), s = segments[chosen];
    output[k] = sign * distance;
    output[k + 1] = distance > 1e-9 ? sign * (x - px) / distance : s.sx;
    output[k + 2] = distance > 1e-9 ? sign * (z - pz) / distance : s.sz;
                                                                                
                                                                              
    let boundary = Math.min(x, z, extent[0] - x, extent[1] - z,
      px, pz, extent[0] - px, extent[1] - pz);
    for (let bz = Math.floor((pz - edgeFade) / BUCKET); bz <= Math.floor((pz + edgeFade) / BUCKET); bz++) {
      for (let bx = Math.floor((px - edgeFade) / BUCKET); bx <= Math.floor((px + edgeFade) / BUCKET); bx++) {
        for (const end of endBuckets.get(`${bx}:${bz}`) ?? []) boundary = Math.min(boundary, Math.hypot(px - end.x, pz - end.z));
      }
    }
    output[k + 3] = smooth(0, edgeFade, boundary) * (1 - smooth(36, BAND, distance));
    coast[i] = root(chosen); feet[i * 2] = px; feet[i * 2 + 1] = pz;
    found++; distanceMin = Math.min(distanceMin, output[k]); distanceMax = Math.max(distanceMax, output[k]);
  }
                                                                                
                                                                          
                                                                         
  const raw = output.slice();
                                                                         
  const radius = Math.max(Math.min(8, Math.max(dx, dz)), 1.6 * Math.hypot(tx, tz));
  for (let row = 0; row < size; row++) for (let col = 0; col < size; col++) {
    const i = row * size + col, k = i * 4;
    if (raw[k + 3] <= 0) continue;
    let sx = raw[k + 1] * 2, sz = raw[k + 2] * 2;
    for (let v = -1; v <= 1; v++) for (let u = -1; u <= 1; u++) {
      if ((u === 0 && v === 0) || row + v < 0 || row + v >= size || col + u < 0 || col + u >= size) continue;
      const j = (row + v) * size + col + u, l = j * 4;
      const separation = Math.hypot(u * tx, v * tz);
      if (separation > radius || coast[j] !== coast[i] || raw[l + 3] <= 0 ||
          Math.hypot(feet[j * 2] - feet[i * 2], feet[j * 2 + 1] - feet[i * 2 + 1]) > 2 * radius) continue;
      const alignment = raw[k + 1] * raw[l + 1] + raw[k + 2] * raw[l + 2];
      if (alignment < .5) continue;
      const w = Math.exp(-2 * (separation / radius) ** 2) * alignment * raw[l + 3];
      sx += w * raw[l + 1]; sz += w * raw[l + 2];
    }
    const length = Math.hypot(sx, sz);
    output[k + 1] = sx / length; output[k + 2] = sz / length;
  }
  return { data: output, size, origin: [ox, oz], extent,
    stats: { segmentCount: segments.length, coastComponentCount: new Set(segments.map((_, i) => root(i))).size,
      searchRadiusMeters: BAND, distanceSaturatedOutsideBand: true, matchedTexels: found,
      missingDemTexels: missing, boundaryFadeMeters: edgeFade, signedDistanceRange: found ? [distanceMin, distanceMax] : null,
      texelSpacing: [tx, tz], normalSmoothingRadiusMeters: radius } };
}

export const WAVE_PROFILE_METADATA = Object.freeze({
  normalizedWidth: 1, normalizedHeight: 1,
  channels: Object.freeze(['horizontalOffset/profileWidth', 'elevation/waveHeight', 'whiteHeadDensity', 'aeratedWashDensity']),
  coordinateConvention: 'x=u+R; seaward distance positive; front/lip toward smaller x',
  sampleConvention: 'endpoint-inclusive LUT: texel UV=(parameter*(size-1)+0.5)/size; wrap u, clamp lifecycle t',
  primaryReference: 'https://imaginaryblend.com/2023/05/25/fluid-flux-2-0-release-notes/',
  provenance: 'Original authored Hermite control points; visual approximation, not overturning SWE or proprietary assets',
});

const U = [0, .12, .24, .34, .43, .50, .57, .64, .76, .88, 1];
const FLAT = U.map(() => 0);
                                                                            
                                                                  
const STAGES = [
  { t: 0, r: FLAT, y: FLAT, head: 0, wash: 0 },
  { t: .20, r: FLAT, y: [0, -.025, -.06, -.03, .08, .24, .43, .55, .36, .08, 0], head: 0, wash: 0 },
  { t: .36, r: FLAT, y: [0, -.05, -.11, -.02, .12, .42, .78, .92, .50, .10, 0], head: 0, wash: 0 },
  { t: .55, r: [0, 0, 0, 0, .03, .01, -.25, -.05, 0, 0, 0],
    y: [0, -.07, -.14, .03, .25, .52, .82, 1, .55, .12, 0], head: 1, wash: .65 },
  { t: .72, r: [0, 0, -.015, -.02, .02, -.015, -.28, -.06, 0, 0, 0],
    y: [0, -.035, -.07, .025, .08, .14, .27, .46, .29, .08, 0], head: .8, wash: 1 },
  { t: .86, r: [0, 0, -.015, -.025, -.03, -.03, -.025, -.015, 0, 0, 0],
    y: [0, -.01, -.02, .025, .09, .12, .10, .07, .04, .015, 0], head: 0, wash: .7 },
  { t: 1, r: FLAT, y: FLAT, head: 0, wash: 0 },
];

function slopes(values, monotone) {
  const m = values.map(() => 0);                                                   
  for (let i = 1; i < U.length - 1; i++) {
    const a = (values[i] - values[i - 1]) / (U[i] - U[i - 1]);
    const b = (values[i + 1] - values[i]) / (U[i + 1] - U[i]);
    if (!monotone) m[i] = (values[i + 1] - values[i - 1]) / (U[i + 1] - U[i - 1]);
    else if (a * b > 0) {
      const left = U[i] - U[i - 1], right = U[i + 1] - U[i];
      const w1 = 2 * right + left, w2 = right + 2 * left;
      m[i] = (w1 + w2) / (w1 / a + w2 / b);
    }
  }
  return m;
}

function hermite(values, m, u, derivative = false) {
  let i = 0;
  while (i < U.length - 2 && u > U[i + 1]) i++;
  const width = U[i + 1] - U[i], q = (u - U[i]) / width;
  if (derivative) return ((6 * q * q - 6 * q) * values[i] + (-6 * q * q + 6 * q) * values[i + 1]) / width +
    (3 * q * q - 4 * q + 1) * m[i] + (3 * q * q - 2 * q) * m[i + 1];
  return (2 * q ** 3 - 3 * q * q + 1) * values[i] + (q ** 3 - 2 * q * q + q) * width * m[i] +
    (-2 * q ** 3 + 3 * q * q) * values[i + 1] + (q ** 3 - q * q) * width * m[i + 1];
}

function section(t) {
  let i = 0;
  while (i < STAGES.length - 2 && t > STAGES[i + 1].t) i++;
  const a = STAGES[i], b = STAGES[i + 1], w = smooth(a.t, b.t, t);
  const mix = (x, y) => x + (y - x) * w;
  const r = a.r.map((v, j) => mix(v, b.r[j])), y = a.y.map((v, j) => mix(v, b.y[j]));
  const rm = slopes(r, false), ym = slopes(y, true);
                                                                           
                                                                               
  const j = 5, width = U[j + 1] - U[j], delta = (r[j + 1] - r[j]) / width;
  const qa = -6 * delta + 3 * rm[j] + 3 * rm[j + 1];
  const qb = 6 * delta - 4 * rm[j] - 2 * rm[j + 1];
  const q = Math.abs(qa) > 1e-12 ? clamp(-qb / (2 * qa)) : 0;
  const minDx = Math.min(1 + rm[j], 1 + rm[j + 1], 1 + qa * q * q + qb * q + rm[j]);
  return { r, y, rm, ym, head: mix(a.head, b.head) * smooth(0, .8, -minDx), wash: mix(a.wash, b.wash) };
}

function sampleSection(u, s) {
                                                                               
  const head = s.head * smooth(.41, .49, u) * (1 - smooth(.59, .67, u));
  const wash = s.wash * smooth(.49, .64, u) * (1 - smooth(.83, .98, u));
  return [hermite(s.r, s.rm, u), hermite(s.y, s.ym, u), head, wash];
}

                                                                          
                                                                          
   
export function sampleWaveProfile(u, t) {
  if (![u, t].every(Number.isFinite)) throw new TypeError('Finite wave parameters required');
  u = u >= 0 && u <= 1 ? u : ((u % 1) + 1) % 1;
  return sampleSection(u, section(clamp(t)));
}

                                                                          
                                                                           
   
export function createWaveProfile(size = 128) {
  imageSize(size);
  const data = new Float32Array(size * size * 4);
  const min = [Infinity, Infinity, Infinity, Infinity], max = min.map(() => -Infinity);
  for (let row = 0; row < size; row++) {
    const s = section(row / (size - 1));
    for (let col = 0; col < size; col++) {
      const rgba = sampleSection(col / (size - 1), s), k = (row * size + col) * 4;
      for (let c = 0; c < 4; c++) { data[k + c] = rgba[c]; min[c] = Math.min(min[c], data[k + c]); max[c] = Math.max(max[c], data[k + c]); }
    }
  }
  return { data, size, metadata: WAVE_PROFILE_METADATA, stats: { channelMin: min, channelMax: max } };
}
