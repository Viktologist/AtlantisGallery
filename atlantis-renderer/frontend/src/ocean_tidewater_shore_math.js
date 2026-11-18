                                                                                     
                                                                                    
              
                                                
                                                                               
                                                                                
                                                                               
                                                                            
                                                                        
                                                           
                                                                                 
                                                  
                                                                             
                                                                           
                                                                              
                                                                         
                                                                                
                                                                                
            
   
import {createCoastProfileMap} from './ocean_profile_math.js';

const G = 9.81, TAU = 2 * Math.PI;
const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const mix = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t); };

export function tidewaterShoreSettings(hs = 1, direction = [1, 0]) {
  if (!Number.isFinite(hs) || hs < 0 || direction.length !== 2 ||
      !direction.every(Number.isFinite) || Math.hypot(...direction) < 1e-9) throw new TypeError('Invalid Hs / swell direction');
  const len = Math.hypot(...direction), period = clamp(5 + 2.4 * Math.sqrt(hs), 5, 14);
                                                                           
  return {hs, amplitude: .24 * hs, period, gamma: .78, breakSpan: .55,
    direction: direction.map(x => x / len), referenceDepth: 10,
    breakDepth: hs > 0 ? (.24 * hs * 3.556 / .78) ** .8 : 0};
}

class TidewaterHeap {
  constructor() { this.items = []; }
  push(id, t) {
    const a = this.items, v = [id, t]; let i = a.length; a.push(v);
    while (i > 0) { const p = (i - 1) >> 1; if (a[p][1] <= t) break; a[i] = a[p]; i = p; } a[i] = v;
  }
  pop() {
    const a = this.items, first = a[0], last = a.pop();
    if (a.length) { let i = 0; while (i * 2 + 1 < a.length) {
      let c = i * 2 + 1; if (c + 1 < a.length && a[c + 1][1] < a[c][1]) c++;
      if (a[c][1] >= last[1]) break; a[i] = a[c]; i = c;
    } a[i] = last; } return first;
  }
}

function tidewaterBilinear(data, nx, nz, x, z, channels = 1) {
  x = clamp(x, 0, nx - 1); z = clamp(z, 0, nz - 1);
  const ix = Math.min(nx - 2, Math.floor(x)), iz = Math.min(nz - 2, Math.floor(z));
  const fx = x - ix, fz = z - iz, ids = [iz * nx + ix, iz * nx + ix + 1, (iz + 1) * nx + ix, (iz + 1) * nx + ix + 1];
  const w = [(1 - fx) * (1 - fz), fx * (1 - fz), (1 - fx) * fz, fx * fz];
  return Array.from({length: channels}, (_, c) => ids.reduce((v, id, j) => v + (w[j] ? data[id * channels + c] * w[j] : 0), 0));
}

                                                                               
                                                                              
                                                                               
                                                                               
                                                                              
                                                                             
                                                                             
   
export function createTidewaterShoreField(terrain, sea, size = 128, options = {}) {
  const coast = createCoastProfileMap(terrain, sea, size);                                              
  const {data: bed, shape: [nz, nx]} = terrain;
  const [dx, dz] = typeof terrain.spacing === 'number' ? [terrain.spacing, terrain.spacing] : terrain.spacing;
  const settings = tidewaterShoreSettings(options.hs ?? 1, options.direction ?? [1, 0]);
  const [sx, sz] = settings.direction, count = nx * nz;
  const times = new Float64Array(count).fill(Infinity), wet = new Uint8Array(count), done = new Uint8Array(count);
  const heap = new TidewaterHeap(); let seeds = 0, reached = 0;
  const c0 = Math.sqrt(G * 25), minProjection = Math.min(0, sx * coast.extent[0]) + Math.min(0, sz * coast.extent[1]);
  for (let i = 0; i < count; i++) wet[i] = Number.isFinite(bed[i]) && bed[i] < sea;
  for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
    const i = z * nx + x;
    if (wet[i] && ((x === 0 && sx > 1e-6) || (x === nx - 1 && sx < -1e-6) ||
        (z === 0 && sz > 1e-6) || (z === nz - 1 && sz < -1e-6))) {
      times[i] = (x * dx * sx + z * dz * sz - minProjection) / c0; heap.push(i, times[i]); seeds++;
    }
  }
  const neighbours = i => { const x = i % nx, z = Math.floor(i / nx); return [x ? i - 1 : -1, x < nx - 1 ? i + 1 : -1, z ? i - nx : -1, z < nz - 1 ? i + nx : -1]; };
  function tentative(i) {
    const n = neighbours(i), accepted = j => j >= 0 && done[j] ? times[j] : Infinity;
    let a = Math.min(accepted(n[0]), accepted(n[1])), b = Math.min(accepted(n[2]), accepted(n[3]));
    const slowness = 1 / Math.sqrt(G * clamp(sea - bed[i], .015, 25));
    if (!Number.isFinite(a)) return b + dz * slowness;
    if (!Number.isFinite(b)) return a + dx * slowness;
    const ax = 1 / (dx * dx), az = 1 / (dz * dz), qa = ax + az, qb = -2 * (a * ax + b * az);
    const qc = a * a * ax + b * b * az - slowness * slowness;
    const both = (-qb + Math.sqrt(Math.max(0, qb * qb - 4 * qa * qc))) / (2 * qa);
    return both >= Math.max(a, b) ? both : Math.min(a + dx * slowness, b + dz * slowness);
  }
  while (heap.items.length) {
    const [i, t] = heap.pop(); if (done[i] || t !== times[i]) continue;
    done[i] = 1; reached++;
    for (const j of neighbours(i)) if (j >= 0 && wet[j] && !done[j]) {
      const tNew = tentative(j); if (tNew < times[j]) { times[j] = tNew; heap.push(j, tNew); }
    }
  }
                                                                                     
  const native = new Float64Array(count * 4), owner = new Int32Array(count).fill(-1);
  const landDistance = new Float64Array(count).fill(Infinity), landHeap = new TidewaterHeap();
  for (let i = 0; i < count; i++) if (done[i]) {
    const n = neighbours(i), diff = (a, b, h) => {
      const va = a >= 0 && done[a], vb = b >= 0 && done[b];
      return va && vb ? (times[b] - times[a]) / (2 * h) : vb ? (times[b] - times[i]) / h : va ? (times[i] - times[a]) / h : 0;
    };
    let gx = diff(n[0], n[1], dx), gz = diff(n[2], n[3], dz), len = Math.hypot(gx, gz);
    if (len < 1e-10) { gx = sx; gz = sz; len = 1; }
    const direct = ((i % nx) * dx * sx + Math.floor(i / nx) * dz * sz - minProjection) / c0;
                                                                                        
    const turn = clamp((gx * sx + gz * sz) / len * .5 + .5);
    const exposure = Math.exp(-Math.max(0, times[i] - direct) / (settings.period * 5)) * (.12 + .88 * turn * turn);
    native.set([times[i], gx / len * exposure, gz / len * exposure, 1], i * 4);
    owner[i] = i;
    if (n.some(j => j >= 0 && Number.isFinite(bed[j]) && !wet[j])) { landDistance[i] = 0; landHeap.push(i, 0); }
  }
                                                                                      
  while (landHeap.items.length) {
    const [i, d] = landHeap.pop(); if (d !== landDistance[i]) continue;
    const n = neighbours(i);
    for (let a = 0; a < 4; a++) { const j = n[a]; if (j < 0 || wet[j] || !Number.isFinite(bed[j])) continue;
      const nd = d + (a < 2 ? dx : dz); if (nd >= landDistance[j]) continue;
      landDistance[j] = nd; owner[j] = owner[i]; landHeap.push(j, nd);
    }
  }
  for (let i = 0; i < count; i++) if (!wet[i] && owner[i] >= 0) {
    const k = owner[i] * 4, speed = Math.sqrt(G * Math.max(.015, settings.hs * .4));
    native.set([native[k] + landDistance[i] / speed, native[k + 1], native[k + 2], 1], i * 4);
  }
  const output = new Float32Array(size * size * 4); let supported = 0;
  for (let z = 0; z < size; z++) for (let x = 0; x < size; x++) {
    const k = (z * size + x) * 4, px = (x + .5) / size * coast.extent[0], pz = (z + .5) / size * coast.extent[1];
    const f = tidewaterBilinear(native, nx, nz, px / dx, pz / dz, 4);
    const footX = clamp(px - coast.data[k] * coast.data[k + 1], 0, coast.extent[0]);
    const footZ = clamp(pz - coast.data[k] * coast.data[k + 2], 0, coast.extent[1]);
    const shore = tidewaterBilinear(native, nx, nz, footX / dx, footZ / dz, 4);
    const support = smooth(.98, 1, f[3]) * smooth(.98, 1, shore[3]);
    output.set([f[0], f[1] * support, f[2] * support, shore[0]], k);
    if (support > .99 && coast.data[k + 3] > 0) supported++;
  }
  return {data: output, coast, size, origin: coast.origin, extent: coast.extent, settings,
    native: {times, wet, reached: done, shape: [nz, nx], spacing: [dx, dz]},
    stats: {nativeSamples: count, nativeWetSamples: wet.reduce((a, b) => a + b, 0), reachedWetSamples: reached,
      boundarySeeds: seeds, supportedCoastTexels: supported, texelSpacing: coast.extent.map(x => x / size),
      bathymetryImmutable: true, phaseUnits: 'unwrapped seconds', solver: 'anisotropic first-order fast marching',
      travelDepthClamp_m: [.015, 25], exposure: 'arrival delay and gradient turning', nativeShape: [nz, nx], nativeSpacing: [dx, dz]}};
}

export function sampleTidewaterShoreField(field, x, z) {
  const u = (x - field.origin[0]) / field.extent[0], v = (z - field.origin[1]) / field.extent[1];
  return u < 0 || v < 0 || u > 1 || v > 1 ? [0, 0, 0, 0] : tidewaterBilinear(field.data, field.size, field.size, u * field.size - .5, v * field.size - .5, 4);
}

                                                                                
export function tidewaterWaveAmplitude(m, along, hs) {
  const waveSet = .55 + .6 * (.5 - .5 * Math.cos(m * TAU / 7));
  const rnd = Math.sin(m * 2.399963 + .71), warp = Math.sin(along * .016 + m * .9) * 1.6;
  const a1 = Math.sin(along * .062 + m * 1.7 + warp), a2 = Math.sin(along * .13 + m * 4.1 + 1.3 - warp * .7);
  const a3 = .6 * Math.sin(along * .29 + m * 2.3 + warp * .5) + .4 * Math.sin(along * .47 + m * 5.9 + .8);
  return .24 * Math.max(0, hs) * waveSet * Math.max(.2, 1 + rnd * .16 + (.6 * a1 + .4 * a2 + .28 * a3) * .3);
}

export function tidewaterBreakParameters(A, depth, hs) {
  const db = Math.max(1e-6, (Math.max(0, A) * 3.556 / .78) ** .8), b = (db - depth) / (db * .55);
                                                                                      
  const rawAsh = A * (10 / clamp(depth, Math.max(1e-5, hs * .12), 10)) ** .25;
  const ash = rawAsh / (1 + (rawAsh / Math.max(1e-6, hs * .65)) ** 4) ** .25;
  const p = mix(1, 3, smooth(-2.5, 0, b)), meanP = 1 / Math.sqrt((p + .25) * Math.PI);
  const crestPeak = 1 + smooth(-1, .3, b) * .22, H = ash * 2 * crestPeak;
  const yc = H * (1 - meanP), yt = -H * meanP, bore = smooth(.85, 1.35, b), Xi = H * .8;
  const Hb = Math.min(H * .6, Math.max(0, depth) * .75) * (.3 + .7 * smooth(0, Math.max(1e-5, hs * .3), depth));
  const Xc = (Xi - Hb * .55) * bore * smooth(hs * .03, Math.max(1e-5, hs * .3), Hb);
  const Wt = mix(H * mix(.25, .55, smooth(.1, .9, b)), Hb * .6 + hs * .04, bore);
  return {db, b, ash, p, meanP, crestPeak, H, ycB: mix(yc, yt * .6 + Hb, bore), ytB: mix(yt, yt * .6, bore), bore, Xi, Hb, Xc, Wt};
}

export function tidewaterCrossSection(u, A, depth, wavelength, hs) {
  const P = tidewaterBreakParameters(A, depth, hs), lam = Math.max(1e-5, wavelength), skew = smooth(-3, 0, P.b) * .55;
  const phi = u - skew * (1 - Math.cos(u * TAU)) / TAU;
  const yPre = P.ash * 2 * ((Math.max(0, (Math.cos(phi * TAU) + 1) * .5)) ** P.p - P.meanP) * P.crestPeak;
  const xPre = Math.sin(u * TAU) * P.ash * (.1 + smooth(-3, 0, P.b) * .25);
  const uf = Math.max(1e-6, Math.min(.09, P.H * 1.4 / lam));
  const t = clamp(-u / uf), th = t * Math.PI * .5, fx = mix(1 - Math.cos(th), Math.sin(th), P.bore), fy = mix(1 - Math.sin(th), Math.cos(th), P.bore);
  const frontWeight = 1 - smooth(-uf * .09, uf * .09, u);
  const xToe = P.Xc + P.Wt - uf * lam;
  const xFront = mix(P.Xc + P.Wt * fx + u * lam,
    xToe * Math.exp(-Math.max(0, -u - uf) * lam / Math.max(1e-5, P.H * 1.5)), smooth(uf * .94, uf * 1.06, -u));
  const yFront = P.ytB + (P.ycB - P.ytB) * fy;
  const cb = Math.max(0, (Math.cos(u * TAU * .85) + 1) * .5) ** P.p;
  const yBack = P.ytB + (P.ycB - P.ytB) * mix(cb, Math.exp(-Math.max(0, u) * 7), P.bore);
  const xBack = P.Xc * Math.exp(-Math.max(0, u) * 6) * (1 - smooth(.35, .5, u)) + xPre * (1 - P.bore);
  const curl = smooth(-.35, .25, P.b) * (1 - smooth(.28, .48, Math.abs(u)));
                                                                                 
  const lip = smooth(0, .18, P.b) * (1 - smooth(.7, 1.02, P.b)) * Math.exp(-(((u + .012) / .027) ** 2));
  const x = mix(xPre, mix(xBack, xFront, frontWeight), curl) + P.H * .42 * lip;
  const y = mix(yPre, mix(yBack, yFront, frontWeight), curl) - P.H * .14 * lip * smooth(.25, .85, P.b);
  const xi = x - u * lam, reach = Math.max(1e-5, P.Xi * .25 + clamp((P.b - .9) / .45) * (P.Xi * .9 + hs * .5));
  const impact = smooth(.86, .99, P.b) * (1 - smooth(reach * .6, reach, Math.abs(xi - P.Xi))) * (1 - smooth(1.4, 1.9, P.b));
  const fill = smooth(.9 + (1 - fx) * .45, 1.08 + (1 - fx) * .45, P.b);
  const roller = xi > P.Xc + P.Wt ? Math.exp(-(xi - P.Xc - P.Wt) / Math.max(1e-5, hs * .22)) * P.bore :
    xi < P.Xc ? Math.exp((xi - P.Xc) / lam * 16) * P.bore : Math.max(fill, P.bore);
  const foam = Math.max(impact, roller) * (1 - smooth(.25, .48, Math.abs(u))) * smooth(.12, .45, hs);
  return {x, y, foam: clamp(foam), breaking: P.b, parameters: P};
}

export function tidewaterWaveSample(phase, along, depth, hs, wavelength) {
  const m = Math.floor(phase + .5), u = phase - m, a = tidewaterWaveAmplitude(m, along, hs);
  const other = tidewaterWaveAmplitude(m + (u < 0 ? -1 : 1), along, hs);
  return tidewaterCrossSection(u, mix(a, other, .5 * smooth(.32, .5, Math.abs(u))), depth, wavelength, hs);
}

export function tidewaterSwash(timePhase, along, ground, hs, exposure = 1) {
  const m = Math.floor(timePhase), tau = timePhase - m;
                                                                             
  const pulse = tau < .38 ? smooth(0, .38, tau) : 1 - smooth(.38, 1, tau);
  const lobes = 1 + .07 * Math.sin(along * .61 + m * 2.3) + .04 * Math.sin(along * 1.73 + m * 5.1);
  const runup = tidewaterWaveAmplitude(m, along, hs) * 2.1 * clamp(exposure) * pulse * lobes;
  const margin = Math.max(1e-6, hs * .045), coverage = smooth(0, margin, runup - Math.max(0, ground));
  const thickness = hs * .045 * pulse * coverage * clamp((runup - Math.max(0, ground)) / Math.max(1e-6, hs * .2));
  return {runup, coverage, thickness, height: ground + thickness};
}
