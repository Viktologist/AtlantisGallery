                                                                              
                                                                               
                                                                     
export const INLAND_MAX_BODIES = 16;
                                                                        
                                                                               
                                                                        
export const INLAND_BODY_ROWS = 9;

export const INLAND_WATER_DEFAULTS = Object.freeze({
  absorption: Object.freeze([0.32, 0.055, 0.025]),
  scatter: Object.freeze([0.008, 0.012, 0.016]),
  river_absorption: Object.freeze([0.55, 0.12, 0.06]),
  river_scatter: Object.freeze([0.02, 0.025, 0.03]),
  ior: 1.333,
  refraction: 1,
  max_refraction_path_m: 180,
  caustics: true,
  caustic_strength: 1,
  caustic_max_depth_m: 12,
  river_caustic_max_depth_m: 6,
  caustic_plane_m: 1,
  wetness: true,
  wet_width_m: 0.1,
  wet_darkening: 0.18,
  reflections: true,
  max_reflection_distance_m: 16000,
  river_flow_speed_m_s: 0.4,
  river_wave_amplitude_m: 0.025,
  river_wave_wavelength_m: 1.6,
});

const OWNED = new Set(Object.keys(INLAND_WATER_DEFAULTS));
const TYPE = {kind: 'string', fallback: 'boolean', sun_transmission: 'boolean'};

function finite(value, name, {min = -Infinity, max = Infinity, positive = false} = {}) {
  if (!Number.isFinite(value) || value < min || value > max || (positive && value <= 0)) {
    throw new Error(`Invalid inland water ${name}`);
  }
  return value;
}
function vector(value, n, name, {positive = false, max = Infinity} = {}) {
  if (!Array.isArray(value) || value.length !== n || !value.every(v => Number.isFinite(v) && v >= 0 && v <= max) || (positive && value.some(v => v <= 0))) {
    throw new Error(`Invalid inland water ${name}`);
  }
  return [...value];
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

                                                                       
export function validateInlandWaterConfig(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Inland water options must be an object');
  for (const key of Object.keys(input)) if (!OWNED.has(key)) throw new Error(`Unknown inland water option: ${key}`);
  const o = {...INLAND_WATER_DEFAULTS, ...input};
  o.absorption = vector(o.absorption, 3, 'absorption');
  o.scatter = vector(o.scatter, 3, 'scatter');
  o.river_absorption = vector(o.river_absorption, 3, 'river absorption');
  o.river_scatter = vector(o.river_scatter, 3, 'river scatter');
  finite(o.ior, 'IOR', {min: 1, max: 4});
  finite(o.refraction, 'refraction', {min: 0, max: 4});
  finite(o.max_refraction_path_m, 'maximum refraction path', {positive: true, max: 10000});
  finite(o.caustic_strength, 'caustic strength', {min: 0, max: 4});
  finite(o.caustic_max_depth_m, 'caustic maximum depth', {positive: true, max: 200});
  finite(o.river_caustic_max_depth_m, 'river caustic maximum depth', {positive: true, max: 200});
  finite(o.caustic_plane_m, 'caustic plane', {positive: true, max: 4});
  finite(o.wet_width_m, 'wet width', {min: 0, max: 5});
  finite(o.wet_darkening, 'wet darkening', {min: 0, max: 1});
  finite(o.max_reflection_distance_m, 'maximum reflection distance', {positive: true, max: 1e6});
  finite(o.river_flow_speed_m_s, 'fallback river flow speed', {min: 0, max: 20});
  finite(o.river_wave_amplitude_m, 'fallback river wave amplitude', {min: 0, max: 1});
  finite(o.river_wave_wavelength_m, 'fallback river wavelength', {min: 0.02, max: 1000});
  for (const key of ['caustics', 'wetness', 'reflections']) if (typeof o[key] !== 'boolean') throw new Error(`Invalid inland water ${key}`);
  return Object.freeze(o);
}

export function inlandExtinction(absorption, scatter) {
  const a = vector(absorption, 3, 'absorption'), s = vector(scatter, 3, 'scatter');
  if (a.some((v, i) => v + s[i] <= 0)) throw new Error('Inland water extinction must be positive');
  return a.map((v, i) => v + s[i]);
}
export function beerTransmittance(extinction, path) {
  if (!Array.isArray(extinction) || extinction.length !== 3 || !extinction.every(Number.isFinite)) throw new Error('Invalid extinction');
  finite(path, 'optical path', {min: 0, max: 1e9});
  return extinction.map(v => Math.exp(-v * path));
}
export function fresnelDielectric(cosI, eta) {
  finite(cosI, 'Fresnel cosine', {min: -1, max: 1});
  finite(eta, 'Fresnel IOR ratio', {min: 1e-6, max: 1e6});
  const c = Math.min(1, Math.max(0, cosI));
  const sin2 = (1 - c * c) / (eta * eta);
  if (sin2 >= 1) return 1;
  const ct = Math.sqrt(1 - sin2);
  const rs = (c - eta * ct) / (c + eta * ct);
  const rp = (eta * c - ct) / (eta * c + ct);
  return 0.5 * (rs * rs + rp * rp);
}
                                                                       
export function causticFocus(jacobian, minJacobian = 0.16, maxFocus = 4, strength = 1) {
  finite(jacobian, 'caustic Jacobian', {min: 0, max: 1e12});
  finite(strength, 'caustic strength', {min: 0, max: 4});
  if (jacobian <= 0) return 1;
  const focus = Math.min(maxFocus, Math.max(0.15, 1 / Math.max(minJacobian, jacobian)));
  return Math.max(0.05, 1 + (focus - 1) * strength);
}
export function wetContactWeight(gap, width) {
  finite(gap, 'wet contact gap'); finite(width, 'wet contact width', {positive: true});
  const a = Math.abs(gap);
  if (a >= width) return 0;
  const t = Math.min(1, Math.max(0, a / width));
  const s = t * t * (3 - 2 * t);
  return 1 - s;
}
                                                                             
                                                                           
export function classifySavedWaterKind(file, kind) {
  if (kind !== undefined) {
    if (!['lake', 'river', 'ocean'].includes(kind)) throw new Error(`Unsupported saved water kind: ${kind}`);
    return kind;
  }
  const name = String(file ?? '');
  if (/ocean|sea[_.\-\s]|tidewater/i.test(name)) return 'ocean';
  if (/river|stream|creek|canal|flowline|waterway/i.test(name)) return 'river';
  return 'lake';
}
function num(value) { return Number.isFinite(value) ? value : undefined; }
                                                                             
export function normalizeRiverFlow(row = {}) {
  const direction = row.flow_direction ?? row.flowDirection ?? row.flow_direction_xz;
  const speed = num(row.flow_speed_m_s) ?? num(row.flow_speed) ?? num(row.flowSpeed);
  let dir = null;
  if (direction !== undefined) {
    if (!Array.isArray(direction) || direction.length !== 2 || !direction.every(Number.isFinite) || Math.hypot(...direction) < 1e-8) {
      throw new Error('Invalid saved river flow_direction');
    }
    const n = Math.hypot(...direction); dir = [direction[0] / n, direction[1] / n];
  }
  if (speed !== undefined) finite(speed, 'saved river flow speed', {min: 0, max: 20});
  return {direction: dir, speed: speed ?? null, explicit_direction: dir !== null, explicit_speed: speed !== undefined};
}
                                                                            
                                                                      
export function fitWaterPlane(points, indices = null) {
  if (!points || points.length % 3 || points.length < 9 || !points.every(Number.isFinite)) throw new Error('Saved water plane needs finite triangles');
  let nx = 0, ny = 0, nz = 0, cx = 0, cy = 0, cz = 0, count = 0;
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity, minY = Infinity, maxY = -Infinity;
  const faces = indices ? indices.length / 3 : points.length / 9;
  if (!Number.isInteger(faces) || faces < 1) throw new Error('Saved water plane needs complete triangles');
  const at = i => [points[i * 3], points[i * 3 + 1], points[i * 3 + 2]];
  for (let f = 0; f < faces; f++) {
    const ia = indices ? indices[f * 3] : f * 3;
    const ib = indices ? indices[f * 3 + 1] : f * 3 + 1;
    const ic = indices ? indices[f * 3 + 2] : f * 3 + 2;
    if ([ia, ib, ic].some(i => !Number.isInteger(i) || i < 0 || i * 3 + 2 >= points.length)) throw new Error('Saved water plane index outside triangles');
    const a = at(ia), b = at(ib), c = at(ic);
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
                                                                
    nx += uy * vz - uz * vy; ny += uz * vx - ux * vz; nz += ux * vy - uy * vx;
    const area = Math.hypot(ux * vy - uy * vx, uy * vz - uz * vy, uz * vx - ux * vz);
    if (area > 1e-12) { cx += (a[0] + b[0] + c[0]) / 3 * area; cy += (a[1] + b[1] + c[1]) / 3 * area; cz += (a[2] + b[2] + c[2]) / 3 * area; count += area; }
    for (const p of [a, b, c]) { minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]); minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]); minZ = Math.min(minZ, p[2]); maxZ = Math.max(maxZ, p[2]); }
  }
  if (count <= 0) throw new Error('Saved water plane has zero area');
  cx /= count; cy /= count; cz /= count;
  let n = [nx, ny, nz]; const length = Math.hypot(...n);
  if (!(length > 1e-12)) throw new Error('Saved water plane normal is degenerate');
  n = n.map(v => v / length);
  if (n[1] < 0) n = n.map(v => -v);
  if (n[1] < 0.02) throw new Error('Saved water plane is not upward-facing');
  const d = n[0] * cx + n[1] * cy + n[2] * cz;
                                                                               
  let rms = 0, max = 0;
  for (let i = 0; i < points.length; i += 3) {
    const error = Math.abs(n[0] * points[i] + n[1] * points[i + 1] + n[2] * points[i + 2] - d);
    rms += error * error; max = Math.max(max, error);
  }
  rms = Math.sqrt(rms / (points.length / 3));
  return {normal: n, d, centroid: [cx, cy, cz], bounds: [minX, minZ, maxX, maxZ], min_y: minY, max_y: maxY,
    plane_rms_m: rms, plane_max_error_m: max, slope: Math.hypot(n[0], n[2]) / n[1], triangles: faces};
}
export function planeHeight(plane, x, z) {
  if (!plane || !Number.isFinite(x) || !Number.isFinite(z) || Math.abs(plane.normal[1]) < 1e-6) throw new Error('Invalid water plane query');
  return (plane.d - plane.normal[0] * x - plane.normal[2] * z) / plane.normal[1];
}
export function bodyContains(body, x, z, margin = 0) {
  if (!body?.bounds || !Number.isFinite(x) || !Number.isFinite(z)) return false;
  const [x0, z0, x1, z1] = body.bounds, m = Math.max(0, margin);
  return x >= x0 - m && x <= x1 + m && z >= z0 - m && z <= z1 + m;
}

                                                                              
                                                                               
                                                                                 
                                                                              
const v3 = (x, y, z) => [x, y, z];
const add3 = (a, b) => v3(a[0] + b[0], a[1] + b[1], a[2] + b[2]);
const sub3 = (a, b) => v3(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const mul3 = (a, s) => v3(a[0] * s, a[1] * s, a[2] * s);
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export function normalize3(a) {
  const length = Math.hypot(...a);
  if (!(length > 1e-12)) throw new Error('Cannot normalize a degenerate inland vector');
  return a.map(v => v / length);
}
const smoothstep01 = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const sinc = x => Math.abs(x) <= 1e-4 ? 1 : Math.sin(x) / x;
                                                                              
                                                                           
export function inlandSurfaceNormal(plane, dhdx, dhdz) {
  if (!plane || !Array.isArray(plane.normal) || plane.normal.length !== 3) throw new Error('Inland plane normal missing');
  const n = normalize3(plane.normal);
  return normalize3(v3(n[0] - n[1] * dhdx, n[1], n[2] - n[1] * dhdz));
}
                                                                        
export function refractDirection(incident, normal, eta, minTransmission = 1e-6) {
  const i = normalize3(incident), n = normalize3(normal);
  const cosi = dot3(n, i);
  const k = 1 - eta * eta * (1 - cosi * cosi);
  if (k < 0) return null;
  const out = i.map((v, index) => eta * v - (eta * cosi + Math.sqrt(k)) * n[index]);
  const length = Math.hypot(...out);
  return length > minTransmission ? out.map(v => v / length) : null;
}
export function inlandShoreFade(shoreFadeM, depth) {
  if (!Number.isFinite(shoreFadeM) || shoreFadeM <= 0) return 1;
  return smoothstep01(0, shoreFadeM, Math.max(0, depth));
}
                                                                                
                                                                                
                                                        
export function inlandRefractedXZ({ plane, waveAt, sunDir, ior, offset, q, foot = 0, fade = 1 }) {
  if (typeof waveAt !== 'function') throw new Error('Inland ray map requires a wave sampler');
  if (!Number.isFinite(offset) || offset < 0) throw new Error('Invalid inland receiver offset');
  const s = waveAt(q[0], q[1], foot), f = Math.min(1, Math.max(0, fade));
  const n = inlandSurfaceNormal(plane, s[1] * f, s[2] * f);
  const ray = refractDirection(v3(-sunDir[0], -sunDir[1], -sunDir[2]), n, 1 / ior);
  if (!ray || ray[1] >= -0.06) return [q[0], q[1]];
  const drop = s[0] * f + Math.max(0, offset);
  if (!(drop > 0)) return [q[0], q[1]];
  const t = drop / -ray[1];
  return [q[0] + ray[0] * t, q[1] + ray[2] * t];
}
                                                                           
                                                                                 
                                                
export function inlandRayMap({ plane, waveAt, sunDir, ior, optical, receiverXZ, foot = 0, fade = 1, strength = 1, maxDepth = 12 }) {
  if (!Array.isArray(receiverXZ) || receiverXZ.length !== 2) throw new Error('Invalid inland receiver XZ');
  if (!Number.isFinite(optical) || optical < 0) throw new Error('Invalid inland optical depth');
  const flat = refractDirection(v3(-sunDir[0], -sunDir[1], -sunDir[2]), normalize3(plane.normal), 1 / ior);
  if (!flat || flat[1] >= -0.02) return { mapped: [...receiverXZ], entryOffset: [0, 0], jacobian: 1, focus: 1, optical };
  let q = [receiverXZ[0] + flat[0] / -flat[1] * optical, receiverXZ[1] + flat[2] / -flat[1] * optical];
  const sampleFoot = Math.max(0.02, foot * 1.5);
  const map = xz => inlandRefractedXZ({ plane, waveAt, sunDir, ior, offset: optical, q: xz, foot: sampleFoot, fade });
  for (let i = 0; i < 2; i++) {
    const m = map(q);
    q = [q[0] + receiverXZ[0] - m[0], q[1] + receiverXZ[1] - m[1]];
  }
  const mapped = map(q), e = Math.max(0.05, foot * 1.5);
  const dx = [map([q[0] + e, q[1]])[0] - map([q[0] - e, q[1]])[0], map([q[0] + e, q[1]])[1] - map([q[0] - e, q[1]])[1]];
  const dz = [map([q[0], q[1] + e])[0] - map([q[0], q[1] - e])[0], map([q[0], q[1] + e])[1] - map([q[0], q[1] - e])[1]];
  const jacobian = Math.abs(dx[0] * dz[1] - dx[1] * dz[0]) / (4 * e * e);
  let focus = Math.min(4, Math.max(0.15, 1 / Math.max(0.18, jacobian)));
  focus = 1 + (focus - 1) * Math.min(4, Math.max(0, strength));
  focus = Math.min(5, Math.max(0.05, focus + (1 - focus) * smoothstep01(0.7, 1, optical / Math.max(0.01, maxDepth))));
  return { mapped, entryOffset: [q[0] - receiverXZ[0], q[1] - receiverXZ[1]], jacobian, focus, optical };
}
                                                                            
                                                                                
                                                                                 
export function inlandRiverRipple({ body, q, time, foot = 0 }) {
  const dir = body.flow.direction, perp = [-dir[1], dir[0]];
  const k = 2 * Math.PI / Math.max(0.05, body.wave.wavelength), k2 = k * 1.7;
  const speed = body.flow.speed, amp = body.wave.amplitude;
  const fp = Math.max(0.01, foot), a0 = sinc(0.5 * k * fp), a2 = sinc(0.5 * k2 * fp);
  const p0 = (q[0] * dir[0] + q[1] * dir[1]) * k - time * speed * k;
  const p1 = (q[0] * perp[0] + q[1] * perp[1]) * k2 + time * (speed * k * 0.43 + 0.6);
  const c0 = Math.cos(p0), c1 = Math.cos(p1);
  return {
    h: amp * (a0 * Math.sin(p0) + 0.35 * a2 * Math.sin(p1)),
    dhdx: amp * (a0 * c0 * k * dir[0] + 0.35 * a2 * c1 * k2 * perp[0]),
    dhdz: amp * (a0 * c0 * k * dir[1] + 0.35 * a2 * c1 * k2 * perp[1]),
    attenuation: [a0, a2], phase: [p0, p1],
  };
}
export function inlandCameraUnderwater(plane, camera, bounds = null) {
  if (!Array.isArray(camera) || camera.length !== 3) throw new Error('Invalid inland camera');
  if (bounds && !(camera[0] >= bounds[0] && camera[0] <= bounds[2] && camera[2] >= bounds[1] && camera[2] <= bounds[3])) return false;
  return camera[1] < planeHeight(plane, camera[0], camera[2]) - 0.02;
}
export function inlandPlaneT(plane, a, b) {
  const f0 = planeHeight(plane, a[0], a[2]) - a[1], f1 = planeHeight(plane, b[0], b[2]) - b[1];
  if (Math.abs(f0 - f1) < 1e-9) return Infinity;
  return f0 / (f0 - f1);
}
                                                                          
                                                                    
export function fresnelWaterToAir(cosI, ior) {
  finite(cosI, 'water-to-air cosine', { min: -1, max: 1 });
  finite(ior, 'water IOR', { min: 1, max: 4 });
  const c = Math.min(1, Math.max(0, cosI)), e = Math.max(1.0001, ior), sin2 = (1 - c * c) * e * e;
  if (sin2 >= 1) return 1;
  const ct = Math.sqrt(Math.max(0, 1 - sin2));
  const rs = (e * c - ct) / Math.max(1e-6, e * c + ct), rp = (c - e * ct) / Math.max(1e-6, c + e * ct);
  return Math.min(1, Math.max(0, 0.5 * (rs * rs + rp * rp)));
}
export function totalInternalReflectionWaterToAir(cosI, ior) {
  const c = Math.min(1, Math.max(0, cosI)), e = Math.max(1.0001, ior);
  return (1 - c * c) * e * e >= 1;
}
                                                                
                                                                
                                                                      
                                                          
                                            
export function inlandViewSegment({ plane, camera, point, extinction, ior = 1.333, bounds = null }) {
  if (!Array.isArray(camera) || camera.length !== 3 || !Array.isArray(point) || point.length !== 3) throw new Error('Invalid inland view segment');
  const camUnder = inlandCameraUnderwater(plane, camera, bounds);
  const pointUnder = point[1] <= planeHeight(plane, point[0], point[2]) + 0.006;
  const distance = Math.hypot(point[0] - camera[0], point[1] - camera[1], point[2] - camera[2]);
  const transmittance = path => extinction.map(v => Math.exp(-v * path));
  if (!camUnder && !pointUnder) return { camUnder, pointUnder, path: 0, segment: 'air', tir: false, transmittance: [1, 1, 1] };
  if (!(distance > 1e-9)) return { camUnder, pointUnder, path: 0, segment: 'zero', tir: false, transmittance: [1, 1, 1] };
  if (camUnder && pointUnder) return { camUnder, pointUnder, path: distance, segment: 'whole', tir: false, transmittance: transmittance(distance) };
  const t = inlandPlaneT(plane, camera, point);
  if (!(t > 0 && t < 1)) return { camUnder, pointUnder, path: 0, segment: 'no_crossing', tir: false, transmittance: [1, 1, 1] };
  if (camUnder) {
    const n = normalize3(plane.normal), dir = normalize3(sub3(point, camera));
    const cosI = Math.abs(dot3(dir, n)), tir = totalInternalReflectionWaterToAir(cosI, ior);
    const path = t * distance;
    return { camUnder, pointUnder, path, segment: 'camera_to_exit', tir, transmittance: tir ? [0, 0, 0] : transmittance(path), exit_t: t };
  }
  const path = (1 - t) * distance;
  return { camUnder, pointUnder, path, segment: 'entry_to_point', tir: false, transmittance: transmittance(path), entry_t: t };
}

                                                                                
                                                                           
export function makeWaterBody({kind, id, plane, bounds = null, sample, flow, wave = {}, optics = {}}) {
  if (!['lake', 'river'].includes(kind)) throw new Error('Inland body must be lake or river');
  if (!plane || !Array.isArray(plane.normal) || plane.normal.length !== 3 || !Number.isFinite(plane.d)) throw new Error('Inland body plane missing');
  const b = bounds ?? plane.bounds;
  if (!Array.isArray(b) || b.length !== 4 || !b.every(Number.isFinite)) throw new Error('Inland body bounds missing');
  const s = {origin: [0, 0], length: 8, layer: -1, ...(sample ?? {})};
  if (!Array.isArray(s.origin) || s.origin.length !== 2 || !s.origin.every(Number.isFinite) || !(s.length > 0)) throw new Error('Inland body sampling domain invalid');
  if (!Number.isInteger(s.layer) || s.layer < -1 || s.layer >= INLAND_MAX_BODIES) throw new Error('Inland body atlas layer invalid');
  const f = {direction: [1, 0], speed: 0, explicit_direction: true, explicit_speed: true, ...(flow ?? {})};
  if (!Array.isArray(f.direction) || f.direction.length !== 2 || !f.direction.every(Number.isFinite) || Math.hypot(...f.direction) < 1e-8) throw new Error('Inland body flow direction invalid');
  const n = Math.hypot(...f.direction); f.direction = [f.direction[0] / n || 0, f.direction[1] / n || 0];
  finite(f.speed, 'body flow speed', {min: 0, max: 20});
  const w = {
    wavelength: kind === 'lake' ? s.length / 8 : INLAND_WATER_DEFAULTS.river_wave_wavelength_m,
    amplitude: INLAND_WATER_DEFAULTS.river_wave_amplitude_m, caustic_strength: 1,
    wet_width: INLAND_WATER_DEFAULTS.wet_width_m, max_depth: kind === 'lake' ? INLAND_WATER_DEFAULTS.caustic_max_depth_m : INLAND_WATER_DEFAULTS.river_caustic_max_depth_m,
                                                                              
                                                                               
    shore_fade: kind === 'lake' ? 0.5 : 0,
    ...wave,
  };
  for (const key of ['wavelength', 'amplitude', 'caustic_strength', 'wet_width', 'max_depth', 'shore_fade']) if (!Number.isFinite(w[key]) || w[key] < 0) throw new Error(`Invalid inland body wave ${key}`);
  if (w.wavelength <= 0) throw new Error('Invalid inland body wavelength');
  const o = {...INLAND_WATER_DEFAULTS, ...(kind === 'river' ? {absorption: INLAND_WATER_DEFAULTS.river_absorption, scatter: INLAND_WATER_DEFAULTS.river_scatter} : {}), ...(optics ?? {})};
  const validated = validateInlandWaterConfig(o);
  return Object.freeze({
    kind, id: String(id ?? `${kind}-${s.layer}`),
    plane: {normal: [...plane.normal], d: plane.d,
      min_y: Number.isFinite(plane.min_y) ? plane.min_y : planeHeight(plane, b[0], b[1]),
      max_y: Number.isFinite(plane.max_y) ? plane.max_y : planeHeight(plane, b[2], b[3]),
      plane_rms_m: plane.plane_rms_m ?? 0, slope: plane.slope ?? 0},
    bounds: [...b], sample: {origin: [...s.origin], length: s.length, layer: s.layer},
    flow: f, wave: w, optics: validated,
  });
}
export function makeLakeBody({native, basin, band, fetch, layer, originXZ}) {
  const [z0, x0, z1, x1] = basin.bounds_rc;
  const ox = originXZ?.[0] ?? 0, oz = originXZ?.[1] ?? 0;
  const dx = native.spacing[0], dz = native.spacing[1];
  const level = basin.level_m;
  return makeWaterBody({
    kind: 'lake', id: basin.id,
    plane: {normal: [0, 1, 0], d: level, min_y: level, max_y: level, plane_rms_m: 0, slope: 0},
    bounds: [ox + x0 * dx, oz + z0 * dz, ox + x1 * dx, oz + z1 * dz],
    sample: {origin: [ox, oz], length: band.length, layer},
    flow: {direction: [0, 1], speed: 0},
    wave: {wavelength: Math.max(0.5, band.length / 8), amplitude: Math.max(0, band.significantHeight * 0.5),
      caustic_strength: 1, wet_width: INLAND_WATER_DEFAULTS.wet_width_m, max_depth: INLAND_WATER_DEFAULTS.caustic_max_depth_m,
                                                                                
                                                                   
      shore_fade: Math.max(0.3, band.significantHeight * 4)},
    optics: {caustic_max_depth_m: INLAND_WATER_DEFAULTS.caustic_max_depth_m},
    fetch,
  });
}
                                                                              
                                                                              
export function makeSavedWaterBody({kind, id, points, indices, origin, flow, layer = -1, optics = {}, wave = {}}) {
  const ox = origin?.[0] ?? 0, oz = origin?.[1] ?? 0;
  const world = new Float32Array(points.length);
  for (let i = 0; i < points.length; i += 3) { world[i] = points[i] + ox; world[i + 1] = points[i + 1]; world[i + 2] = points[i + 2] + oz; }
  const fit = fitWaterPlane(world, indices);
  let direction = flow?.direction, speed = flow?.speed;
  const explicit_direction = !!flow?.explicit_direction, explicit_speed = flow?.explicit_speed;
  if (!direction) {
                                                                              
                                                                                 
    const ex = fit.bounds[2] - fit.bounds[0], ez = fit.bounds[3] - fit.bounds[1];
    direction = ex >= ez ? [1, 0] : [0, 1];
                                                                        
    const downhill = direction[0] ? fit.normal[0] : fit.normal[2];
    if (downhill < 0) direction = direction.map(v => -v);
  }
  if (speed === null || speed === undefined) speed = kind === 'river' ? INLAND_WATER_DEFAULTS.river_flow_speed_m_s : 0;
  const length = Math.max(8, Math.hypot(fit.bounds[2] - fit.bounds[0], fit.bounds[3] - fit.bounds[1]));
  return makeWaterBody({
    kind, id, plane: fit, bounds: fit.bounds,
    sample: {origin: [(fit.bounds[0] + fit.bounds[2]) / 2 - length / 2, (fit.bounds[1] + fit.bounds[3]) / 2 - length / 2], length, layer},
    flow: {direction, speed, explicit_direction, explicit_speed},
    wave: {wavelength: wave.wavelength ?? INLAND_WATER_DEFAULTS.river_wave_wavelength_m,
      amplitude: wave.amplitude ?? INLAND_WATER_DEFAULTS.river_wave_amplitude_m,
      caustic_strength: kind === 'river' ? 0.6 : 1,
      wet_width: INLAND_WATER_DEFAULTS.wet_width_m,
      max_depth: kind === 'river' ? INLAND_WATER_DEFAULTS.river_caustic_max_depth_m : INLAND_WATER_DEFAULTS.caustic_max_depth_m,
      shore_fade: kind === 'lake' ? 0.5 : 0,
      ...wave},
    optics,
  });
}
export function packBodies(bodies, {optics = true, caustics = true, wetness = true} = {}) {
  if (!Array.isArray(bodies) || bodies.length > INLAND_MAX_BODIES) throw new Error(`Inland water body capacity exceeded (${INLAND_MAX_BODIES})`);
  const rows = new Float32Array(INLAND_MAX_BODIES * INLAND_BODY_ROWS * 4);
  bodies.forEach((b, i) => {
    if (!b || !b.plane || !b.optics) throw new Error('Incomplete inland water body');
    const o = i * INLAND_BODY_ROWS * 4, p = b.plane, q = b.optics, r = b.bounds;
    rows.set([p.normal[0], p.normal[1], p.normal[2], p.d], o);
    rows.set([r[0], r[1], r[2], r[3]], o + 4);
    rows.set([b.sample.origin[0], b.sample.origin[1], b.sample.length, b.sample.layer], o + 8);
    rows.set([b.flow.direction[0], b.flow.direction[1], b.flow.speed, b.wave.amplitude], o + 12);
    rows.set([b.wave.wavelength, b.wave.caustic_strength, b.wave.wet_width, b.wave.max_depth], o + 16);
    rows.set([q.absorption[0], q.absorption[1], q.absorption[2], q.ior], o + 20);
    rows.set([q.scatter[0], q.scatter[1], q.scatter[2], q.caustic_plane_m], o + 24);
    rows.set([optics ? 1 : 0, b.kind === 'river' ? 1 : 0, optics && caustics && q.caustics ? 1 : 0, optics && wetness && q.wetness ? 1 : 0], o + 28);
    rows.set([b.wave.shore_fade, 0, 0, 0], o + 32);
  });
  return {count: bodies.length, rows};
}
export function bodyDiagnostics(bodies) {
  return bodies.map((b, i) => ({index: i, id: b.id, kind: b.kind, level_m: 0.5 * (b.plane.min_y + b.plane.max_y),
    plane: {normal: b.plane.normal, d: b.plane.d, slope: b.plane.slope, rms_m: b.plane.plane_rms_m},
    bounds_xz_m: b.bounds, sampling: b.sample, aabb_domain: true, domain_classification: 'AABB + local water plane (user-accepted; no shoreline mask)',
    flow: {direction: b.flow.direction, speed_m_s: b.flow.speed, explicit_direction: b.flow.explicit_direction, explicit_speed: b.flow.explicit_speed},
    wave: b.wave, shore_depth_fade_m: b.wave.shore_fade, optics: {absorption: b.optics.absorption, scatter: b.optics.scatter, ior: b.optics.ior,
      caustics: b.optics.caustics, caustic_strength: b.optics.caustic_strength, wetness: b.optics.wetness}}));
}
