                                                                    
  
                                                                                 
  
                                                                            
                                                                         
                                                                          
                                                                            
                                               
  
                                                                        
                                                          
                                                         
                                                              
                                                                    
                                                 

export const LIGHT_CULL_REVISION = 'rds-light-cull-r3-global-hiz';

export const LIGHT_DEMAND_LEVELS = 4;
export const LIGHT_DEMAND_STRIDE_BYTES = 32;
export const LIGHT_DEMAND_BYTES = LIGHT_DEMAND_LEVELS * LIGHT_DEMAND_STRIDE_BYTES;
export const LIGHT_DEMAND_FIELD_ORDER = Object.freeze([
  'minU', 'minV', 'minZ', 'count', 'maxU', 'maxV', 'maxZ', 'flags',
]);

export const DEMAND_UV_QUANT = 65535;
export const DEMAND_Z_QUANT = 16777215;
export const DEMAND_UV_STEP = 1 / DEMAND_UV_QUANT;
export const DEMAND_Z_STEP = 1 / DEMAND_Z_QUANT;

export const DEMAND_FLAG_HAS_RECEIVERS = 1;
export const DEMAND_FLAG_LEGACY_FULL = 2;
export const DEMAND_FLAG_EDGE_CONSERVATIVE = 4;
export const DEMAND_FLAG_EXTERNAL_UNION = 8;
export const DEMAND_FLAG_TILE_MASK_VALID = 16;

                                                                              
                                                                           
                                                                               
                                                                               
                                                                                
                                                                                
                                                                               
                                      
export const LIGHT_CULL_FLAG_ENABLED = 1;
export const LIGHT_CULL_FLAG_LEGACY_FULL = 2;
export const LIGHT_CULL_FLAG_FORWARD_Z = 4;
export const LIGHT_CULL_FLAG_GLOBAL_HIZ = 8;
export const LIGHT_CULL_FLAG_REUSE = 16;
export const LIGHT_CULL_PARAMS_BYTES = 144;

export const LIGHT_HIZ_FORMAT = 'r32float';
export const LIGHT_HIZ_BACKGROUND = 1.0;
export const LIGHT_HIZ_EPSILON = 1e-6;
                                                                              
                                                                             
                             
export const LIGHT_RASTER_BIAS_ULPS = 4;
export const LIGHT_FLOAT32_ULP = 2 ** -23;

                                                                                
                                                                             
                                                        
export const LIGHT_HIZ_COPY_WGSL =            `
@group(0) @binding(0) var source:texture_depth_2d;
@group(0) @binding(1) var dest:texture_storage_2d<r32float,write>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) gid:vec3u){
 let p=vec2i(gid.xy);if(any(p>=vec2i(textureDimensions(dest)))){return;}
 var d=1.0;
 if(all(p<vec2i(textureDimensions(source)))){d=textureLoad(source,p,0);}
 textureStore(dest,p,vec4f(d,0.0,0.0,1.0));
}`;

                                                                        
                                                                            
                                        
export const LIGHT_HIZ_REDUCE_MAX_WGSL =            `
@group(0) @binding(0) var source:texture_2d<f32>;
@group(0) @binding(1) var dest:texture_storage_2d<r32float,write>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) gid:vec3u){
 let p=vec2i(gid.xy);if(any(p>=vec2i(textureDimensions(dest)))){return;}
 let s=p*2;let limit=vec2i(textureDimensions(source))-vec2i(1);
 let a=textureLoad(source,min(s,limit),0).r;
 let b=textureLoad(source,min(s+vec2i(1,0),limit),0).r;
 let c=textureLoad(source,min(s+vec2i(0,1),limit),0).r;
 let d=textureLoad(source,min(s+vec2i(1,1),limit),0).r;
 textureStore(dest,p,vec4f(max(max(a,b),max(c,d)),0.0,0.0,1.0));
}`;

                                                                        
                                                            
export const LIGHT_CULL_WGSL =            `
struct LightCullParams {
 level:u32,
 flags:u32,
 padTexels:f32,
 depthPad:f32,
 demandIndex:u32,
 globalEnabled:u32,
 globalWidth:u32,
 globalHeight:u32,
 globalVP:mat4x4f,
 globalDepthBias:f32,
 globalNear:f32,
 globalFar:f32,
 reuseFlags:u32,
 reuseMinU:u32,
 reuseMinV:u32,
 reuseMaxU:u32,
 reuseMaxV:u32,
 reuseSourceLevel:u32,
 reuseReserved:u32
};
struct ReceiverDemand {
 minU:u32,
 minV:u32,
 minZ:u32,
 count:u32,
 maxU:u32,
 maxV:u32,
 maxZ:u32,
 flags:u32
};
@group(0) @binding(13) var<uniform> lightCull:LightCullParams;
@group(0) @binding(14) var<storage,read> receiverDemand:array<ReceiverDemand,4>;

fn apsLightFinite4(v:vec4f)->bool{
 return !any(v!=v) && all(abs(v)<vec4f(1e30));
}
// Only the selected light orthographic view and the forward-Z static Hi-Z are
// used. A caster is rejected only when
//   * demand has no receivers (unless legacyFull), or
//   * its full projected rect is disjoint from the padded demand rect and the
//     demand is trustworthy (no legacyFull/edgeConservative/invalid fields), or
//   * its nearest projected depth is strictly behind every demanded receiver
//     under that same trustworthy-demand condition,
//   * its nearest depth is strictly behind the farthest static depth over ALL
//     covered Hi-Z cells plus the conservative depthPad.
// legacyFull and edgeConservative bypass only the demand-only count/XY/Z tests.
// Invalid/inverted demand fields also bypass only those demand tests. The
// whole-projected-rect static occlusion always runs for a bbox fully inside the
// light map, so those flags can never silently disable static Hi-Z.
//
// Global mode (flags bit3): the AABB eight corners are projected with
// lightCull.globalVP into the single global-size pyramid captured from the
// largest-coverage cascade. The cascade's own View.vp is still used for the
// frustum/LOD/grass work upstream and for the final shadow raster, never as the
// global occlusion projection and never to sample the global map with cascade
// UVs. Depth bias and dimensions are the global ones. Near-plane/far-plane/
// map-border crossings, non-finite corners, holes and masked/unknown cells
// always keep the caster.
fn apsLightCullReject(center:vec3f,extent:vec3f)->bool{
 if((lightCull.flags&1u)==0u){return false;}
 let level=min(lightCull.level,3u);
 let d=receiverDemand[level];
 // lightCull.flags bit1 is also legacyFull. Bit2 of lightCull.flags is the
 // forward-Z capability flag, NOT edgeConservative, so edge comes only from d.
 let legacy=((d.flags|lightCull.flags)&2u)!=0u;
 let edge=(d.flags&4u)!=0u;
 let bypass=legacy||edge;
 // A producer-reported zero count is definitive empty demand. legacyFull is
 // the explicit full fallback and may bypass it; edgeConservative must not
 // invent receivers where count says there are none.
 if(!legacy&&d.count==0u){return true;}
 let global=(lightCull.flags&8u)!=0u;
 // Matrices are not valid select() operands in WGSL; branch-assign instead.
 var projectVP=view.vp;
 if(global){projectVP=lightCull.globalVP;}
 let mapSize=select(view.screen.xy,vec2f(f32(max(lightCull.globalWidth,1u)),f32(max(lightCull.globalHeight,1u))),global);
 let staticBias=select(lightCull.depthPad,lightCull.globalDepthBias,global);
 var lo=vec2f(1e30);
 var hi=vec2f(-1e30);
 var nearZ=1e30;
 var crossing=false;
 for(var k=0u;k<8u;k++){
  let sign=vec3f(select(-1.0,1.0,(k&1u)!=0u),select(-1.0,1.0,(k&2u)!=0u),select(-1.0,1.0,(k&4u)!=0u));
  let c=projectVP*vec4f(center+extent*sign,1.0);
  if(!apsLightFinite4(c)){return false;}
  let u=c.x*.5+.5;
  let v=.5-c.y*.5;
  let z=c.z;
  lo=min(lo,vec2f(u,v));
  hi=max(hi,vec2f(u,v));
  nearZ=min(nearZ,z);
  crossing=crossing||z<0.0||z>1.0||u<0.0||u>1.0||v<0.0||v>1.0;
 }
 if(crossing){return false;}
 let invalidDemand=d.minU>d.maxU||d.minV>d.maxV||d.minZ>d.maxZ;
 if(!bypass&&!invalidDemand){
  // Widen the decoded demand by one quantization step. This absorbs
  // floor/ceil rounding in the producer and can only make the test safer.
  let du=vec2f(f32(d.minU),f32(d.minV))/65535.0-vec2f(1.0/65535.0);
  let eu=vec2f(f32(d.maxU),f32(d.maxV))/65535.0+vec2f(1.0/65535.0);
  let ez=f32(d.maxZ)/16777215.0+1.0/16777215.0;
  if(hi.x<du.x||lo.x>eu.x||hi.y<du.y||lo.y>eu.y){return true;}
  if(nearZ>ez+lightCull.depthPad){return true;}
 }
 let lastMip=max(0u,textureNumLevels(pyramid)-1u);
 // All Hi-Z work is in texels. mapSize is the captured global map size in
 // global mode; using normalized UV here would select a mip that is too fine.
 let loPx=lo*mapSize;
 let hiPx=hi*mapSize;
 var mipF=ceil(log2(max(max(1.0,hiPx.x-loPx.x),max(1.0,hiPx.y-loPx.y))));
 mipF=clamp(mipF,0.0,f32(lastMip));
 let mip=i32(mipF);
 let scale=exp2(mipF);
 let dims=vec2i(textureDimensions(pyramid,mip));
 let a=vec2i(floor(loPx/scale));
 let b=vec2i(floor(hiPx/scale));
 if(any(b<a)){return false;}
 // The chosen mip makes the rect at most two cells per axis. The 3x3 bound
 // covers a floating-point off-by-one; anything larger is unknown -> keep.
 if(b.x-a.x>2||b.y-a.y>2){return false;}
 let first=clamp(a,vec2i(0),dims-vec2i(1));
 let last=clamp(b,vec2i(0),dims-vec2i(1));
 var farthest=0.0;
 for(var dy=0u;dy<3u;dy++){
  let y=first.y+i32(dy);
  if(y>last.y){break;}
  for(var dx=0u;dx<3u;dx++){
   let x=first.x+i32(dx);
   if(x>last.x){break;}
   let tap=textureLoad(pyramid,vec2i(x,y),mip).r;
   if(!(tap>=0.0)||tap>1.0){return false;}
   farthest=max(farthest,tap);
  }
 }
 if(farthest>=1.0-1e-6){return false;}
 return nearZ>farthest+staticBias;
}
// Fine->coarse seed coverage. reuseMin/MaxU/V are CURRENT-cascade pixel
// coordinates (not UV, not the fine cascade's pixels). The rectangle is only
// written by the planner for coarse texels whose complete footprint is covered
// by a trustworthy finer depth image, so an instance whose whole projected AABB
// is inside it is already represented by the seeded depth. Anything crossing
// the border, non-finite, outside the map or behind the current level keeps the
// instance; the fragment coverage module then masks only the covered texels.
fn apsLightReuseEnabled()->bool{
 return (lightCull.flags&16u)!=0u;
}
fn apsLightReuseReject(center:vec3f,extent:vec3f)->bool{
 if(!apsLightReuseEnabled()){return false;}
 if(lightCull.reuseSourceLevel>=lightCull.level){return false;}
 if(lightCull.reuseMinU>=lightCull.reuseMaxU||lightCull.reuseMinV>=lightCull.reuseMaxV){return false;}
 let reuseMap=vec2f(f32(max(lightCull.globalWidth,1u)),f32(max(lightCull.globalHeight,1u)));
 var lo=vec2f(1e30);var hi=vec2f(-1e30);
 for(var k=0u;k<8u;k++){
  let sign=vec3f(select(-1.0,1.0,(k&1u)!=0u),select(-1.0,1.0,(k&2u)!=0u),select(-1.0,1.0,(k&4u)!=0u));
  let c=view.vp*vec4f(center+extent*sign,1.0);
  if(!apsLightFinite4(c)){return false;}
  let u=c.x*.5+.5;let v=.5-c.y*.5;
  if(c.z<0.0||c.z>1.0||u<0.0||u>1.0||v<0.0||v>1.0){return false;}
  lo=min(lo,vec2f(u,v)*reuseMap);hi=max(hi,vec2f(u,v)*reuseMap);
 }
 return lo.x>=f32(lightCull.reuseMinU)&&lo.y>=f32(lightCull.reuseMinV)
   &&hi.x<=f32(lightCull.reuseMaxU)&&hi.y<=f32(lightCull.reuseMaxV);
}`;

                                                                                
                                                                               
                                                                            
                                                                               
export function encodeLightCullParams({
  level = 0, flags = 0, padTexels = 0, depthPad = 0, demandIndex = 0, global = null, reuse = null,
} = {}) {
  const bytes = new ArrayBuffer(LIGHT_CULL_PARAMS_BYTES);
  const u = new Uint32Array(bytes);
  const f = new Float32Array(bytes);
  u[0] = level >>> 0;
  u[1] = flags >>> 0;
  f[2] = Number(padTexels);
  f[3] = Number(depthPad);
  u[4] = demandIndex >>> 0;
  const vp = global?.vp;
  const validVP = Array.isArray(vp) && vp.length >= 16 && vp.slice(0, 16).every(Number.isFinite);
  if (global?.enabled && validVP) {
    u[1] = (u[1] | LIGHT_CULL_FLAG_GLOBAL_HIZ) >>> 0;
    u[5] = 1;
    u[6] = Math.max(1, global.width | 0) >>> 0;
    u[7] = Math.max(1, global.height | 0) >>> 0;
    f.set(vp.slice(0, 16), 8);                   
    f[24] = Math.max(0, Number(global.depthBias) || 0);             
    f[25] = Number(global.near) || 0;
    f[26] = Number(global.far) || 0;
    u[27] = LIGHT_CULL_FLAG_GLOBAL_HIZ;
  }
                                                                            
                                                                               
                                                                                
                                                       
  if (reuse?.enabled) {
    const minU = Number(reuse.minU), minV = Number(reuse.minV);
    const maxU = Number(reuse.maxU), maxV = Number(reuse.maxV);
    const sourceLevel = Number(reuse.sourceLevel);
    if ([minU, minV, maxU, maxV].every(Number.isFinite)
      && Number.isInteger(sourceLevel) && sourceLevel >= 0 && sourceLevel < (level >>> 0)
      && minU < maxU && minV < maxV) {
      u[1] = (u[1] | LIGHT_CULL_FLAG_REUSE) >>> 0;
      u[27] = (u[27] | LIGHT_CULL_FLAG_REUSE) >>> 0;
      u[28] = Math.max(0, Math.round(minU)) >>> 0;
      u[29] = Math.max(0, Math.round(minV)) >>> 0;
      u[30] = Math.max(0, Math.round(maxU)) >>> 0;
      u[31] = Math.max(0, Math.round(maxV)) >>> 0;
      u[32] = sourceLevel >>> 0;
    }
  }
  return bytes;
}

                                                                              
                                      
                                                                              

const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));

export function quantizeUV(value) {
  return clamp(Math.round(Number(value) * DEMAND_UV_QUANT), 0, DEMAND_UV_QUANT);
}

export function quantizeZ(value) {
  return clamp(Math.round(Number(value) * DEMAND_Z_QUANT), 0, DEMAND_Z_QUANT);
}

export function encodeDemandLevels(levels) {
  const out = new Uint32Array(LIGHT_DEMAND_LEVELS * 8);
  for (let i = 0; i < LIGHT_DEMAND_LEVELS; i++) {
    const level = levels?.[i] ?? {};
    const at = i * 8;
    out[at + 0] = Number.isInteger(level.minU) ? clamp(level.minU, 0, DEMAND_UV_QUANT) : quantizeUV(level.minU ?? 0);
    out[at + 1] = Number.isInteger(level.minV) ? clamp(level.minV, 0, DEMAND_UV_QUANT) : quantizeUV(level.minV ?? 0);
    out[at + 2] = Number.isInteger(level.minZ) ? clamp(level.minZ, 0, DEMAND_Z_QUANT) : quantizeZ(level.minZ ?? 0);
    out[at + 3] = (level.count ?? 0) >>> 0;
    out[at + 4] = Number.isInteger(level.maxU) ? clamp(level.maxU, 0, DEMAND_UV_QUANT) : quantizeUV(level.maxU ?? 0);
    out[at + 5] = Number.isInteger(level.maxV) ? clamp(level.maxV, 0, DEMAND_UV_QUANT) : quantizeUV(level.maxV ?? 0);
    out[at + 6] = Number.isInteger(level.maxZ) ? clamp(level.maxZ, 0, DEMAND_Z_QUANT) : quantizeZ(level.maxZ ?? 0);
    out[at + 7] = (level.flags ?? 0) >>> 0;
  }
  return out;
}

export function decodeDemand(source) {
  const u = source instanceof Uint32Array ? source : new Uint32Array(source);
  if (u.length < LIGHT_DEMAND_LEVELS * 8) {
    throw Error(`ReceiverDemand must be ${LIGHT_DEMAND_BYTES} bytes`);
  }
  return Array.from({ length: LIGHT_DEMAND_LEVELS }, (_, i) => {
    const at = i * 8;
    const minU = u[at + 0], minV = u[at + 1], minZ = u[at + 2], count = u[at + 3];
    const maxU = u[at + 4], maxV = u[at + 5], maxZ = u[at + 6], flags = u[at + 7];
    return {
      level: i, minU, minV, minZ, count, maxU, maxV, maxZ, flags,
      uv: { min: [minU / DEMAND_UV_QUANT, minV / DEMAND_UV_QUANT], max: [maxU / DEMAND_UV_QUANT, maxV / DEMAND_UV_QUANT] },
      depth: { min: minZ / DEMAND_Z_QUANT, max: maxZ / DEMAND_Z_QUANT },
      hasReceivers: (flags & DEMAND_FLAG_HAS_RECEIVERS) !== 0,
      legacyFull: (flags & DEMAND_FLAG_LEGACY_FULL) !== 0,
      edgeConservative: (flags & DEMAND_FLAG_EDGE_CONSERVATIVE) !== 0,
      externalUnion: (flags & DEMAND_FLAG_EXTERNAL_UNION) !== 0,
      tileMaskValid: (flags & DEMAND_FLAG_TILE_MASK_VALID) !== 0,
    };
  });
}

function transformPoint(vp, x, y, z) {
                                                                     
  return [
    vp[0] * x + vp[4] * y + vp[8] * z + vp[12],
    vp[1] * x + vp[5] * y + vp[9] * z + vp[13],
    vp[2] * x + vp[6] * y + vp[10] * z + vp[14],
    vp[3] * x + vp[7] * y + vp[11] * z + vp[15],
  ];
}

                                                                         
                                                                         
                                                    
export function projectLightBounds(vp, center, extent) {
  const lo = [Infinity, Infinity];
  const hi = [-Infinity, -Infinity];
  let nearZ = Infinity, farZ = -Infinity;
  let crossing = false, nonfinite = false, nearPlaneCrossing = false, outsideMap = false;
  const corners = [];
  for (let k = 0; k < 8; k++) {
    const sx = (k & 1) ? 1 : -1, sy = (k & 2) ? 1 : -1, sz = (k & 4) ? 1 : -1;
    const clip = transformPoint(
      vp,
      center[0] + extent[0] * sx,
      center[1] + extent[1] * sy,
      center[2] + extent[2] * sz,
    );
    if (!clip.every(Number.isFinite)) { nonfinite = true; corners.push(clip); continue; }
    const u = clip[0] * 0.5 + 0.5;
    const v = 0.5 - clip[1] * 0.5;
    const z = clip[2];
    corners.push([u, v, z]);
    lo[0] = Math.min(lo[0], u); lo[1] = Math.min(lo[1], v);
    hi[0] = Math.max(hi[0], u); hi[1] = Math.max(hi[1], v);
    nearZ = Math.min(nearZ, z); farZ = Math.max(farZ, z);
    if (z < 0 || z > 1) nearPlaneCrossing = true;
    if (u < 0 || u > 1 || v < 0 || v > 1) outsideMap = true;
  }
  crossing = nearPlaneCrossing || outsideMap;
  return { corners, lo, hi, nearZ, farZ, crossing, nonfinite, nearPlaneCrossing, outsideMap };
}

                                                                            
                                                                       
export function chooseMip(rect, levelCount) {
  const width = Math.max(1, rect.hi[0] - rect.lo[0]);
  const height = Math.max(1, rect.hi[1] - rect.lo[1]);
  return clamp(Math.ceil(Math.log2(Math.max(width, height))), 0, Math.max(0, levelCount - 1));
}

export function coveredCells(rect, mip, dimensions) {
  const scale = 2 ** mip;
  const dims = [Math.max(1, dimensions[0] | 0), Math.max(1, dimensions[1] | 0)];
  const a = [Math.floor(rect.lo[0] / scale), Math.floor(rect.lo[1] / scale)];
  const b = [Math.floor(rect.hi[0] / scale), Math.floor(rect.hi[1] / scale)];
  if (b[0] < a[0] || b[1] < a[1]) return { a, b, scale, count: 0, tooMany: false, empty: true };
  const first = [clamp(a[0], 0, dims[0] - 1), clamp(a[1], 0, dims[1] - 1)];
  const last = [clamp(b[0], 0, dims[0] - 1), clamp(b[1], 0, dims[1] - 1)];
  const tooMany = last[0] - first[0] > 2 || last[1] - first[1] > 2 || b[0] - a[0] > 2 || b[1] - a[1] > 2;
  const count = (last[0] - first[0] + 1) * (last[1] - first[1] + 1);
  return { a, b, first, last, scale, dims, count, tooMany, empty: false };
}

                                                                             
                                                                
export function sampleCoveredCells(hiz, pixelRect, mip) {
  const level = hiz[mip];
  const cells = coveredCells(pixelRect, mip, [level.width, level.height]);
  if (cells.empty) return { unknown: true, reason: 'empty-rect', mip, cells };
  if (cells.tooMany) return { unknown: true, reason: 'too-many-cells', mip, cells };
  const taps = [];
  let farthest = 0;
  let hole = false;
  let background = true;
  for (let y = cells.first[1]; y <= cells.last[1]; y++) {
    for (let x = cells.first[0]; x <= cells.last[0]; x++) {
      const value = level.data[y * level.width + x];
      taps.push({ x, y, value });
      if (!Number.isFinite(value) || value < 0 || value > 1) {
        return { unknown: true, reason: 'non-finite-tap', mip, cells, taps };
      }
      if (value >= 1 - LIGHT_HIZ_EPSILON) hole = true;
      else background = false;
      farthest = Math.max(farthest, value);
    }
  }
  return { unknown: false, hole, background, mip, cells, taps, farthest };
}

                                                                           
                                                                              
                             
export function sampleStaticOccluder(hiz, rect) {
  if (!Array.isArray(hiz) || !hiz.length) return { unknown: true, reason: 'no-pyramid' };
  const mapSize = hiz[0].width;
  const pixelRect = { lo: [rect.lo[0] * mapSize, rect.lo[1] * mapSize], hi: [rect.hi[0] * mapSize, rect.hi[1] * mapSize] };
  const mip = chooseMip(pixelRect, hiz.length);
  return { ...sampleCoveredCells(hiz, pixelRect, mip), mip, pixelRect };
}

                                                                             
                                                                           
export function lightDepthPad({ near, far, texelWorld = 0, normalBias = 0, occlusionBias = 0, rasterBiasUlps = LIGHT_RASTER_BIAS_ULPS } = {}) {
  const range = Number(far) - Number(near);
  if (!(range > 0) || !Number.isFinite(range)) throw Error('lightDepthPad requires a finite positive cascade range');
  for (const [name, value] of Object.entries({ texelWorld, normalBias, occlusionBias, rasterBiasUlps })) {
    if (!Number.isFinite(value) || value < 0) throw Error(`lightDepthPad ${name} must be finite and nonnegative`);
  }
  return (occlusionBias + normalBias + 2 * texelWorld) / range
    + (rasterBiasUlps + 1) * LIGHT_FLOAT32_ULP;
}

                                                                              
                                                                                 
                                                                               
                                                                           
export function evaluateLightCull({
  vp, center, extent, demand, level = 0, hiz = null,
  depthPad = 0, enabled = true, lightLegacyFull = false, global = null,
}) {
  const d = Array.isArray(demand) ? demand[level] : demand;
  if (!d) throw Error('evaluateLightCull requires ReceiverDemand level '+level);
  if (!enabled) return { cull: false, reason: 'disabled', demand: d };
  const legacy = !!lightLegacyFull || !!(d.flags & DEMAND_FLAG_LEGACY_FULL);
  const edge = !!(d.flags & DEMAND_FLAG_EDGE_CONSERVATIVE);
                                                                            
                                                                           
  const bypassDemand = legacy || edge;
  if (!legacy && d.count === 0) return { cull: true, reason: 'no-receivers', demand: d };
  const useGlobal = !!(global?.vp?.length >= 16 && global.vp.slice(0, 16).every(Number.isFinite));
  const projectVP = useGlobal ? global.vp : vp;
  const projected = projectLightBounds(projectVP, center, extent);
  if (projected.nonfinite) return { cull: false, reason: 'nonfinite', projected, demand: d, global: useGlobal };
  if (projected.crossing) return { cull: false, reason: projected.nearPlaneCrossing ? 'near-plane' : 'outside-map', projected, demand: d, global: useGlobal };
  const invalidDemand = d.minU > d.maxU || d.minV > d.maxV || d.minZ > d.maxZ;
  const { lo, hi, nearZ } = projected;
  if (!bypassDemand && !invalidDemand) {
    const du = [d.minU / DEMAND_UV_QUANT - DEMAND_UV_STEP, d.minV / DEMAND_UV_QUANT - DEMAND_UV_STEP];
    const eu = [d.maxU / DEMAND_UV_QUANT + DEMAND_UV_STEP, d.maxV / DEMAND_UV_QUANT + DEMAND_UV_STEP];
    const ez = d.maxZ / DEMAND_Z_QUANT + DEMAND_Z_STEP;
    if (hi[0] < du[0] || lo[0] > eu[0] || hi[1] < du[1] || lo[1] > eu[1]) {
      return { cull: true, reason: 'demand-xy', projected, demand: d, global: useGlobal };
    }
    if (nearZ > ez + depthPad) return { cull: true, reason: 'demand-z', projected, demand: d, global: useGlobal };
  }
  const sample = useGlobal
    ? sampleStaticOccluderAt(hiz, projected, global.width, global.height)
    : sampleStaticOccluder(hiz, projected);
  if (sample.unknown) return { cull: false, reason: sample.reason, projected, demand: d, sample, global: useGlobal };
  if (sample.background) return { cull: false, reason: 'hiz-background', projected, demand: d, sample, global: useGlobal };
  if (sample.hole) return { cull: false, reason: 'hiz-hole', projected, demand: d, sample, global: useGlobal };
  if (sample.farthest >= 1 - LIGHT_HIZ_EPSILON) {
    return { cull: false, reason: 'hiz-background', projected, demand: d, sample, global: useGlobal };
  }
  const staticBias = useGlobal ? Math.max(0, Number(global.depthBias) || 0) : depthPad;
  if (nearZ > sample.farthest + staticBias) {
    return { cull: true, reason: 'static-hiz', projected, demand: d, sample, global: useGlobal };
  }
  return { cull: false, reason: 'kept', projected, demand: d, sample, global: useGlobal };
}

                                                                             
                                                                                
                                                                                
                                                                              
export function evaluateLightReuse({
  vp, center, extent, reuse, level = 0, mapSize = 1,
} = {}) {
  if (!reuse?.enabled) return { skip: false, reason: 'reuse-disabled' };
  if (!(Number.isInteger(reuse.sourceLevel) && reuse.sourceLevel >= 0 && reuse.sourceLevel < level)) {
    return { skip: false, reason: 'source-not-finer' };
  }
  const { minU, minV, maxU, maxV } = reuse;
  if (![minU, minV, maxU, maxV].every(Number.isFinite) || minU >= maxU || minV >= maxV) {
    return { skip: false, reason: 'invalid-rect' };
  }
  const projected = projectLightBounds(vp, center, extent);
  if (projected.nonfinite) return { skip: false, reason: 'nonfinite', projected };
  if (projected.crossing) {
    return { skip: false, reason: projected.nearPlaneCrossing ? 'near-plane' : 'outside-map', projected };
  }
  const size = Math.max(1, Number(mapSize) | 0);
  const lo = [projected.lo[0] * size, projected.lo[1] * size];
  const hi = [projected.hi[0] * size, projected.hi[1] * size];
  if (lo[0] < minU || lo[1] < minV || hi[0] > maxU || hi[1] > maxV) {
    return { skip: false, reason: 'crosses-reuse-rect', projected, lo, hi };
  }
  return { skip: true, reason: 'reuse-covered', projected, lo, hi };
}

                                                                             
export function sampleStaticOccluderAt(hiz, projected, width, height) {
  if (!Array.isArray(hiz) || !hiz.length) return { unknown: true, reason: 'no-pyramid' };
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
    return { unknown: true, reason: 'bad-global-size' };
  }
  const pixelRect = { lo: [projected.lo[0] * width, projected.lo[1] * height], hi: [projected.hi[0] * width, projected.hi[1] * height] };
  const mip = chooseMip(pixelRect, hiz.length);
  return { ...sampleCoveredCells(hiz, pixelRect, mip), mip, pixelRect };
}
