                                                                         
                                                                            
                                                                           
const clamp = x => Math.max(0, Math.min(1, x));
function radicalInverse(b) {
  b = (b << 16) | (b >>> 16);
  b = ((b & 0x55555555) << 1) | ((b & 0xaaaaaaaa) >>> 1);
  b = ((b & 0x33333333) << 2) | ((b & 0xcccccccc) >>> 2);
  b = ((b & 0x0f0f0f0f) << 4) | ((b & 0xf0f0f0f0) >>> 4);
  b = ((b & 0x00ff00ff) << 8) | ((b & 0xff00ff00) >>> 8);
  return (b >>> 0) * 2.3283064365386963e-10;
}
const fifth = x => { const t = clamp(1 - x); return t ** 5; };
const smith = (x, a) => 2 * x / Math.max(x + Math.sqrt(a * a + (1 - a * a) * x * x), 1e-7);
export function integrateTerrainBRDF(nv, roughness, samples = 256) {
  nv = Math.max(nv, 1e-5); const vx = Math.sqrt(Math.max(0, 1 - nv * nv)), a = Math.max(.001, roughness * roughness);
  let A = 0, B = 0, sheen = 0, diffuse = 0;
  for (let i = 0; i < samples; i++) {
    const ux = (i + .5) / samples, phi = 2 * Math.PI * radicalInverse(i);
    const hz = Math.sqrt((1 - ux) / (1 + (a * a - 1) * ux)), hr = Math.sqrt(Math.max(0, 1 - hz * hz));
    const hx = hr * Math.cos(phi), vh = Math.max(vx * hx + nv * hz, 0), nl = 2 * vh * hz - nv;
    if (nl > 0 && vh > 0) { const vis = smith(nv, a) * smith(nl, a) * vh / Math.max(hz * nv, 1e-7), fc = fifth(vh); A += (1 - fc) * vis; B += fc * vis; }
    const r = Math.sqrt(ux), dx = r * Math.cos(phi), dz = Math.sqrt(1 - ux);
    const dv = dx * vx + dz * nv, dh = (1 + dv) / Math.sqrt(Math.max(2 + 2 * dv, 1e-12));
    sheen += Math.PI * fifth(dh);
    let t = dv - dz * nv; if (t > 0) t /= Math.max(dz, nv, 1e-7);
    diffuse += Math.PI / (Math.PI + ((3 * Math.PI - 4) / 6) * roughness) * (1 + roughness * t);
  }
  A = Math.max(A / samples, 0); B = Math.max(B / samples, 0); const total = Math.max(1, A + B);
  return [A / total, B / total, clamp(sheen / samples), clamp(diffuse / samples)];
}
let cached;
export function terrainBRDFTable() {
  if (cached) return cached;
  const size = 128, data = new Float32Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) data.set(integrateTerrainBRDF((x + .5) / size, (y + .5) / size), (y * size + x) * 4);
  cached = {size, data}; return cached;
}
export const terrainBRDFWGSL =           `
fn apsTerrainDFG(nv: f32, rough: f32) -> vec4f {
  let dim = vec2i(textureDimensions(terrainDFG, 0));
  let p = clamp(vec2f(nv, rough) * vec2f(dim) - 0.5, vec2f(0.0), vec2f(dim - 1));
  let q = min(vec2i(floor(p)), dim - 2); let f = p - vec2f(q);
  return mix(mix(textureLoad(terrainDFG, q, 0), textureLoad(terrainDFG, q + vec2i(1, 0), 0), f.x),
    mix(textureLoad(terrainDFG, q + vec2i(0, 1), 0), textureLoad(terrainDFG, q + vec2i(1), 0), f.x), f.y);
}
`;
