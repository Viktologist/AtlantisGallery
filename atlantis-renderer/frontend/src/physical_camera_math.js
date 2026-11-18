                                                                          
const DEFAULTS = Object.freeze({
  focalLength: 35, sensorWidth: 36, aperture: 5.6, shutter: 1 / 125, iso: 100,
  exposureCompensation: 0, radianceScale: 1000, autoExposure: true,
  minEV: 0, maxEV: 18, adaptationUp: 2, adaptationDown: 1,
  bloom: .12, bloomThreshold: 1, focusDistance: 30, depthOfField: false,
  glow: .12, lightShafts: .12, lightShaftDensity: .85, lightShaftDecay: .96, lightShaftSamples: 32,
  vignette: .12, grain: 0,
});

function finite(value, name) {
  if (!Number.isFinite(value)) throw new TypeError(`${name} must be finite`);
  return value;
}

                                                                             
                                                                                
                                                                         
export function normalizeCameraOptions(options = {}, previous = {}) {
  return Object.freeze({...DEFAULTS, ...previous, ...options});
}

                                                                              
                                                                                 
export function projectCameraSun(direction, viewMatrix, projectionMatrix) {
  const inactive = {visible: false, uv: null, edgeFade: 0};
  if (!direction || direction.length !== 3 || !Array.from(direction).every(Number.isFinite) ||
      !viewMatrix || viewMatrix.length !== 16 || !Array.from(viewMatrix).every(Number.isFinite) ||
      !projectionMatrix || projectionMatrix.length !== 16 || !Array.from(projectionMatrix).every(Number.isFinite)) return inactive;
  const length = Math.hypot(...direction);
  if (!(length > 0) || !Number.isFinite(length)) return inactive;
  const [x, y, z] = Array.from(direction, v => v / length), m = viewMatrix, p = projectionMatrix;
  const vx = m[0] * x + m[4] * y + m[8] * z;
  const vy = m[1] * x + m[5] * y + m[9] * z;
  const vz = m[2] * x + m[6] * y + m[10] * z;
  const w = p[3] * vx + p[7] * vy + p[11] * vz;
  if (!(vz < 0 && w > 1e-8)) return inactive;
  const uv = [(p[0] * vx + p[4] * vy + p[8] * vz) / w * .5 + .5,
    (p[1] * vx + p[5] * vy + p[9] * vz) / w * .5 + .5];
  if (!uv.every(Number.isFinite)) return inactive;
  const margin = Math.min(uv[0], uv[1], 1 - uv[0], 1 - uv[1]);
                                                                                  
  const t = Math.max(0, Math.min(1, margin / .05));
  return {visible: margin > 0, uv, edgeFade: t * t * (3 - 2 * t)};
}

export function cameraEV100(options = {}) {
  const {aperture, shutter, iso} = normalizeCameraOptions(options);
  return 2 * Math.log2(aperture) - Math.log2(shutter) + Math.log2(100) - Math.log2(iso);
}

export function exposureFromEV(ev, radianceScale = 1000) {
  finite(ev, 'ev');
  finite(radianceScale, 'radianceScale');
  if (radianceScale <= 0) throw new RangeError('radianceScale must be positive');
  const exposure = 2 ** (Math.log2(radianceScale) - Math.log2(1.2) - ev);
  if (!Number.isFinite(exposure) || exposure <= 0) throw new RangeError('Exposure is outside the finite working range');
  return exposure;
}

                                                                     
export function adaptExposureEV(current, target, dt, up, down) {
  for (const [name, value] of Object.entries({current, target, dt, up, down})) finite(value, name);
  if (dt < 0 || up < 0 || down < 0) throw new RangeError('dt and adaptation rates must be nonnegative');
  const rate = target > current ? up : down;
  const alpha = -Math.expm1(-rate * dt);
  if (alpha === 0) return current;
  if (alpha === 1) return target;
  return finite((1 - alpha) * current + alpha * target, 'adapted EV');
}

export function circleOfConfusionPixels(distance, options, viewportWidth) {
  const {focalLength, sensorWidth, aperture, focusDistance} = normalizeCameraOptions(options);
  if (!(distance > 0) || (distance !== Infinity && !Number.isFinite(distance))) {
    throw new RangeError('distance must be positive metres (or Infinity)');
  }
  finite(viewportWidth, 'viewportWidth');
  if (viewportWidth <= 0) throw new RangeError('viewportWidth must be positive');
  const f = focalLength / 1000, sensor = sensorWidth / 1000;
  const coc = f * f / (aperture * (focusDistance - f)) *
    Math.abs(1 - focusDistance / distance) * viewportWidth / sensor;
  return Math.min(12, coc);
}
