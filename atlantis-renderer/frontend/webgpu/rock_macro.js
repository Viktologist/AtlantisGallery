                                                                           
                                                                           
                                                                     
  
                                                                              
                       
                                                                           
                                                                                  
                                                    
                                                     
                                                              
                                                                     
  
                                                                              
                                                                                
                                                                          
                                                                              

export const ROCK_MACRO = Object.freeze({
                                                                          
  baseFrequencyPerMetre: 0.00016,
  baseWavelengthM: 6250,
                                                                    
  rotation: Object.freeze([1.6, -1.2, 1.2, 1.6]),
  frequencyRatio: 2,
  amplitudeRatio: 0.5,
                                                                           
  attenuation: '1/(1+dot(d,d))',
  conditioningOctaves: 4,                                  
  firstShadingOctave: 4,             
  lastShadingOctave: 10,                 
  shadingOctaves: 7,
                                                                               
                                                                          
                                                                               
                                                                        
  reliefM: 110,
  colorStrength: 0.55,
                                                                           
                                                                         
  maxTiltDegrees: 30,
  maxTiltRadians: 30 * Math.PI / 180,
  triplanarSharpness: 4,
                                                                   
  filterLow: 0.18,
  filterHigh: 0.65,
});

const fract = (x) => x - Math.floor(x);
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

                                                           
export function rockMacroHash12(x, y) {
  const px = 50 * fract(x * 0.3183099);
  const py = 50 * fract(y * 0.3183099);
  return fract(px * py * (px + py));
}

                                                                       
export function rockMacroNoised(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const a = rockMacroHash12(ix, iy);
  const b = rockMacroHash12(ix + 1, iy);
  const c = rockMacroHash12(ix, iy + 1);
  const d = rockMacroHash12(ix + 1, iy + 1);
  const k = a - b - c + d;
  const value = a + (b - a) * ux + (c - a) * uy + k * ux * uy;
  const slope = 6 * fx * (1 - fx);
  const slopeY = 6 * fy * (1 - fy);
                                                        
  const gx = slope * ((b - a) + k * uy);
  const gy = slopeY * ((c - a) + k * ux);
  return {value, gradient: [gx, gy]};
}

                                                                             
                                                                                
export function rockMacroSchedule(lastOctave = ROCK_MACRO.lastShadingOctave) {
  const out = [];
  let amplitude = 1, frequency = ROCK_MACRO.baseFrequencyPerMetre;
  for (let octave = 0; octave <= lastOctave; octave++) {
    out.push({
      octave,
      amplitude,
      frequency,
      wavelengthM: 1 / frequency,
      conditioning: octave < ROCK_MACRO.firstShadingOctave,
      shading: octave >= ROCK_MACRO.firstShadingOctave,
    });
    amplitude *= ROCK_MACRO.amplitudeRatio;
    frequency *= ROCK_MACRO.frequencyRatio;
  }
  return out;
}

export function rockMacroFootprintFade(footprint, frequency, detailGain = 2) {
  const rho = Math.max(0, footprint) * frequency / Math.max(1, detailGain);
  const t = clamp((rho - ROCK_MACRO.filterLow) / (ROCK_MACRO.filterHigh - ROCK_MACRO.filterLow), 0, 1);
  return 1 - t * t * (3 - 2 * t);
}

                                                                              
                                                                          
export function rockMacroPlaneHeight(u, v, duvdx = [0, 0], duvdy = [0, 0], detailGain = 2) {
  const px = Math.hypot(duvdx[0], duvdx[1]);
  const py = Math.hypot(duvdy[0], duvdy[1]);
  const footprint = Math.max(px, py);
  let p = [u * ROCK_MACRO.baseFrequencyPerMetre, v * ROCK_MACRO.baseFrequencyPerMetre];
  let d = [0, 0];
  let b = 1;
  let frequency = ROCK_MACRO.baseFrequencyPerMetre;
  for (let octave = 0; octave < ROCK_MACRO.firstShadingOctave; octave++) {
    const n = rockMacroNoised(p[0], p[1]);
    d[0] += n.gradient[0]; d[1] += n.gradient[1];
    b *= ROCK_MACRO.amplitudeRatio;
    p = [ROCK_MACRO.rotation[0] * p[0] + ROCK_MACRO.rotation[2] * p[1],
      ROCK_MACRO.rotation[1] * p[0] + ROCK_MACRO.rotation[3] * p[1]];
    frequency *= ROCK_MACRO.frequencyRatio;
  }
  let h = 0, normalization = 0;
  for (let octave = ROCK_MACRO.firstShadingOctave; octave <= ROCK_MACRO.lastShadingOctave; octave++) {
    const n = rockMacroNoised(p[0], p[1]);
    d[0] += n.gradient[0]; d[1] += n.gradient[1];
    const attenuation = 1 / (1 + d[0] * d[0] + d[1] * d[1]);
    const fade = rockMacroFootprintFade(footprint, frequency, detailGain);
    h += b * n.value * attenuation * fade;
    normalization += b;
    b *= ROCK_MACRO.amplitudeRatio;
    p = [ROCK_MACRO.rotation[0] * p[0] + ROCK_MACRO.rotation[2] * p[1],
      ROCK_MACRO.rotation[1] * p[0] + ROCK_MACRO.rotation[3] * p[1]];
    frequency *= ROCK_MACRO.frequencyRatio;
  }
  return h / Math.max(normalization, 1e-6);
}

export function rockMacroMask(rockWeight, mud = 0, living = 0, litter = 0) {
  return clamp(rockWeight * (1 - mud) * (1 - living) * (1 - litter), 0, 1);
}

                                                                              
export function rockMacroTriplanarWeights(n) {
  const c = [Math.abs(n[0]) ** ROCK_MACRO.triplanarSharpness,
    Math.abs(n[1]) ** ROCK_MACRO.triplanarSharpness,
    Math.abs(n[2]) ** ROCK_MACRO.triplanarSharpness];
  const sum = c[0] + c[1] + c[2];
  if (!(sum > 1e-6)) return [1 / 3, 1 / 3, 1 / 3];
  return [c[1] / sum, c[0] / sum, c[2] / sum];
}

function planeGradient(axis, P, duvdx, duvdy, detailGain, eps) {
                                      
  const uv = axis === 0 ? [P[0], P[2]] : axis === 1 ? [P[2], P[1]] : [P[0], P[1]];
  const hPlusU = rockMacroPlaneHeight(uv[0] + eps, uv[1], duvdx, duvdy, detailGain);
  const hMinusU = rockMacroPlaneHeight(uv[0] - eps, uv[1], duvdx, duvdy, detailGain);
  const hPlusV = rockMacroPlaneHeight(uv[0], uv[1] + eps, duvdx, duvdy, detailGain);
  const hMinusV = rockMacroPlaneHeight(uv[0], uv[1] - eps, duvdx, duvdy, detailGain);
  const hu = (hPlusU - hMinusU) / (2 * eps);
  const hv = (hPlusV - hMinusV) / (2 * eps);
  return axis === 0 ? [hu, 0, hv] : axis === 1 ? [0, hv, hu] : [hu, hv, 0];
}

                                                                              
                                                                   
export function rockMacroNormal(n, geomN, P, mask, {
  detailGain = 2, reliefM = ROCK_MACRO.reliefM, maxTiltDegrees = ROCK_MACRO.maxTiltDegrees,
  eps = 0.5,
} = {}) {
  const len = Math.hypot(...n) || 1;
  const nn = n.map((x) => x / len);
  const glen = Math.hypot(...geomN) || 1;
  const gn = geomN.map((x) => x / glen);
  const dPdx = [1, 0, 0], dPdy = [0, 0, 1];                              
  const planes = [
    planeGradient(0, P, [dPdx[0], dPdx[2]], [dPdy[0], dPdy[2]], detailGain, eps),
    planeGradient(1, P, [dPdx[2], dPdx[1]], [dPdy[2], dPdy[1]], detailGain, eps),
    planeGradient(2, P, [dPdx[0], dPdx[1]], [dPdy[0], dPdy[1]], detailGain, eps),
  ];
  const w = rockMacroTriplanarWeights(gn);
  let g = [0, 0, 0];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) g[j] += w[i] * planes[i][j];
  const dn = g[0] * nn[0] + g[1] * nn[1] + g[2] * nn[2];
  g = g.map((x, i) => x - nn[i] * dn);
  const m = clamp(mask, 0, 1);
  const maxSlope = Math.tan(maxTiltDegrees * Math.PI / 180);
  let perturb = g.map((x) => -reliefM * m * x);
  const slope = Math.hypot(...perturb);
  if (slope > maxSlope) perturb = perturb.map((x) => x * (maxSlope / slope));
  const result = nn.map((x, i) => x + perturb[i]);
  const resultLength = Math.hypot(...result) || 1;
  return result.map((x) => x / resultLength);
}

export const rockMacroWGSL =           `
const APS_ROCK_MACRO_BASE_FREQUENCY: f32 = ${ROCK_MACRO.baseFrequencyPerMetre};
const APS_ROCK_MACRO_AMPLITUDE: f32 = ${ROCK_MACRO.amplitudeRatio};
const APS_ROCK_MACRO_FIRST_SHADE: i32 = ${ROCK_MACRO.firstShadingOctave};
const APS_ROCK_MACRO_LAST_SHADE: i32 = ${ROCK_MACRO.lastShadingOctave};
const APS_ROCK_MACRO_RELIEF_M: f32 = ${ROCK_MACRO.reliefM.toFixed(1)};
const APS_ROCK_MACRO_MAX_TILT_RAD: f32 = ${ROCK_MACRO.maxTiltRadians};
const APS_ROCK_MACRO_TRIPLANAR_SHARPNESS: f32 = ${ROCK_MACRO.triplanarSharpness.toFixed(1)};
const APS_ROCK_MACRO_FILTER_LOW: f32 = ${ROCK_MACRO.filterLow};
const APS_ROCK_MACRO_FILTER_HIGH: f32 = ${ROCK_MACRO.filterHigh};

fn apsRockMacroHash12(p: vec2f) -> f32 {
  let q = 50.0 * fract(p * 0.3183099);
  return fract(q.x * q.y * (q.x + q.y));
}

fn apsRockMacroNoised(x: vec2f) -> vec3f {
  let cell = floor(x);
  let f = fract(x);
  let u = f * f * (3.0 - 2.0 * f);
  let a = apsRockMacroHash12(cell);
  let b = apsRockMacroHash12(cell + vec2f(1.0, 0.0));
  let c = apsRockMacroHash12(cell + vec2f(0.0, 1.0));
  let d = apsRockMacroHash12(cell + vec2f(1.0, 1.0));
  let k = a - b - c + d;
  let value = a + (b - a) * u.x + (c - a) * u.y + k * u.x * u.y;
  let slope = 6.0 * f * (1.0 - f);
  let gradient = slope * (vec2f(b - a, c - a) + k * u.yx);
  return vec3f(value, gradient);
}

fn apsRockMacroRotate(p: vec2f) -> vec2f {
  // Exact MdGfzh mat2 columns (1.6,-1.2),(1.2,1.6): length 2.
  return mat2x2f(${ROCK_MACRO.rotation.join(', ')}) * p;
}

fn apsRockMacroPlaneHeight(u: f32, v: f32, duvdx: vec2f, duvdy: vec2f, detailGain: f32) -> f32 {
  var p = vec2f(u, v) * APS_ROCK_MACRO_BASE_FREQUENCY;
  var d = vec2f(0.0);
  var b = 1.0;
  var frequency = APS_ROCK_MACRO_BASE_FREQUENCY;
  // Octaves 0..3 do not shade. They exist only so the first macro octave sees
  // the exact cumulative derivative attenuation of the source schedule.
  for (var octave: i32 = 0; octave < APS_ROCK_MACRO_FIRST_SHADE; octave = octave + 1) {
    let n = apsRockMacroNoised(p);
    d = d + n.yz;
    b = b * APS_ROCK_MACRO_AMPLITUDE;
    p = apsRockMacroRotate(p);
    frequency = frequency * ${ROCK_MACRO.frequencyRatio.toFixed(1)};
  }
  var h = 0.0;
  var normalization = 0.0;
  for (var octave: i32 = APS_ROCK_MACRO_FIRST_SHADE; octave <= APS_ROCK_MACRO_LAST_SHADE; octave = octave + 1) {
    let n = apsRockMacroNoised(p);
    d = d + n.yz;
    let attenuation = 1.0 / (1.0 + dot(d, d));
    let rho = max(length(duvdx), length(duvdy)) * frequency / max(detailGain, 1.0);
    let fade = 1.0 - smoothstep(APS_ROCK_MACRO_FILTER_LOW, APS_ROCK_MACRO_FILTER_HIGH, rho);
    h = h + b * n.x * attenuation * fade;
    normalization = normalization + b;
    b = b * APS_ROCK_MACRO_AMPLITUDE;
    p = apsRockMacroRotate(p);
    frequency = frequency * ${ROCK_MACRO.frequencyRatio.toFixed(1)};
  }
  return h / max(normalization, 1e-6);
}

fn apsRockMacroScreenGradient(N: vec3f, h: f32, px: vec3f, py: vec3f) -> vec3f {
  let rx = cross(py, N);
  let ry = cross(N, px);
  let det = dot(px, rx);
  let limit = 1e-5 * max(length(px) * length(py), 1e-20);
  if (abs(det) <= limit) { return vec3f(0.0); }
  return (dpdx(h) * rx + dpdy(h) * ry) / det;
}

// Order is (XZ by |N.y|, ZY by |N.x|, XY by |N.z|).
fn apsRockMacroWeights(N: vec3f) -> vec3f {
  let c = pow(abs(N), vec3f(APS_ROCK_MACRO_TRIPLANAR_SHARPNESS));
  let sum = c.x + c.y + c.z;
  if (sum <= 1e-6) { return vec3f(1.0 / 3.0); }
  // XZ uses the vertical |N.y|; ZY uses the east |N.x|; XY uses the north |N.z|.
  return vec3f(c.y / sum, c.x / sum, c.z / sum);
}

// Shading-only macro rock normal. nIn is the saved/scanned PBR normal after
// those layers have run; geomN is the untouched native geometry normal used
// for stable triplanar cliff weights. The caller's hemisphere guard still runs
// after this function.
struct APSRockMacroSample {value:f32,gradient:vec3f};
fn apsRockMacroSample(geomN: vec3f, P: vec3f, detailGain: f32) -> APSRockMacroSample {
  let N = normalize(geomN);
  let px = dpdx(P);
  let py = dpdy(P);
  let hXZ = apsRockMacroPlaneHeight(P.x, P.z, vec2f(px.x, px.z), vec2f(py.x, py.z), detailGain);
  let hZY = apsRockMacroPlaneHeight(P.z, P.y, vec2f(px.z, px.y), vec2f(py.z, py.y), detailGain);
  let hXY = apsRockMacroPlaneHeight(P.x, P.y, vec2f(px.x, px.y), vec2f(py.x, py.y), detailGain);
  // Reconstruct the surface gradient against the stable native geometry
  // normal; the scanned shading normal is perturbed afterwards, not used as a
  // derivative basis (which would inject scanned-normal noise into the macro
  // layer).
  let gXZ = apsRockMacroScreenGradient(N, hXZ, px, py);
  let gZY = apsRockMacroScreenGradient(N, hZY, px, py);
  let gXY = apsRockMacroScreenGradient(N, hXY, px, py);
  let w = apsRockMacroWeights(N);
  let g = w.x * gXZ + w.y * gZY + w.z * gXY;
  return APSRockMacroSample(dot(w,vec3f(hXZ,hZY,hXY)),g);
}
fn apsRockMacroApplyNormal(nIn:vec3f,gradient:vec3f,mask:f32)->vec3f {
  let n=normalize(nIn);
  var g=gradient;
  g = g - n * dot(n, g);
  var perturb = -APS_ROCK_MACRO_RELIEF_M * clamp(mask, 0.0, 1.0) * g;
  let maxSlope = tan(APS_ROCK_MACRO_MAX_TILT_RAD);
  let slope = length(perturb);
  if (slope > maxSlope) { perturb = perturb * (maxSlope / slope); }
  return normalize(n + perturb);
}
fn apsRockMacroNormal(nIn:vec3f,geomN:vec3f,P:vec3f,mask:f32,detailGain:f32)->vec3f {
 let field=apsRockMacroSample(geomN,P,detailGain);
 return apsRockMacroApplyNormal(nIn,field.gradient,mask);
}
// Multiplicative palette modulation preserves the RGB residual of the scanned
// PBR texture. Palette changes can be made independently of the noise itself.
fn apsRockMacroColor(base:vec3f,value:f32,mask:f32,low:vec3f,high:vec3f)->vec3f {
 let tone=smoothstep(.03,.5,value);
 let palette=mix(low,high,tone);let midpoint=(low+high)*.5;
 let ratio=clamp(palette/max(midpoint,vec3f(.01)),vec3f(.65),vec3f(1.35));
 let factor=mix(vec3f(1),ratio*(.8+.4*tone),${ROCK_MACRO.colorStrength}*clamp(mask,0.0,1.0));
 return clamp(base*factor,vec3f(0),vec3f(1));
}
`;

export const ROCK_MACRO_SHADER_REFERENCES = Object.freeze({
  source: 'https://www.shadertoy.com/view/MdGfzh',
  bufferC: 'https://raw.githubusercontent.com/reindernijhoff/shadertoy/master/himalayas/Buffer%20C.glsl',
  common: 'https://raw.githubusercontent.com/reindernijhoff/shadertoy/master/himalayas/Common.glsl',
});
