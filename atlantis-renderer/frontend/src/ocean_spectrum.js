  
                                                                     
                                                                              
                                                          
  
              
                                                
                                                                               
                                                                                
                                                                               
                                                                            
                                                                        
                                                           
                                                                                 
                                                  
                                                                             
                                                                           
                                                                              
                                                                         
                                                                                
                                                                                
            
   
                                                                                 
const GRAVITY = 9.81;
const TAU = 2 * Math.PI;

function finite(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${name} must be finite`);
  }
  return value;
}

function positive(value, name) {
  finite(value, name);
  if (value <= 0) throw new RangeError(`${name} must be positive`);
  return value;
}

function nonnegative(value, name) {
  finite(value, name);
  if (value < 0) throw new RangeError(`${name} must be nonnegative`);
  return value;
}

function fftSize(size) {
  if (!Number.isSafeInteger(size) || size < 1 || !Number.isInteger(Math.log2(size))) {
    throw new RangeError('size must be a positive power of two');
  }
  return size;
}

function numericArray(values, length, name) {
  if (!(Array.isArray(values) || ArrayBuffer.isView(values)) || values.length !== length) {
    throw new TypeError(`${name} must contain exactly ${length} numbers`);
  }
  for (let i = 0; i < length; i++) finite(values[i], `${name}[${i}]`);
}

function signedIndex(index, size) {
  return index < size / 2 ? index : index - size;
}

function excluded(x, z, size) {
  return (x === 0 && z === 0) || x === size / 2 || z === size / 2;
}

function randomGenerator(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let word = Math.imul(state ^ (state >>> 15), state | 1);
    word ^= word + Math.imul(word ^ (word >>> 7), word | 61);
                                                           
    return (((word ^ (word >>> 14)) >>> 0) + 0.5) / 4294967296;
  };
}

                                                                              
                                                                               
function waveSystems(windSpeed, direction) {
  const angle = Math.atan2(direction[1], direction[0]);
  const make = (name, speed, fetch, offset, scale, spreadBlend, swell, fade) => {
    const effectiveSpeed = Math.max(0.1, speed);
    return Object.freeze({name, windSpeed:effectiveSpeed, fetch_m:fetch,
      direction_rad:angle + offset, scale, spreadBlend, swell,
      alpha:0.076 * (GRAVITY * fetch / effectiveSpeed ** 2) ** -0.22,
      peakOmega:22 * (effectiveSpeed * fetch / GRAVITY ** 2) ** -0.33,
      peakEnhancement:3.3, shortWavesFade_m:fade});
  };
  return Object.freeze([
    make('local', windSpeed, 120000, 0, 1, 0.85, 0.05, 0.01),
    make('swell', windSpeed * 6 / 7, 1200000, -Math.PI / 9, 0.48, 1, 0.9, 0.1),
  ]);
}

function logAdd(a, b) {
  const high = Math.max(a, b);
  return high === -Infinity ? high : high + Math.log1p(Math.exp(Math.min(a, b) - high));
}

function logDirectional(theta, omega, system) {
  const ratio = omega / system.peakOmega;
  const spread = ratio > 1 ? 9.77 * ratio ** -2.5 : 6.97 * ratio ** 5;
  const s = spread + Math.tanh(Math.min(ratio, 20)) * 16 * system.swell ** 2;
                                                                         
  const norm = s < 5
    ? -0.000564*s**4 + 0.00776*s**3 - 0.044*s*s + 0.192*s + 0.163
    : -4.8e-8*s**4 + 1.07e-5*s**3 - 9.53e-4*s*s + 0.059*s + 0.393;
  const delta = theta - system.direction_rad, cosine = Math.cos(delta);
  const base = cosine > 0 ? (2 / Math.PI) * cosine ** 2 : 0;
  const halfCosine = Math.abs(Math.cos(delta / 2));
  const horvath = halfCosine === 0 ? -Infinity : Math.log(norm) + 2*s*Math.log(halfCosine);
  return logAdd(Math.log((1-system.spreadBlend)*base), Math.log(system.spreadBlend)+horvath);
}

function logSystemDensity(k, theta, omega, system) {
  const peak = system.peakOmega, sigma = omega <= peak ? 0.07 : 0.09;
  const enhancement = Math.exp(-0.5*((omega-peak)/(sigma*peak))**2);
  return Math.log(system.scale * system.alpha * GRAVITY ** 2) - 5*Math.log(omega)
    - 1.25*(peak/omega)**4 + enhancement*Math.log(system.peakEnhancement)
    + logDirectional(theta, omega, system) - (system.shortWavesFade_m*k)**2;
}

   
                                                                                     
                                                                                
                                                                              
                                                   
  
                                                                           
                                                                          
                                                                         
                                                                    
   
export function createWaveBand(options = {}) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('options must be an object');
  }
  const size = fftSize(options.size === undefined ? 128 : options.size);
  const length = positive(options.length === undefined ? 256 : options.length, 'length');
  const minWavelength = positive(
    options.minWavelength === undefined ? 2 * length / size : options.minWavelength,
    'minWavelength',
  );
  const maxWavelength = positive(
    options.maxWavelength === undefined ? length : options.maxWavelength,
    'maxWavelength',
  );
  if (maxWavelength <= minWavelength) {
    throw new RangeError('maxWavelength must exceed minWavelength');
  }
  const significantHeight = nonnegative(
    options.significantHeight === undefined ? 1 : options.significantHeight,
    'significantHeight',
  );
  const windSpeed = nonnegative(options.windSpeed === undefined ? 10 : options.windSpeed, 'windSpeed');
  const direction = options.windDirection === undefined ? [1, 0] : options.windDirection;
  numericArray(direction, 2, 'windDirection');
  const magnitude = positive(Math.hypot(direction[0], direction[1]), 'windDirection magnitude');
  const windDirection = [direction[0] / magnitude, direction[1] / magnitude];
  const seed = finite(options.seed === undefined ? 1 : options.seed, 'seed');
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
    throw new RangeError('seed must be an unsigned 32-bit integer');
  }
  const depth = positive(options.depth === undefined ? 1000 : options.depth, 'depth');
  const chop = nonnegative(options.chop === undefined ? 0.6 : options.chop, 'chop');
  const count = size * size;
  const h0 = new Float32Array(4 * count);
  const lakeFetch=options.fetch_m===undefined?null:positive(options.fetch_m,'fetch_m');
  const systems = lakeFetch===null?waveSystems(windSpeed, windDirection):Object.freeze([
    Object.freeze({...waveSystems(windSpeed,windDirection)[0],fetch_m:lakeFetch,
      alpha:0.076*(GRAVITY*lakeFetch/Math.max(.1,windSpeed)**2)**-.22,
      peakOmega:22*(Math.max(.1,windSpeed)*lakeFetch/GRAVITY**2)**-.33,swell:0})]);
  const spectrum = Object.freeze({model:lakeFetch===null?'two-system directional JONSWAP/Horvath':'fetch-limited lake JONSWAP/Horvath; no swell',
    reference_commit:'4811ba48d795197de5621985f404e765c0b7c0ef', systems,
    finite_depth:'TMA and gravity dispersion derivative',
    normalization:'per-band ensemble metric Hs; Gaussian realizations are not rescaled',
    propagation:'h0 k opposes travel direction for positive-phase, positive-exponent IFFT'});
  const band = {
    size, length, minWavelength, maxWavelength, significantHeight, windSpeed,
    windDirection, seed, depth, chop, h0,
    support: Object.freeze({modeCount:0,minWavelength:null,maxWavelength:null,expectedVariance:(significantHeight/4)**2,compressionTraceRms:0,spectrum}),
  };
  if (significantHeight === 0) return band;
  if (windSpeed === 0) throw new RangeError('positive significantHeight requires positive windSpeed');

  const step = positive(TAU / length, 'frequency spacing');
  const logWeights = new Float64Array(count).fill(-Infinity);
  const localFractions = new Float64Array(count);
  let largest = -Infinity;
  for (let z = 0; z < size; z++) {
    for (let x = 0; x < size; x++) {
      if (excluded(x, z, size)) continue;
      const ix = signedIndex(x, size);
      const iz = signedIndex(z, size);
      const radius = Math.hypot(ix, iz);
      const wavelength = length / radius;
      if (wavelength < minWavelength || wavelength >= maxWavelength) continue;
      const k = radius * step;
      const kd = k * depth, tanh = Math.tanh(kd);
      const omega = Math.sqrt(GRAVITY * k * tanh);
                                                                          
      const depthCorrection = kd < 20 ? kd*(1-tanh*tanh) : 0;
      const groupSpeed = GRAVITY * (tanh + depthCorrection) / (2*omega);
      const omegaH = omega * Math.sqrt(depth / GRAVITY);
      const tma = omegaH <= 1 ? omegaH**2/2 : omegaH < 2 ? 1-(2-omegaH)**2/2 : 1;
                                                                   
                                                                   
      const theta = Math.atan2(-iz, -ix);
      const local = logSystemDensity(k,theta,omega,systems[0]);
      const swell = systems.length===2?logSystemDensity(k,theta,omega,systems[1]):-Infinity;
      const combined = logAdd(local,swell);
      const logWeight = combined
        + Math.log(tma) + Math.log(groupSpeed/k);
      if (!Number.isFinite(logWeight)) continue;
      logWeights[z * size + x] = logWeight;
      localFractions[z * size + x] = Math.exp(local-combined);
      largest = Math.max(largest, logWeight);
    }
  }
  if (!Number.isFinite(largest)) {
    throw new RangeError('band has no representable wind-wave energy on this grid');
  }
  let weightSum = 0, localSum = 0, compressionMoment = 0;
  for (let i = 0; i < count; i++) {
    logWeights[i] = Math.exp(logWeights[i] - largest);
    weightSum += logWeights[i];
    localSum += logWeights[i]*localFractions[i];
                                                                     
                                                                       
    if(logWeights[i]>0){const kx=signedIndex(i%size,size)*step,kz=signedIndex(Math.floor(i/size),size)*step;
      compressionMoment+=logWeights[i]*(kx*kx+kz*kz);}
  }

  const random = randomGenerator(seed);
  let modeCount = 0, shortest = Infinity, longest = 0;
  for (let i = 0; i < count; i++) {
    if (logWeights[i] === 0) continue;
                                                                          
                                                                          
    const sigma = (significantHeight / 8) * Math.sqrt(logWeights[i] / weightSum) * count;
    const radius = Math.sqrt(-2 * Math.log(random()));
    const angle = TAU * random();
    h0[4 * i] = sigma * radius * Math.cos(angle);
    h0[4 * i + 1] = sigma * radius * Math.sin(angle);
    finite(h0[4 * i], 'Float32 h0 real');
    finite(h0[4 * i + 1], 'Float32 h0 imag');
                                                                              
    if (h0[4*i] !== 0 || h0[4*i+1] !== 0) {
      const x = i % size, z = Math.floor(i / size);
      const wavelength = length / Math.hypot(signedIndex(x,size),signedIndex(z,size));
      modeCount++;
      shortest = Math.min(shortest,wavelength);
      longest = Math.max(longest,wavelength);
    }
  }
  band.support=Object.freeze({modeCount,minWavelength:modeCount?shortest:null,maxWavelength:modeCount?longest:null,expectedVariance:(significantHeight/4)**2,
    compressionTraceRms:significantHeight/4*Math.sqrt(compressionMoment/weightSum),
    spectrum:Object.freeze({...spectrum,systemVarianceFractions:Object.freeze([localSum/weightSum,1-localSum/weightSum])})});
                                                                             
  for (let z = 0; z < size; z++) {
    for (let x = 0; x < size; x++) {
      if (excluded(x, z, size)) continue;
      const index = 4 * (z * size + x);
      const opposite = 4 * (((size - z) % size) * size + (size - x) % size);
      h0[index + 2] = h0[opposite];
      h0[index + 3] = -h0[opposite + 1];
    }
  }
  return band;
}

   
                                                                       
                                                                     
                                                                             
                                                                     
   
export function evolveWaveBand(band, time) {
  return evolveFields(band, time, false);
}

   
                                                                    
                                                                         
                                                                
                                                                         
   
export function evolveWaveDerivatives(band, time) {
  return evolveFields(band, time, true);
}

function evolveFields(band, time, derivatives) {
  if (band === null || typeof band !== 'object') throw new TypeError('band must be an object');
  const size = fftSize(band.size);
  const length = positive(band.length, 'length');
  const depth = positive(band.depth, 'depth');
  const chop = nonnegative(band.chop, 'chop');
  finite(time, 'time');
  const count = size * size;
  if (!(band.h0 instanceof Float32Array)) throw new TypeError('h0 must be a Float32Array');
  numericArray(band.h0, count * 4, 'h0');
  const field = () => ({ real: new Float64Array(count), imag: new Float64Array(count) });
  const fields = Object.fromEntries(
    (derivatives ? ['hyx', 'hyz', 'dxx', 'dzz', 'dxz'] : ['height', 'dx', 'dz'])
      .map(name => [name, field()]),
  );
  const step = positive(TAU / length, 'frequency spacing');
  for (let z = 0; z < size; z++) {
    for (let x = 0; x < size; x++) {
      if (excluded(x, z, size)) continue;
      const index = z * size + x;
      const ix = signedIndex(x, size);
      const iz = signedIndex(z, size);
      const radius = Math.hypot(ix, iz);
      const k = radius * step;
      const omega = Math.sqrt(GRAVITY * k * Math.tanh(k * depth));
      const phase = finite(omega * time, 'wave phase');
      const c = Math.cos(phase);
      const s = Math.sin(phase);
      const ar = band.h0[4 * index];
      const ai = band.h0[4 * index + 1];
      const br = band.h0[4 * index + 2];
      const bi = band.h0[4 * index + 3];
      const hr = (ar + br) * c + (bi - ai) * s;
      const hi = (ar - br) * s + (ai + bi) * c;
      if (derivatives) {
        const kx = ix * step, kz = iz * step;
        fields.hyx.real[index] = -kx * hi;
        fields.hyx.imag[index] = kx * hr;
        fields.hyz.real[index] = -kz * hi;
        fields.hyz.imag[index] = kz * hr;
        const xx = -chop * kx * kx / k;
        const zz = -chop * kz * kz / k;
        const xz = -chop * kx * kz / k;
        fields.dxx.real[index] = xx * hr;
        fields.dxx.imag[index] = xx * hi;
        fields.dzz.real[index] = zz * hr;
        fields.dzz.imag[index] = zz * hi;
        fields.dxz.real[index] = xz * hr;
        fields.dxz.imag[index] = xz * hi;
      } else {
        fields.height.real[index] = hr;
        fields.height.imag[index] = hi;
                                                                              
        fields.dx.real[index] = chop * ix / radius * hi;
        fields.dx.imag[index] = -chop * ix / radius * hr;
        fields.dz.real[index] = chop * iz / radius * hi;
        fields.dz.imag[index] = -chop * iz / radius * hr;
      }
    }
  }
  return fields;
}

function inverseLine(real, imag, offset, stride, size) {
  for (let i = 1, j = 0; i < size; i++) {
    let bit = size / 2;
    while (j >= bit) { j -= bit; bit /= 2; }
    j += bit;
    if (i >= j) continue;
    const a = offset + i * stride;
    const b = offset + j * stride;
    [real[a], real[b]] = [real[b], real[a]];
    [imag[a], imag[b]] = [imag[b], imag[a]];
  }
  for (let width = 2; width <= size; width *= 2) {
    const half = width / 2;
    const cr = Math.cos(TAU / width);
    const ci = Math.sin(TAU / width);
    for (let start = 0; start < size; start += width) {
      let wr = 1;
      let wi = 0;
      for (let j = 0; j < half; j++) {
        const a = offset + (start + j) * stride;
        const b = a + half * stride;
        const tr = wr * real[b] - wi * imag[b];
        const ti = wr * imag[b] + wi * real[b];
        real[b] = real[a] - tr;
        imag[b] = imag[a] - ti;
        real[a] += tr;
        imag[a] += ti;
        const nextWr = wr * cr - wi * ci;
        wi = wr * ci + wi * cr;
        wr = nextWr;
      }
    }
  }
  for (let i = 0; i < size; i++) {
    real[offset + i * stride] /= size;
    imag[offset + i * stride] /= size;
  }
}

                                                                             
export function inverseFFT2D(real, imag, size) {
  fftSize(size);
  numericArray(real, size * size, 'real');
  numericArray(imag, size * size, 'imag');
  const output = { real: Float64Array.from(real), imag: Float64Array.from(imag) };
  for (let z = 0; z < size; z++) inverseLine(output.real, output.imag, z * size, 1, size);
  for (let x = 0; x < size; x++) inverseLine(output.real, output.imag, x, size, size);
  return output;
}
