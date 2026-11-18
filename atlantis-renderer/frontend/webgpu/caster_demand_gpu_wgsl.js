                                                           
  
                                                             
                                                                                
                                                                              
  
                                                                    
                                                                       
                                                                         
                                                     
                                                                                
                                                                
  
                                                                               
                                                                               
                                                                             
                                                                        

export const CASTER_DEMAND_COMMON_WGSL =            `
const APS_DEMAND_UV_SCALE:f32 = 65535.0;
const APS_DEMAND_Z_SCALE:f32 = 16777215.0;
const APS_DEMAND_LEGACY_FULL:u32 = 2u;
struct ApsProjectedCasterBounds {
  minU:f32, minV:f32, minZ:f32,
  maxU:f32, maxV:f32, maxZ:f32,
};

fn apsDemandLevelValid(level:u32)->bool {
  let words = arrayLength(&demand);
  let base = level * 8u;
  if (base + 8u > words) { return false; }
  let flags = demand[base + 7u];
  let count = demand[base + 3u];
  let minU = demand[base + 0u];
  let minV = demand[base + 1u];
  let minZ = demand[base + 2u];
  let maxU = demand[base + 4u];
  let maxV = demand[base + 5u];
  let maxZ = demand[base + 6u];
  if ((flags & APS_DEMAND_LEGACY_FULL) != 0u) { return false; }
  if (count == 0u) { return false; }
  if (minU > maxU || minV > maxV || minZ > maxZ) { return false; }
  if (maxU > 65535u || maxV > 65535u || maxZ > 16777215u) { return false; }
  return true;
}

fn apsFinite(value:f32)->bool {
  return (bitcast<u32>(value) & 0x7f800000u) != 0x7f800000u;
}

fn apsNonNegative(value:f32)->f32 {
  return select(0.0, value, apsFinite(value) && value >= 0.0);
}

fn apsBoundsKnown(minP:vec3f, maxP:vec3f)->bool {
  if (!apsFinite(minP.x) || !apsFinite(minP.y) || !apsFinite(minP.z)) { return false; }
  if (!apsFinite(maxP.x) || !apsFinite(maxP.y) || !apsFinite(maxP.z)) { return false; }
  if (minP.x > maxP.x || minP.y > maxP.y || minP.z > maxP.z) { return false; }
  return true;
}

fn apsProjectionFinite(r:ApsProjectedCasterBounds)->bool {
  return apsFinite(r.minU) && apsFinite(r.maxU)
    && apsFinite(r.minV) && apsFinite(r.maxV)
    && apsFinite(r.minZ) && apsFinite(r.maxZ);
}

fn apsProjectCasterBounds(minP:vec3f, maxP:vec3f)->ApsProjectedCasterBounds {
  var r = ApsProjectedCasterBounds(1e30, 1e30, 1e30, -1e30, -1e30, -1e30);
  for (var i:u32 = 0u; i < 8u; i = i + 1u) {
    let corner = vec3f(
      select(minP.x, maxP.x, (i & 1u) != 0u),
      select(minP.y, maxP.y, (i & 2u) != 0u),
      select(minP.z, maxP.z, (i & 4u) != 0u)
    );
    let clip = params.viewProj * vec4f(corner, 1.0);
    let u = clip.x * 0.5 + 0.5;
    let v = select(0.5 - clip.y * 0.5, clip.y * 0.5 + 0.5, params.uvMode == 1u);
    r.minU = min(r.minU, u); r.maxU = max(r.maxU, u);
    r.minV = min(r.minV, v); r.maxV = max(r.maxV, v);
    r.minZ = min(r.minZ, clip.z); r.maxZ = max(r.maxZ, clip.z);
  }
  return r;
}

// Conservative overlap with the current cascade light frustum.  UV already
// contains the clip->[0,1] transform, so using padUv directly as UV padding is
// at least as wide as the clip-space x/y range [-1-pad, 1+pad].  A caster that
// straddles any plane is kept.  The main camera is never used here.
fn apsLightFrustumKeep(r:ApsProjectedCasterBounds, padUv:f32, depthPad:f32)->bool {
  let pad = apsNonNegative(padUv);
  let dep = apsNonNegative(depthPad);
  let xy = r.maxU >= -pad && r.minU <= 1.0 + pad
    && r.maxV >= -pad && r.minV <= 1.0 + pad;
  if (!xy) { return false; }
  return r.maxZ >= -dep && r.minZ <= 1.0 + dep;
}

// true: keep the whole caster draw. false: it cannot influence any demanded
// receiver in this level.
fn apsCasterKeep(minP:vec3f, maxP:vec3f, unknown:bool)->bool {
  // Unknown, inverted or non-finite bounds and non-finite projection fail open.
  if (unknown) { return true; }
  if (!apsBoundsKnown(minP, maxP)) { return true; }
  let projected = apsProjectCasterBounds(minP, maxP);
  if (!apsProjectionFinite(projected)) { return true; }
  // Unconditional light-frustum rejection.  This must stay BEFORE every
  // forceFull/legacyFull/invalid-demand return, otherwise those bypasses would
  // upload casters wholly outside the light map again.
  if (!apsLightFrustumKeep(projected, params.padUv, params.depthPad)) { return false; }
  if ((params.flags & 1u) != 0u) { return true; }
  if (!apsDemandLevelValid(params.level)) { return true; }
  let base = params.level * 8u;
  let dMinU = f32(demand[base + 0u]) / APS_DEMAND_UV_SCALE;
  let dMinV = f32(demand[base + 1u]) / APS_DEMAND_UV_SCALE;
  let dMaxU = f32(demand[base + 4u]) / APS_DEMAND_UV_SCALE;
  let dMaxV = f32(demand[base + 5u]) / APS_DEMAND_UV_SCALE;
  let dMaxZ = f32(demand[base + 6u]) / APS_DEMAND_Z_SCALE;
  let pad = apsNonNegative(params.padUv);
  let xy = projected.maxU >= dMinU - pad
    && projected.minU <= dMaxU + pad
    && projected.maxV >= dMinV - pad
    && projected.minV <= dMaxV + pad;
  if (!xy) { return false; }
  // Only "behind every receiver" may reject. A caster closer to the light is
  // retained even when it is far outside the main camera.
  if (projected.minZ > dMaxZ + apsNonNegative(params.depthPad)) { return false; }
  return true;
}
`;

export const TERRAIN_CASTER_COMPACT_WGSL =            `
${CASTER_DEMAND_COMMON_WGSL}

@compute @workgroup_size(WG_X, 1, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= params.count) { return; }
  let bmin = sourceBounds[i * 2u];
  let bmax = sourceBounds[i * 2u + 1u];
  if (!apsCasterKeep(bmin.xyz, bmax.xyz, bmin.w > 0.5)) { return; }
  let slot = atomicAdd(&counter, 1u);
  if (slot < params.capacity) {
    // Preserve the exact original apsPatch record; only its slot/order changes.
    compactPatches[slot] = sourcePatches[i];
  }
}
`;

export const TERRAIN_CASTER_FINALIZE_WGSL =            `
@compute @workgroup_size(1, 1, 1)
fn main() {
  let count = min(counterFinal, params.capacity);
  commands[0] = params.indexCount;
  commands[1] = count;
  commands[2] = 0u;
  commands[3] = 0u;
  commands[4] = 0u;
}
`;

export const STATIC_CASTER_COMMAND_WGSL =            `
${CASTER_DEMAND_COMMON_WGSL}

@compute @workgroup_size(WG_X, 1, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= params.count) { return; }
  let bmin = sourceBounds[i * 2u];
  let bmax = sourceBounds[i * 2u + 1u];
  let drawMetadata = itemMeta[i]; // x primitiveCount, y instanceCount, z start, w firstInstance
  let mode = modes[i];           // 0 drawIndexedIndirect, 1 drawIndirect
  let o = i * 5u;
  if (!apsCasterKeep(bmin.xyz, bmax.xyz, false)) {
    commands[o + 0u] = 0u;
    commands[o + 1u] = 0u;
    commands[o + 2u] = 0u;
    commands[o + 3u] = 0u;
    commands[o + 4u] = 0u;
    return;
  }
  commands[o + 0u] = drawMetadata.x;
  commands[o + 1u] = drawMetadata.y;
  if (mode == 0u) {
    // indexed: [indexCount, instanceCount, firstIndex, baseVertex, firstInstance]
    commands[o + 2u] = drawMetadata.z;
    commands[o + 3u] = 0u;
    commands[o + 4u] = drawMetadata.w;
  } else {
    // non-indexed: [vertexCount, instanceCount, firstVertex, firstInstance]
    commands[o + 2u] = drawMetadata.z;
    commands[o + 3u] = drawMetadata.w;
    commands[o + 4u] = 0u;
  }
}
`;

export const CASTER_DEMAND_WGSL = Object.freeze({
  terrainCompact: TERRAIN_CASTER_COMPACT_WGSL,
  terrainFinalize: TERRAIN_CASTER_FINALIZE_WGSL,
  staticCommand: STATIC_CASTER_COMMAND_WGSL,
});
