import {ShaderModule, UniformBlock} from '../../vendor/tidewater/src/engine/gpu/Shader.js';
import {shadowModule} from '../../vendor/tidewater/src/engine/render/wgsl/lighting.js';
import {terrainSurfaceOptions,surfaceWGSL} from './terrain_surface.js';
import {Matrix4} from '../../vendor/tidewater/src/engine/math/Matrix4.js';

export const terrainSamplingWGSL =           `
fn apsTerrainNativePosition(P:vec3f)->vec3f{return (terrainParams.nativeFromWorld*vec4f(P,1.0)).xyz;}
fn apsTerrainWorldPosition(P:vec3f)->vec3f{return (terrainParams.worldFromNative*vec4f(P,1.0)).xyz;}
fn apsTerrainNativeNormal(N:vec3f)->vec3f{return normalize((transpose(terrainParams.worldFromNative)*vec4f(N,0.0)).xyz);}
fn apsTerrainWorldNormal(N:vec3f)->vec3f{return normalize((transpose(terrainParams.nativeFromWorld)*vec4f(N,0.0)).xyz);}
fn terrainUvOf(xz: vec2f) -> vec2f { return (xz - terrainParams.origin) / terrainParams.extent; }
fn terrainInside(xz: vec2f) -> bool { let uv = terrainUvOf(xz); return all(uv >= vec2f(0.0)) && all(uv <= vec2f(1.0)); }
// Terrestrial loose-support fields are cleared in permanent water. That zero
// is not evidence that the authored coastal sediment prior becomes bare rock.
fn terrainMarineSedimentSupport(P:vec3f)->f32 {
 return 1.0-smoothstep(-.15,.15,P.y-terrainParams.seaLevel);
}
fn terrainGridHeight(q: vec2i) -> f32 {
  return textureLoad(terrainHeight, clamp(q, vec2i(0), vec2i(terrainParams.shape) - vec2i(1)), 0).r;
}
fn terrainGridNormal(q: vec2i) -> vec3f {
  let lo = max(q - vec2i(1), vec2i(0));
  let hi = min(q + vec2i(1), vec2i(terrainParams.shape) - vec2i(1));
  let gx = (terrainGridHeight(vec2i(hi.x, q.y)) - terrainGridHeight(vec2i(lo.x, q.y))) / (f32(hi.x - lo.x) * terrainParams.spacing.x);
  let gz = (terrainGridHeight(vec2i(q.x, hi.y)) - terrainGridHeight(vec2i(q.x, lo.y))) / (f32(hi.y - lo.y) * terrainParams.spacing.y);
  return normalize(vec3f(-gx, 1.0, -gz));
}
// The saved DEM's triangles use the (1,0)--(0,1) diagonal. Bilinear
// interpolation would change bed collisions on non-planar native cells.
fn terrainHeightAt(xz: vec2f) -> f32 {
  if (!terrainInside(xz)) { return terrainParams.seaLevel - 1000.0; }
  let grid = clamp((xz - terrainParams.origin) / terrainParams.spacing, vec2f(0.0), terrainParams.shape - 1.0);
  let q = min(vec2i(floor(grid)), vec2i(terrainParams.shape) - vec2i(2));
  let f = grid - vec2f(q);
  let a = terrainGridHeight(q); let b = terrainGridHeight(q + vec2i(1, 0));
  let c = terrainGridHeight(q + vec2i(0, 1)); let d = terrainGridHeight(q + vec2i(1, 1));
  if (f.x + f.y <= 1.0) { return a * (1.0 - f.x - f.y) + b * f.x + c * f.y; }
  return d * (f.x + f.y - 1.0) + b * (1.0 - f.y) + c * (1.0 - f.x);
}
fn terrainNormalAt(xz: vec2f) -> vec3f {
  if (!terrainInside(xz)) { return vec3f(0.0, 1.0, 0.0); }
  let grid = clamp((xz - terrainParams.origin) / terrainParams.spacing, vec2f(0.0), terrainParams.shape - 1.0);
  let q = min(vec2i(floor(grid)), vec2i(terrainParams.shape) - vec2i(2));
  let f = grid - vec2f(q);
  let a = terrainGridNormal(q); let b = terrainGridNormal(q + vec2i(1, 0));
  let c = terrainGridNormal(q + vec2i(0, 1)); let d = terrainGridNormal(q + vec2i(1, 1));
  if (f.x + f.y <= 1.0) { return normalize(a * (1.0 - f.x - f.y) + b * f.x + c * f.y); }
  return normalize(d * (f.x + f.y - 1.0) + b * (1.0 - f.y) + c * (1.0 - f.x));
}
fn terrainTriangleNormalAt(xz:vec2f)->vec3f {
  let grid=clamp((xz-terrainParams.origin)/terrainParams.spacing,vec2f(0),terrainParams.shape-1.0);
  let q=min(vec2i(floor(grid)),vec2i(terrainParams.shape)-2);let f=grid-vec2f(q);
  let a=terrainGridHeight(q);let b=terrainGridHeight(q+vec2i(1,0));
  let c=terrainGridHeight(q+vec2i(0,1));let d=terrainGridHeight(q+vec2i(1));
  let slope=select(vec2f(d-c,d-b),vec2f(b-a,c-a),f.x+f.y<=1.0)/terrainParams.spacing;
  return normalize(vec3f(-slope.x,1.0,-slope.y));
}
// Reference ocean convention is X/Z slopes in xy (not XYZ unit normal).
fn terrainNormalRock(xz: vec2f) -> vec4f {
  let n = terrainNormalAt(xz); let slopes = n.xz / max(n.y, 1e-5);
  return vec4f(slopes, 0.0, terrainHeightAt(xz));
}
fn terrainNormalRockLevel(xz: vec2f, level: f32) -> vec4f { return terrainNormalRock(xz); }
fn terrainShoreSample(xz: vec2f) -> vec4f {
  if (terrainParams.shoreEnabled < 0.5 || !terrainInside(xz)) { return vec4f(0.0); }
  let dim = vec2i(textureDimensions(terrainShore, 0));
  let p = clamp(terrainUvOf(xz) * vec2f(dim) - 0.5, vec2f(0.0), vec2f(dim - 1));
  let q = min(vec2i(floor(p)), max(dim - 2, vec2i(0))); let f = p - vec2f(q);
  return mix(mix(textureLoad(terrainShore, q, 0), textureLoad(terrainShore, min(q + vec2i(1, 0), dim - 1), 0), f.x),
    mix(textureLoad(terrainShore, min(q + vec2i(0, 1), dim - 1), 0), textureLoad(terrainShore, min(q + vec2i(1), dim - 1), 0), f.x), f.y);
}
// Uses actual native cascaded terrain caster depth, shared with SceneLighting.
// Contract/lighting entry takes xz. The pinned ocean uses a vec3f instead:
// its owned adapter must rename those calls to terrainSunShadowAtWorld.
fn terrainSunShadowAt(xz: vec2f) -> f32 {
  if (!terrainInside(xz)) { return 1.0; }
  return sunShadowPCF(apsTerrainWorldPosition(vec3f(xz.x, terrainHeightAt(xz), xz.y)),apsTerrainWorldNormal(terrainNormalAt(xz)),vec2f(0));
}
fn terrainSunShadowAtWorld(P: vec3f) -> f32 { return sunShadowHard(P); }
`;

export function createTerrainSampling(scene, profile, height, shore, surface = terrainSurfaceOptions(scene.surface_reconstruction)) {
  const params = new UniformBlock('APSTerrainParams', {
    worldFromNative: ['mat4x4f', new Matrix4()], nativeFromWorld: ['mat4x4f', new Matrix4()],
    origin: ['vec2f', [...scene.origin_xz_m]], extent: ['vec2f', [...scene.extent_xz_m]],
    spacing: ['vec2f', [...scene.spacing_xz_m]], shape: ['vec2f', [scene.shape[1], scene.shape[0]]],
    noiseAnchor: ['vec2f', [...scene.surface.noise_anchor_xz_m]],
    coastalEnabled: ['f32', 0], shoreEnabled: ['f32', 0],
    seaLevel: ['f32', scene.ocean?.seaLevel ?? scene.ocean?.sealevel ?? profile.distribution.sea_level_m ?? 0],
    detail: ['f32', 1], influence: ['f32', 1], vegetation: ['f32', profile.distribution.vegetation_amount], mode: ['i32', 0]
  });
  const module = new ShaderModule({name: 'aps-native-terrain', deps: [shadowModule], uniforms: params, uniformName: 'terrainParams',
    bindings: {terrainHeight: {texture: height, sampleType: 'unfilterable-float'}, terrainShore: {texture: shore, sampleType: 'unfilterable-float'}},
    code: terrainSamplingWGSL+surfaceWGSL(surface.mode)});
  return {module, params};
}

export function setTerrainSamplingFrame(sampling, frame) {
  sampling.params.set('worldFromNative', frame.worldFromNative);
  sampling.params.set('nativeFromWorld', frame.nativeFromWorld);
}
