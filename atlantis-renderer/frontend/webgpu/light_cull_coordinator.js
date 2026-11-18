                                                                             
  
                                         
  
                                                       
  
                                                        
                                                                           
                                                                          
        
  
                                                                    
                                                                        
                                                                         
                                                                             
  
                                                                    
                                
        
                                                                           
                                                                        
                                                            
  
                                                                 
                                                                           
                                                                              
                          

import {
  LIGHT_CULL_REVISION,
  LIGHT_DEMAND_BYTES,
  LIGHT_DEMAND_LEVELS,
  LIGHT_DEMAND_STRIDE_BYTES,
  LIGHT_HIZ_COPY_WGSL,
  LIGHT_HIZ_FORMAT,
  LIGHT_HIZ_REDUCE_MAX_WGSL,
  LIGHT_RASTER_BIAS_ULPS,
  LIGHT_FLOAT32_ULP,
  lightDepthPad,
} from './light_cull_wgsl.js';

const TEXTURE_USAGE = globalThis.GPUTextureUsage ?? {
  TEXTURE_BINDING: 4,
  STORAGE_BINDING: 8,
  COPY_DST: 2,
};
const WORKGROUP = 8;

export function mipLevelCount(size) {
  return Math.max(1, Math.floor(Math.log2(Math.max(1, size))) + 1);
}

export function mipDimension(size, mip) {
  return Math.max(1, Math.floor(size / 2 ** mip));
}

export class LightCullCoordinator {
  constructor(gpuOrOptions = {}, options = {}) {
    const isFacade = gpuOrOptions && typeof gpuOrOptions.getEncoder === 'function';
    const gpu = isFacade ? gpuOrOptions : gpuOrOptions?.gpu ?? null;
    const opts = isFacade ? options : (gpuOrOptions && typeof gpuOrOptions === 'object' ? gpuOrOptions : {});
    if (!gpu?.device?.createTexture) throw Error('LightCullCoordinator requires the WebGPU GPU facade (device + getEncoder)');
    this.gpu = gpu;
    this.device = gpu.device;
    this.depthPad = Number(opts.depthPad ?? 0.001);
    this.padTexels = Number(opts.padTexels ?? 0);
    if (!Number.isFinite(this.depthPad) || this.depthPad < 0) throw Error('LightCullCoordinator depthPad must be finite and nonnegative');
    if (!Number.isFinite(this.padTexels) || this.padTexels < 0) throw Error('LightCullCoordinator padTexels must be finite and nonnegative');
    this.timestampSink = typeof opts.timestampWrites === 'function' ? opts.timestampWrites : null;
    this.entries = new Array(LIGHT_DEMAND_LEVELS).fill(null);
    this.views = new Array(LIGHT_DEMAND_LEVELS).fill(null);
    this.globalEntry = null;
    this.globalViews = new Array(LIGHT_DEMAND_LEVELS).fill(null);
    this.pipelines = null;
    this.disposed = false;
    this.stats = { builds: 0, selects: 0, systems: 0, levels_built: 0, global_builds: 0, global_selects: 0 };
  }

  timestampWrites(label) {
    return this.timestampSink ? this.timestampSink(label) : undefined;
  }

  ensurePipelines() {
    if (this.pipelines) return this.pipelines;
    const usage = TEXTURE_USAGE.TEXTURE_BINDING | TEXTURE_USAGE.STORAGE_BINDING | TEXTURE_USAGE.COPY_DST;
    const copyModule = this.device.createShaderModule({ label: 'APS light Hi-Z array copy', code: LIGHT_HIZ_COPY_WGSL });
    const reduceModule = this.device.createShaderModule({ label: 'APS light Hi-Z forward max', code: LIGHT_HIZ_REDUCE_MAX_WGSL });
    this.pipelines = {
      copy: this.device.createComputePipeline({ label: 'APS light Hi-Z array copy', layout: 'auto', compute: { module: copyModule, entryPoint: 'main' } }),
      reduce: this.device.createComputePipeline({ label: 'APS light Hi-Z forward max reduce', layout: 'auto', compute: { module: reduceModule, entryPoint: 'main' } }),
    };
    this.textureUsage = usage;
    return this.pipelines;
  }

                                                                             
                                                                        
  build(size, level, depthView) {
    if (this.disposed) throw Error('LightCullCoordinator is disposed');
    if (!Number.isInteger(level) || level < 0 || level >= LIGHT_DEMAND_LEVELS) {
      throw Error(`LightCullCoordinator level must be 0..${LIGHT_DEMAND_LEVELS - 1}`);
    }
    const mapSize = Math.max(1, Number(size) | 0);
    if (!depthView) throw Error('LightCullCoordinator.build requires the cascade depth view');
    const pipelines = this.ensurePipelines();
    let entry = this.entries[level];
    if (!entry || entry.size !== mapSize) {
      entry?.hiz?.destroy?.();
      const levels = mipLevelCount(mapSize);
      const hiz = this.device.createTexture({
        label: `APS solar light ${level} forward-Z farthest Hi-Z`,
        size: [mapSize, mapSize],
        format: LIGHT_HIZ_FORMAT,
        mipLevelCount: levels,
        usage: this.textureUsage,
      });
      const reduceGroups = [];
      for (let mip = 1; mip < levels; mip++) {
        reduceGroups.push(this.device.createBindGroup({
          layout: pipelines.reduce.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: hiz.createView({ baseMipLevel: mip - 1, mipLevelCount: 1 }) },
            { binding: 1, resource: hiz.createView({ baseMipLevel: mip, mipLevelCount: 1 }) },
          ],
        }));
      }
      entry = { level, size: mapSize, levels, hiz, reduceGroups, copyGroup: null, lastDepthView: null };
      this.entries[level] = entry;
      this.views[level] = null;
      this.stats.levels_built++;
    }
                                                                               
                                                                            
    entry.copyGroup = this.device.createBindGroup({
      layout: pipelines.copy.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: depthView },
        { binding: 1, resource: entry.hiz.createView({ baseMipLevel: 0, mipLevelCount: 1 }) },
      ],
    });
    entry.lastDepthView = depthView;

    const encoder = this.gpu.getEncoder();
    const label = `solar light ${level} forward Hi-Z`;
    const pass = encoder.beginComputePass({ label, timestampWrites: this.timestampWrites(label) });
    pass.setPipeline(pipelines.copy);
    pass.setBindGroup(0, entry.copyGroup);
    pass.dispatchWorkgroups(Math.ceil(mapSize / WORKGROUP), Math.ceil(mapSize / WORKGROUP));
    pass.setPipeline(pipelines.reduce);
    for (let mip = 1; mip < entry.levels; mip++) {
      const dimension = mipDimension(mapSize, mip);
      pass.setBindGroup(0, entry.reduceGroups[mip - 1]);
      pass.dispatchWorkgroups(Math.ceil(dimension / WORKGROUP), Math.ceil(dimension / WORKGROUP));
    }
    pass.end();
    this.stats.builds++;
    return entry.hiz;
  }

  viewFor(level, entry, hiz) {
    let view = this.views[level];
    if (!view || view.pyramid !== hiz || view.width !== entry.size) {
      view = {
        key: `solar-light-${level}`,
        width: entry.size,
        height: entry.size,
        pw: entry.size,
        ph: entry.size,
        levels: entry.levels,
                                                                              
                                    
        reversed: false,
        pyramid: hiz,
        kind: 'light-depth',
        lightLevel: level,
        lightRevision: LIGHT_CULL_REVISION,
        demandLevels: LIGHT_DEMAND_LEVELS,
        cameraPolicy: 'cascade orthographic light camera',
        dimensionPolicy: 'shadow map size',
      };
      this.views[level] = view;
    }
    view.frame = this.gpu.frame ?? 0;
    return view;
  }

                                                                            
                                                                               
                                                  
  ensureGlobalEntry(size) {
    const mapSize = Math.max(1, Number(size) | 0);
    let entry = this.globalEntry;
    if (entry && entry.size === mapSize && entry.hiz) return entry;
    entry?.hiz?.destroy?.();
    const pipelines = this.ensurePipelines();
    const levels = mipLevelCount(mapSize);
    const hiz = this.device.createTexture({
      label: 'APS solar global static forward-Z farthest Hi-Z',
      size: [mapSize, mapSize],
      format: LIGHT_HIZ_FORMAT,
      mipLevelCount: levels,
      usage: this.textureUsage,
    });
    const reduceGroups = [];
    for (let mip = 1; mip < levels; mip++) {
      reduceGroups.push(this.device.createBindGroup({
        layout: pipelines.reduce.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: hiz.createView({ baseMipLevel: mip - 1, mipLevelCount: 1 }) },
          { binding: 1, resource: hiz.createView({ baseMipLevel: mip, mipLevelCount: 1 }) },
        ],
      }));
    }
    entry = { size: mapSize, levels, hiz, reduceGroups, copyGroup: null, lastDepthView: null };
    this.globalEntry = entry;
    this.globalViews.fill(null);
    this.stats.levels_built++;
    return entry;
  }

                                                                                 
                                                                               
                                                                   
  recordGlobalHiz(pass, size, depthView) {
    if (this.disposed) throw Error('LightCullCoordinator is disposed');
    if (!pass?.setPipeline) throw Error('recordGlobalHiz requires an open compute pass');
    if (!depthView) throw Error('recordGlobalHiz requires the static snapshot depth view');
    const entry = this.ensureGlobalEntry(size);
    const pipelines = this.ensurePipelines();
                                                                            
                                                    
    if (!entry.copyGroup || entry.lastDepthView !== depthView) {
      entry.copyGroup = this.device.createBindGroup({
        layout: pipelines.copy.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: depthView },
          { binding: 1, resource: entry.hiz.createView({ baseMipLevel: 0, mipLevelCount: 1 }) },
        ],
      });
      entry.lastDepthView = depthView;
    }
    pass.setPipeline(pipelines.copy);
    pass.setBindGroup(0, entry.copyGroup);
    pass.dispatchWorkgroups(Math.ceil(entry.size / WORKGROUP), Math.ceil(entry.size / WORKGROUP));
    pass.setPipeline(pipelines.reduce);
    for (let mip = 1; mip < entry.levels; mip++) {
      const dimension = mipDimension(entry.size, mip);
      pass.setBindGroup(0, entry.reduceGroups[mip - 1]);
      pass.dispatchWorkgroups(Math.ceil(dimension / WORKGROUP), Math.ceil(dimension / WORKGROUP));
    }
    this.stats.global_builds++;
    return entry;
  }

                                                                
                                                                               
                                                                        
  globalViewFor(level, sourceLevel, entry = this.globalEntry) {
    if (!entry) throw Error('globalViewFor requires ensureGlobalEntry/recordGlobalHiz');
    let view = this.globalViews[level];
    if (!view || view.pyramid !== entry.hiz || view.width !== entry.size) {
      view = {
        key: `solar-light-${level}`,
        width: entry.size,
        height: entry.size,
        pw: entry.size,
        ph: entry.size,
        levels: entry.levels,
        reversed: false,
        pyramid: entry.hiz,
        kind: 'light-depth-global',
        lightLevel: level,
        globalSourceLevel: sourceLevel,
        globalHiZ: true,
        lightRevision: LIGHT_CULL_REVISION,
        demandLevels: LIGHT_DEMAND_LEVELS,
        cameraPolicy: 'cascade orthographic light camera; occlusion projected with captured global VP',
        dimensionPolicy: 'single global static snapshot size',
      };
      this.globalViews[level] = view;
    }
    view.frame = this.gpu.frame ?? 0;
    view.globalSourceLevel = sourceLevel;
    return view;
  }

                                                                          
                                                                             
                                                      
  selectShared(systems, view, pass, light, compute) {
    if (this.disposed) throw Error('LightCullCoordinator is disposed');
    if (!compute?.setPipeline) throw Error('selectShared requires the shared compute pass');
    const active = [...systems].filter(system => system && !system.disposed && system.models?.length);
    if (!active.length) return 0;
    for (const system of active) {
      if (typeof system.selectLight !== 'function') throw Error('Vegetation system does not implement selectLight');
      system.selectLight(view, pass, light, compute);
    }
    this.stats.global_selects++;
    this.stats.systems += active.length;
    return active.length;
  }

                                                                         
                                                                            
                                                                             
  finishShared(systems, view, compute) {
    let dispatched = 0;
    for (const system of systems) {
      if (system?.disposed) continue;
      if (typeof system.finishSelectionBatched !== 'function') {
        throw Error('Vegetation system does not implement finishSelectionBatched');
      }
      dispatched += system.finishSelectionBatched(view, 0, compute) | 0;
    }
    return dispatched;
  }

                                                                               
                                                                            
                                                                              
  select(systems, pass, { level, demandBuffer, hiz, depthPad } = {}) {
    if (this.disposed) throw Error('LightCullCoordinator is disposed');
    if (!pass?.frameBlock) throw Error('LightCullCoordinator.select requires the cascade pass.frameBlock');
    if (!Number.isInteger(level) || level < 0 || level >= LIGHT_DEMAND_LEVELS) {
      throw Error(`LightCullCoordinator level must be 0..${LIGHT_DEMAND_LEVELS - 1}`);
    }
    const entry = this.entries[level];
    if (!entry) throw Error(`LightCullCoordinator.build(${level}, ...) must run before select`);
    const target = hiz ?? entry.hiz;
    if (target !== entry.hiz) throw Error('LightCullCoordinator.select hiz must be the texture built for this level');
    if (!demandBuffer || !Number.isFinite(demandBuffer.size) || demandBuffer.size < LIGHT_DEMAND_BYTES) {
      throw Error(`LightCullCoordinator.select requires a GPUBuffer of ${LIGHT_DEMAND_BYTES} bytes`);
    }
    const active = [...systems].filter(system => system && !system.disposed && system.models?.length);
    const view = this.viewFor(level, entry, target);
    for (const system of active) system.views?.set(view.key, view);
    if (!active.length) return view;

    const requestedPad = Number(depthPad ?? this.depthPad);
    if (!Number.isFinite(requestedPad) || requestedPad < 0) throw Error('LightCullCoordinator select depthPad must be finite and nonnegative');
                                                                              
                                                                              
                                   
    const pad = Math.max(requestedPad, (LIGHT_RASTER_BIAS_ULPS + 1) * LIGHT_FLOAT32_ULP);
    const label = `${view.key} vegetation complete-bbox cull`;
    const encoder = this.gpu.getEncoder();
    const compute = encoder.beginComputePass({ label, timestampWrites: this.timestampWrites(label) });
    try {
      for (const system of active) {
        if (typeof system.selectLight !== 'function') throw Error('Vegetation system does not implement selectLight');
        system.selectLight(view, pass, {
          level,
          demandBuffer,
          hiz: target,
          padTexels: this.padTexels,
          depthPad: pad,
          legacyFull: !!pass.legacyLightDemand,
        }, compute);
      }
    } finally {
      compute.end();
    }
                                                                              
                                                       
    for (const system of active) system.finishSelection?.(view, 0);
    this.stats.selects++;
    this.stats.systems += active.length;
    return view;
  }

  getHiz(level) {
    return this.entries[level]?.hiz ?? null;
  }

  getGlobalHiz() {
    return this.globalEntry?.hiz ?? null;
  }

  metadata() {
    const global = this.globalEntry;
    return {
      schema: 'aps-light-cull-coordinator/1',
      revision: LIGHT_CULL_REVISION,
      forward_z: true,
      farthest_aggregation: 'max',
      background: 1,
      demand_bytes: LIGHT_DEMAND_BYTES,
      demand_stride_bytes: LIGHT_DEMAND_STRIDE_BYTES,
      demand_levels: LIGHT_DEMAND_LEVELS,
      depth_pad: this.depthPad,
      pad_texels: this.padTexels,
      occlusion_rule: 'full 8-corner rect + all covered Hi-Z cells (2x2/3x3) + conservative depth pad',
      readback_in_frame_loop: false,
      global_hiz: global ? {
        size: global.size,
        mip_levels: global.levels,
        format: LIGHT_HIZ_FORMAT,
        source: 'largest-coverage cascade static-only snapshot',
        captured_vp_per_level: false,
        selected_cascades: this.globalViews.filter(Boolean).map(view => view.lightLevel),
      } : null,
      statistics: { ...this.stats },
      levels: this.entries.map(entry => entry && ({
        level: entry.level,
        size: entry.size,
        mip_levels: entry.levels,
        format: LIGHT_HIZ_FORMAT,
      })),
    };
  }

                                                                          
                                                                              
  static depthPad(options) {
    return lightDepthPad(options);
  }

                                                                             
                                                                          
  static rasterPad() {
    return (LIGHT_RASTER_BIAS_ULPS + 1) * LIGHT_FLOAT32_ULP;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of this.entries) entry?.hiz?.destroy?.();
    this.globalEntry?.hiz?.destroy?.();
    this.entries.fill(null);
    this.views.fill(null);
    this.globalViews.fill(null);
    this.globalEntry = null;
    this.pipelines = null;
  }
}
