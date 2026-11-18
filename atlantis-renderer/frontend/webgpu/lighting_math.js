                                                                                   
import {normalizeEnvironmentYaw} from './environment_math.js';

export const DEFAULT_WEATHER = Object.freeze({environmentYaw:0,timeOfDay: 14, turbidity: 2, rayleigh: 1, mie: 1,
  cloudCoverage: .579, cloudDensity: .8, cloudAltitude: 381.678, cloudThickness: 324.939, cloudSeed: 17,
  probePosition: Object.freeze([0,2,0]), cloudTime: 0, animateClouds: false, groundHeight: 0, iblIntensity: 1, directEnabled: true,
  displaySun: true, aerialEnabled: true, shadowDistance: 320, shadowMapSize: 2048,
  sunDirection: Object.freeze([-.5, .72, .4]), solarIrradiance: Object.freeze([3.5, 3.4, 3.2])});

export function normalizedDirection(v) {
  const a = Array.isArray(v) || ArrayBuffer.isView(v) ? Array.from(v) : [v?.x, v?.y, v?.z];
  if (a.length !== 3 || !a.every(Number.isFinite) || Math.hypot(...a) < 1e-8) throw new TypeError('Invalid sunDirection');
  const n = Math.hypot(...a); return Math.abs(n-1)<1e-12?a:a.map(x => x / n);
}
export function sunAtHour(hour) {
  const a = (hour - 6) * Math.PI / 12;
  return normalizedDirection([Math.cos(a), Math.sin(a), -.35]);
}
                                                                              
                                                                               
export function normalizeWeather(input = {}, previous = DEFAULT_WEATHER) {
  const source = input !== null && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const prior = previous !== null && typeof previous === 'object' && !Array.isArray(previous) ? previous : DEFAULT_WEATHER;
  const aliases = {coverage: 'cloudCoverage', density: 'cloudDensity', seed: 'cloudSeed', time: 'cloudTime'};
  const next = {...prior};
  const set = (key, value) => Object.defineProperty(next, key, {value, enumerable: true, writable: true, configurable: true});
  for (const [k, value] of Object.entries(source)) {
    if (k === 'cloudHeights') {
      if (Array.isArray(value) && value.length === 2) { set('cloudAltitude', value[0]); set('cloudThickness', value[1] - value[0]); }
      else set('cloudHeights', value);                                                 
      continue;
    }
    set(Object.hasOwn(aliases, k) ? aliases[k] : k, value);
  }
  if ('timeOfDay' in source && !('sunDirection' in source)) next.sunDirection = sunAtHour(next.timeOfDay);
  next.environmentYaw = Number.isFinite(next.environmentYaw) ? normalizeEnvironmentYaw(next.environmentYaw) : next.environmentYaw;
  if (Array.isArray(next.probePosition)) next.probePosition = Object.freeze([...next.probePosition]);
  const sun = next.sunDirection;
  if (Array.isArray(sun) && sun.length === 3 && sun.every(Number.isFinite) && Math.hypot(...sun) >= 1e-8) next.sunDirection = Object.freeze(normalizedDirection(sun));
  else if (Array.isArray(sun)) next.sunDirection = Object.freeze([...sun]);
  if (Array.isArray(next.solarIrradiance)) next.solarIrradiance = Object.freeze([...next.solarIrradiance]);
  return Object.freeze(next);
}
export function quantizedViewHeight(y) {
  const h = Math.max(.5, y + .5), log = Math.log(1.02);
  return h < 100 ? Math.round(h / 2) * 2 : Math.exp(Math.round(Math.log(h) / log) * log);
}
export function cloudWeatherKey(w) {
  return JSON.stringify([w.sunDirection, w.cloudCoverage, w.cloudDensity, w.cloudAltitude,
    w.cloudThickness, w.cloudSeed, w.cloudTime, w.groundHeight]);
}
export function skyWeatherKey(w, y) {
  return JSON.stringify([cloudWeatherKey(w), w.rayleigh, w.mie, w.turbidity, w.solarIrradiance, w.probePosition, quantizedViewHeight(y - w.groundHeight)]);
}
export function cascadePlan(position, sun, spans, centers, resolution = 128) {
  const h = Math.max(0, position[1]), mu = Math.max(.005, sun[1]);
  const projected = [position[0] - sun[0] * h / mu, position[2] - sun[2] * h / mu];
  return spans.flatMap((span, i) => {
    const center = centers[i];
    if (center && Math.max(...projected.map((v, k) => Math.abs(v - center[k]))) <= span * .25) return [];
                                                                           
    const snap = span / resolution * 16;
    return [{index: i, center: projected.map(v => Math.round(v / snap) * snap)}];
  });
}
                                                                                
export function cloudLightFrame(direction) {
  const sun=normalizedDirection(direction),length=Math.hypot(sun[0],sun[2]);
  const right=length>1e-6?[sun[2]/length,0,-sun[0]/length]:[1,0,0];
  const up=[sun[1]*right[2]-sun[2]*right[1],sun[2]*right[0]-sun[0]*right[2],sun[0]*right[1]-sun[1]*right[0]];
  return {sun,right,up};
}
export function cloudLightCascadePlan(position, frame, cloudMiddle, spans, centers, resolution=128) {
  const point=[position[0],Math.max(position[1],cloudMiddle),position[2]];
  const projected=[frame.right,frame.up,frame.sun].map(axis=>axis.reduce((v,x,k)=>v+x*point[k],0));
  return spans.flatMap((span,index)=>{
    const center=centers[index];
    if(center&&projected.every((v,k)=>Math.abs(v-center[k])<=span*.25))return [];
    const snap=span/resolution*16;
    return [{index,center:projected.map(v=>Math.round(v/snap)*snap)}];
  });
}
export function practicalSplits(near, far, count = 4) {
  return Array.from({length: count}, (_, i) => {
    const t = (i + 1) / count; return .5 * (near * (far / near) ** t + near + (far - near) * t);
  });
}
                                                                                     
export function depthIsSky(d, reversed = true) { return reversed ? d <= 0 : d >= 1; }
export function sunScreen(direction, view, projection) {
  const [x, y, z] = normalizedDirection(direction), m = view.elements || view, p = projection.elements || projection;
  const vx = m[0]*x + m[4]*y + m[8]*z, vy = m[1]*x + m[5]*y + m[9]*z, vz = m[2]*x + m[6]*y + m[10]*z;
  const cw = p[3]*vx + p[7]*vy + p[11]*vz;
  if (vz >= 0 || cw <= 1e-8) return {uv: [0, 0], fade: 0};
  const uv = [(p[0]*vx + p[4]*vy + p[8]*vz)/cw*.5+.5, .5-(p[1]*vx + p[5]*vy + p[9]*vz)/cw*.5];
  const t = Math.max(0, Math.min(1, Math.min(...uv, 1-uv[0], 1-uv[1])/.05));
  return {uv, fade: t*t*(3-2*t)};
}

                                                                               
                                                                    
export function solarAtProbe(w) {
 const R=6360000,p=[...w.probePosition],d=w.sunDirection;p[1]-=w.groundHeight;
 const sphere=r=>{const b=p.reduce((v,x,i)=>v+x*d[i],0)+R*d[1],c=p.reduce((v,x)=>v+x*x,0)+2*R*p[1]+(R-r)*(R+r),h=b*b-c;return h<0?[-1,-1]:[-b-Math.sqrt(h),-b+Math.sqrt(h)];};
 if(sphere(R)[0]>0)return [0,0,0];const distance=Math.max(0,sphere(6460000)[1]),optical=[0,0,0];
 for(let i=0;i<12;i++) {const a=i/12,b=(i+1)/12,ds=distance*(b*b-a*a),q=p.map((x,k)=>x+d[k]*distance*.5*(a*a+b*b));
 const h=Math.max(0,(q.reduce((v,x)=>v+x*x,0)+2*R*q[1])/(Math.hypot(q[0],q[1]+R,q[2])+R));
 const ray=Math.exp(-h/8000)*(w.rayleigh??1),mie=Math.exp(-h/1200)*(w.mie??1)*(w.turbidity??2)/2,ozone=Math.max(0,1-Math.abs(h-25000)/15000);
 [5.802,13.558,33.1].forEach((beta,k)=>optical[k]+=(beta*ray+4.44*mie+[.650,1.881,.085][k]*ozone)*1e-6*ds);}
 return optical.map((v,i)=>Math.exp(-v)*w.solarIrradiance[i]);
}
