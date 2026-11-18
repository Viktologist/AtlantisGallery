import {GPU} from '../../vendor/tidewater/src/engine/gpu/GPU.js';
import {Texture} from '../../vendor/tidewater/src/engine/gpu/Texture.js';
import {generateMipmaps} from '../../vendor/tidewater/src/engine/gpu/Mipmaps.js';
import {Group, Mesh} from '../../vendor/tidewater/src/engine/scene/index.js';
import {InstancedBufferGeometry} from '../../vendor/tidewater/src/engine/geometry/BufferGeometry.js';
import {InstancedBufferAttribute} from '../../vendor/tidewater/src/engine/geometry/BufferAttribute.js';
import {createSavedWaterMaterial} from './mesh_adapter.js';
import {LAYERS} from '../../vendor/tidewater/src/engine/render/SceneRenderer.js';
import {selectHeightfieldPatches} from '../src/heightfield_grid.js';
import {createTidewaterShoreField} from '../src/ocean_tidewater_shore_math.js';
import {loadTerrainInputs} from './terrain_inputs.js';
import {terrainPatchGeometry, savedWaterGeometry} from './terrain_geometry.js';
import {createTerrainSampling,setTerrainSamplingFrame} from './terrain_sampling.js';
import {createTerrainMaterial, compileTerrainMaterialLibrary} from './terrain_material.js';
import {terrainBRDFTable} from './terrain_brdf.js';
import {Material} from '../../vendor/tidewater/src/engine/render/Material.js';
import {ShaderModule} from '../../vendor/tidewater/src/engine/gpu/Shader.js';
import {nativeShadowTiles,selectNativeShadowTiles,nativeShadowVertexWGSL} from './terrain_shadow.js';
import {createPointTerrainCaster} from './point_terrain_caster.js';
import {CasterDemandGPU,restoreTerrainPatchAttribute} from './caster_demand_gpu.js';
import {createLandscapeMaterial} from './landscape_pbr.js';
import {createGroundcover} from './groundcover.js';
import {createSurfaceVariation} from './surface_variation.js';
import {createTerrainPBR} from './terrain_pbr.js';
import {createTerrainGrassPBR} from './terrain_grass_pbr.js';
import {loadRockLayerPBR} from './rock_layer_pbr.js';
import {loadTerrainSatMap} from './terrain_satmap_pbr.js';
import {terrainDigest} from './terrain_inputs.js';
import {createLakes} from './lake.js';
import {createInlandWaterOptics} from './inland_water_optics.js';
import {makeSavedWaterBody} from './inland_water_math.js';
import {terrainSurfaceOptions,SURFACE_SHADOW_SUBDIVISIONS,surfaceCasterWGSL,shadowVertexWGSL} from './terrain_surface.js';
import {selectSurfacePatches} from './terrain_surface_lod.js';
import {terrainCoordinates} from './terrain_coordinates.js';
import {worldLakeExclusion} from './lake_exclusion.js';

                                                                              
                                                                                
export async function loadHeightfield(viewer, sceneUrl, {deferCommit=false} = {}) {
  if (viewer.disposed) throw Error('Viewer has been disposed');
  const previousOceanConfig = viewer.ocean?.config;
  const loadId = viewer.loadId = (viewer.loadId ?? 0) + 1;
  const guard = () => { if (viewer.disposed || loadId !== viewer.loadId) throw Error('Stale heightfield load'); };
  await viewer.ready; guard();
  if (!GPU.device) throw Error('Initialize the reference GPU singleton before terrain');
  viewer.options?.onLoadProgress?.('terrain inputs');
  const input = await loadTerrainInputs(sceneUrl, {limit: GPU.limits?.maxTextureDimension2D ?? GPU.device.limits.maxTextureDimension2D, guard});
  viewer.options?.onLoadProgress?.('terrain materials and textures');
                                                                             
  compileTerrainMaterialLibrary(input.library);
  const {sceneData, stage, native, fields, fieldShape, profile, library} = input;
  const surface=terrainSurfaceOptions(sceneData.surface_reconstruction),curved=surface.mode==='cubic';
  let surfaceStats=null;
  const textures = [], geometries = [], materials = [];
  let root, api, landscape, groundcover, variation, grassPBR, rockLayers, satMap, lakes, inlandOptics, released = false;
  let casterDemandGPU = null;
  function texture(options) { const t = new Texture(options); textures.push(t); return t; }
  function release() {
    if (released) return; released = true; root?.removeFromParent();
    landscape?.dispose?.();
    groundcover?.dispose();
    variation?.dispose();
    lakes?.dispose();
    inlandOptics?.dispose();
    casterDemandGPU?.dispose(); casterDemandGPU = null;
    if (viewer.heightfield === api) viewer.heightfield = null;
    if (viewer.root === root) viewer.root = null;
    root?.traverse(o=>{if(o.isMesh)o.dispose();});
    for (const g of geometries) g.dispose(); for (const m of materials) m.dispose();
    for (const t of textures) t.destroy();
    sampling?.params.buffer?.destroy(); terrainMaterial?.material.uniformBlock.buffer?.destroy();
    for (const m of materials) if (m !== terrainMaterial?.material) m.uniformBlock.buffer?.destroy();
  }
  let sampling, terrainMaterial;
  try {
    const height = texture({label: 'live native DEM / optional GPU composition', width: native.shape[1], height: native.shape[0], format: 'r32float', usage:['sample','copyDst','copySrc','storage'], data: native.data});
    let shore = texture({label: 'unbound native shore driver', width: 1, height: 1, format: 'rgba32float', data: new Float32Array(4)});
    sampling = createTerrainSampling(sceneData, profile, height, shore,surface);
    const names = ['terrainHistory', 'terrainState', 'terrainContextField', 'terrainFlow', 'terrainEcology'], maps = {};
    const emptyField = new Uint8Array(fieldShape[0] * fieldShape[1] * 4);
    for (let i = 0; i < names.length; i++) maps[names[i]] = texture({label: names[i], width: fieldShape[1], height: fieldShape[0],
      format: 'rgba8unorm', mips: true, data: input.fieldBytes[i] ?? emptyField});
    maps.terrainCoastal = maps.terrainContextField;
    if (input.coastalBytes) {
      const [nz, nx] = input.coastalShape;
      maps.terrainCoastal = texture({label: 'authored coastal sediment', width: nx, height: nz, format: 'rgba8unorm', mips: true, data: input.coastalBytes});
      sampling.params.set('coastalEnabled', 1);
    }
    const brdf = terrainBRDFTable();
    const dfg = texture({label: 'preintegrated terrain DFG / Disney sheen', width: brdf.size, height: brdf.size, format: 'rgba32float', data: brdf.data});
    landscape = input.landscape?await createLandscapeMaterial(input.landscape, texture, sampling.module):createTerrainPBR(input.defaultPBR,texture,sampling.module);
    groundcover = createGroundcover(input.groundcover,texture,viewer,sampling.module);
    grassPBR = createTerrainGrassPBR(input.defaultGrassPBR,input.grassCells,texture,sampling.module);
    variation = createSurfaceVariation(input.variation,texture);
    if(sceneData.surface.rock_pbr_layers){
      rockLayers=await loadRockLayerPBR(sceneData.surface.rock_pbr_layers,sceneUrl,{Texture,digest:terrainDigest});textures.push(rockLayers.texture);rockLayers.texture.apsPrefilteredLandscape=true;guard();
    }
    if(sceneData.surface.satmap_pbr){
      satMap=await loadTerrainSatMap(sceneData.surface.satmap_pbr,sceneUrl,sceneData,{Texture,digest:terrainDigest});textures.push(satMap.texture);guard();
    }
    guard();
    terrainMaterial = createTerrainMaterial({library, terrainModule: sampling.module, fields: maps, dfg, landscape, groundcover, variation, grassPBR, rockLayers, satMap, rockSurface:sceneData.surface.procedural_rock_surface??null,surfaceReconstruction:surface});
    materials.push(terrainMaterial.material);
    const shadowCapacity = Math.ceil((native.shape[1] - 1) / 64) * Math.ceil((native.shape[0] - 1) / 64);
    const capacity=curved?Math.max(16384,shadowCapacity):shadowCapacity;
    const geometry = terrainPatchGeometry(capacity,{skirts:!curved,seams:curved}); geometries.push(geometry);
    const mesh = new Mesh(geometry, terrainMaterial.material);
    mesh.name = 'Native DEM / preserved LOD'; mesh.frustumCulled = false; mesh.castShadow = false; mesh.receiveShadow = true; mesh.staticVelocity = true;mesh.userData.apsTerrainOccluder=true;
    root = new Group(); root.name = 'Preserved metric heightfield'; root.position.set(native.origin[0], 0, native.origin[1]); root.add(mesh);
    function coordinates(){root.updateWorldMatrix(true,false);return terrainCoordinates(root.matrixWorld,native.origin);}
    const shadowTiles=nativeShadowTiles(native);
    let shadowBoundsRevision=0,planarReflectionMesh=null;
    function ensureCasterDemand(){
      if(!casterDemandGPU){
        const renderer=viewer.meshRenderer;
        if(!renderer)throw Error('Demand-driven terrain casters require viewer.meshRenderer');
        casterDemandGPU=new CasterDemandGPU({renderer,label:'terrain caster demand'});
      }
      return casterDemandGPU;
    }
    const casterModule=new ShaderModule({name:'aps-native-DEM-caster',uniforms:sampling.params,uniformName:'terrainParams',
      bindings:{terrainHeight:{texture:height,sampleType:'unfilterable-float'}},code:curved?surfaceCasterWGSL():''});
    const casterMaterial=new Material({name:'Native DEM / independent solar cells',lit:false,modules:[casterModule],attributes:{apsPatch:'vec4f'},vertex:curved?shadowVertexWGSL.replaceAll('apsSurface','apsCasterSurface'):nativeShadowVertexWGSL});
    materials.push(casterMaterial);
                                                                                 
                                                                                
    const shadowCasters=Array.from({length:4},(_,i)=>{
      const g=terrainPatchGeometry(shadowCapacity,{skirts:false,segments:curved?64*SURFACE_SHADOW_SUBDIVISIONS[i]:64});geometries.push(g);
      const object=new Mesh(g,casterMaterial);object.name='Native DEM solar level '+i;object.visible=false;object.castShadow=true;
      object.frustumCulled=false;object.staticVelocity=true;object.userData.apsShadowOnly=true;root.add(object);
      return {mesh:object,geometry:g,key:null,patches:0,demandIndirect:false,cpuRows:null};
    });
                                                                              
                                                                                
                                                                            
    function restoreCasterDemand(caster){
      const attribute=caster.geometry.attributes.apsPatch;
      const demandOwned=!!caster.demandIndirect||!!attribute?.gpuBuffer||caster.geometry.indirect?.apsCasterDemand===true;
      if(demandOwned)restoreTerrainPatchAttribute(caster.geometry,{rows:caster.cpuRows,count:caster.patches});
      caster.demandIndirect=false;
      caster.geometry.instanceCount=caster.patches;caster.mesh.count=caster.patches;
    }
                                                                               
                                                                             
                                                                                
                                                            
    function beginShadowCascade(i,cascade,options={}){
      const caster=shadowCasters[i];if(!caster)throw Error('Unsupported native shadow level');
      const frame=coordinates(), clipKey=`${cascade.clipKey}:${frame.worldFromNative.elements.join(',')}`;
      if(caster.key!==clipKey){
        const rows=selectNativeShadowTiles(shadowTiles,frame.nativeClip(cascade.viewProj),4/viewer.shadows.size);
        rows.forEach((row,j)=>caster.geometry.attributes.apsPatch.array.set(row,j*4));
        caster.geometry.attributes.apsPatch.needsUpdate=true;caster.geometry.instanceCount=rows.length;caster.mesh.count=rows.length;
        caster.key=clipKey;caster.patches=rows.length;caster.cpuRows=rows;
      }
                                                                                
                                                                              
                                                                               
                                                                               
                                                    
      function legacy(){
        restoreCasterDemand(caster);
      }
      const demandBuffer=options?.demandBuffer??null;
      if(!demandBuffer){
        legacy();caster.demandError=null;
      }else{
        try{
          const helper=options?.helper??ensureCasterDemand();
          const result=helper.applyTerrain({
            level:i,cascade,demandBuffer,
            geometry:caster.geometry,renderer:viewer.meshRenderer,
            native,tiles:shadowTiles,curved,interventionBound,worldFromNative:frame.worldFromNative,
            revision:`${shadowBoundsRevision}:${interventionBound}:${curved?1:0}`,
            capacity:caster.geometry.attributes.apsPatch.count,cpuRows:caster.patches,
            uvMode:options.demandUvMode,padTexels:options.demandPadTexels,padUv:options.demandPadUv,
            depthPad:options.demandDepthPad,shadowSize:viewer.shadows?.size,
          });
          if(result?.applied){
            caster.demandIndirect=true;caster.demandError=null;
                                                                                 
                                                                             
                                                                      
            caster.geometry.instanceCount=Math.max(1,caster.patches);caster.mesh.count=caster.geometry.instanceCount;
          }else{
            legacy();caster.demandError=result??null;
          }
        }catch(error){
          legacy();caster.demandError={message:String(error?.message??error)};
        }
      }
      caster.mesh.visible=true;
      return ()=>{caster.mesh.visible=false;};
    }
    const water = input.water.map(w => {
      const g = savedWaterGeometry(w.points, w.indices); geometries.push(g);
      const m = createSavedWaterMaterial(w.row); materials.push(m);
      const object = new Mesh(g, m); object.name = w.row.file; object.userData.waterKind = w.kind; object.userData.sha256 = w.row.sha256;
      object.layers.set(LAYERS.TRANSPARENT); object.receiveShadow = true; root.add(object); return object;
    });
    viewer.options?.onLoadProgress?.('native lake basins and finite-fetch spectra');
    inlandOptics=createInlandWaterOptics(viewer,native,sceneData.inland_water_optics??{});
    lakes=createLakes(native,sceneData.lakes??{},{savedWater:input.water,lakeMask:input.lakeMask,optics:inlandOptics,terrainSampling:sampling.module});
    if(input.lakeMask!==undefined)for(const object of water)if(object.userData.waterKind==='lake'){object.visible=false;object.userData.apsSupersededByInlandMask=true;}
                                                                              
                                                                          
                                                                      
    for(let i=0;i<input.water.length;i++)if(water[i].visible&&['lake','river'].includes(input.water[i].kind)){
      const saved=input.water[i],object=water[i];
      const body=makeSavedWaterBody({kind:saved.kind,id:saved.row.file,points:saved.points,indices:saved.indices,origin:native.origin,flow:saved.flow});
      const index=inlandOptics.addBody(body);inlandOptics.attachMaterial(object.material,index,{kind:saved.kind});
      object.material.isWaterMaterial=true;object.userData.inland_body_index=index;
    }
    const lakeGrassCells=lakes.excludeGrass?.(input.grassCells)??input.grassCells;
    for(const object of lakes.objects){root.add(object);water.push(object);}
    let key = '', patches = [], ocean = null, shoreMetadata = null, receiverEnabled = false, interventionBound=0;
    function update(camera = viewer.camera) {
      if (released) return;
      const frame = coordinates();
      setTerrainSamplingFrame(sampling,frame);
      inlandOptics?.setCoordinateFrame(frame);
      lakes?.update(viewer.time??0);
      inlandOptics?.update(viewer.time??0);
      landscape?.update?.(viewer.frame);
      groundcover?.update(camera,frame);
      const eye = frame.meshPoint(camera.position.toArray());
      const screenHeight = viewer.sceneRenderer?.height ?? viewer.canvas?.height ?? 800;
      const nextKey = [...eye.map(v => Math.round(v * (curved?20:2))), camera.fov, screenHeight, frame.projectionScaleBound].join(',');
      if (key === nextKey) return; key = nextKey;
      const focal=screenHeight*frame.projectionScaleBound/(2*Math.tan(camera.fov*Math.PI/360));
      if(curved){const result=selectSurfacePatches(native.shape,native.spacing,eye,[stage.min_m-interventionBound,stage.peak_m+interventionBound],focal,surface);patches=result.patches;surfaceStats=result.metadata;
        if(patches.length>capacity)throw Error('Surface LOD instance capacity exceeded');
        const seam=geometry.attributes.apsSeam;result.seams.forEach((row,i)=>seam.array.set(row,i*4));seam.needsUpdate=true;
      }else patches = selectHeightfieldPatches(native.shape, native.spacing, eye, [stage.min_m-interventionBound, stage.peak_m+interventionBound], focal);
      if (patches.length > capacity) throw Error('LOD instance capacity exceeded');
      const attr = geometry.attributes.apsPatch;
      patches.forEach((row, i) => attr.array.set(row, i * 4)); attr.needsUpdate = true;
      geometry.instanceCount = patches.length; mesh.count = patches.length;
    }
    function setShoreField(field) {
      if (released) throw Error('Terrain disposed');
      if (!field) { sampling.params.set('shoreEnabled', 0); shoreMetadata = null; return; }
      if (!Number.isInteger(field.size) || field.size < 1 || field.size > (GPU.limits?.maxTextureDimension2D ?? 8192) ||
        !(field.data instanceof Float32Array) || field.data.length !== field.size ** 2 * 4) throw Error('Native shore driver GPU layout mismatch');
      const next = texture({label: 'native DEM travel/refraction driver', width: field.size, height: field.size, format: 'rgba32float', data: field.data});
      next.getGPU(); const old = shore; shore = next; sampling.module.bindings.terrainShore.texture = next;
      sampling.params.set('shoreEnabled', 1); terrainMaterial.material.needsUpdate = true;
      shoreMetadata = {...field.stats, height_sha256: native.sha256, size: field.size};
                                                                      
      GPU.onSubmit(null, () => old.destroy());
    }
    function setOcean(next) {
      if (released) throw Error('Terrain disposed');
      const oceanReceiver = next?.terrainWetnessModule ?? next?.wetnessModule ?? next?.shore?.wetnessModule;
                                                                         
                                                                                
                                                             
      const receiver = oceanReceiver && inlandOptics ? inlandOptics.composeReceiver(oceanReceiver) : (oceanReceiver ?? inlandOptics?.receiverSurfaceModule ?? null);
      terrainMaterial.setReceiver(receiver); ocean = next ?? null; receiverEnabled = !!receiver;
      const sea = next?.config?.seaLevel ?? next?.config?.sealevel;
      if (Number.isFinite(sea)) sampling.params.set('seaLevel', sea);
      if (next?.shore?.field) setShoreField(next.shore.field);
      for (const w of water) if (w.userData.waterKind === 'ocean') w.visible = !ocean;
      if (!ocean) setShoreField(null);
    }
    api = {sceneData, scene: sceneData, profile, native, heightTexture:height,terrainModule: sampling.module, module: sampling.module,
                                                                           
                                                                           
      prepareCasterDemand(){return ensureCasterDemand().ready();},
      casterDemand(){return casterDemandGPU?.metadata()??null;},
                                                                            
                                                                           
                                                                           
      releaseCasterDemand(){for(const caster of shadowCasters)restoreCasterDemand(caster);},
      setInterventionBounds(value){
        if(!Number.isFinite(value)||value<0)throw Error('Invalid intervention displacement bound');
        const extra=Math.max(0,value-interventionBound);if(!extra)return;
        for(const tile of shadowTiles){tile.min[1]-=extra;tile.max[1]+=extra;}
        interventionBound=Math.max(value,interventionBound);key='';shadowBoundsRevision++;
        for(const caster of shadowCasters)caster.key=null;
      },
                                                                                 
                                                                                  
                                                                                
                                                                         
                                                                                
                                      
      invalidateIntervention(){},
      oceanConfig: Object.hasOwn(sceneData, 'ocean') ? sceneData.ocean : previousOceanConfig,
                                                                              
                                                                            
      pointShadowBounds(){return coordinates().worldBounds({min:[native.origin[0],Math.min(...shadowTiles.map(t=>t.min[1])),native.origin[1]],max:[native.origin[0]+(native.shape[1]-1)*native.spacing[0],Math.max(...shadowTiles.map(t=>t.max[1])),native.origin[1]+(native.shape[0]-1)*native.spacing[1]]});},
      pointShadowRevision(){return shadowBoundsRevision;},
      beginPlanarReflection(camera){
        if(!planarReflectionMesh){
          const g=new InstancedBufferGeometry();g.setAttribute('position',geometry.attributes.position);g.setIndex(geometry.index);
          for(const name of ['apsPatch','apsSeam'])if(geometry.attributes[name])g.setAttribute(name,new InstancedBufferAttribute(new Float32Array(geometry.attributes[name].array.length),4));
          g.userData.apsPlanarTerrainGrid=geometry;g.userData.apsStaticIndexOwner=geometry;geometries.push(g);planarReflectionMesh=new Mesh(g,mesh.material);planarReflectionMesh.frustumCulled=false;planarReflectionMesh.matrixAutoUpdate=false;
        }
        const saved={key,patches,surfaceStats,count:geometry.instanceCount,rows:{}};
        for(const name of ['apsPatch','apsSeam'])if(geometry.attributes[name])saved.rows[name]=geometry.attributes[name].array.slice();
        const restore=()=>{key=saved.key;patches=saved.patches;surfaceStats=saved.surfaceStats;for(const [name,rows]of Object.entries(saved.rows)){geometry.attributes[name].array.set(rows);geometry.attributes[name].needsUpdate=true;}geometry.instanceCount=saved.count;mesh.count=saved.count;groundcover?.update(viewer.camera,coordinates());};
        try{update(camera);for(const name of Object.keys(saved.rows)){const a=planarReflectionMesh.geometry.attributes[name];a.array.set(geometry.attributes[name].array);a.needsUpdate=true;}planarReflectionMesh.geometry.instanceCount=geometry.instanceCount;mesh.updateWorldMatrix(true,false);planarReflectionMesh.matrixWorld.copy(mesh.matrixWorld);return {mesh:planarReflectionMesh,restore};}catch(error){restore();throw error;}
      },
      createPointShadowCaster(viewProj){
        const frame=coordinates();return createPointTerrainCaster({tiles:shadowTiles,viewProj:frame.nativeClip(viewProj),material:casterMaterial,matrixWorld:root.matrixWorld,grid:shadowCasters[0].geometry});
      },
      root, mesh, water, groundcover, variation, grassCells:lakeGrassCells, isLakeSubmerged:worldLakeExclusion(root,native.origin,lakes.submerged), inlandLakeModule:lakes.maskModule, inlandOptics, uniforms: sampling.params.fields, textures: maps, update, setOcean, setShoreField, beginShadowCascade,
      configureShore({seaLevel = sampling.params.fields.seaLevel.value, size = 512, hs = 1, direction = [1, 0]} = {}) {
        if (released) throw Error('Terrain disposed');
        const field = createTidewaterShoreField(native, seaLevel, size, {hs, direction});
        sampling.params.set('seaLevel', seaLevel); setShoreField(field); return field;
      },
      setMaterialOptions({detail, influence, vegetation, mode} = {}) {
        for (const [k, v] of Object.entries({detail, influence, vegetation, mode})) if (v !== undefined) {
          if (!Number.isFinite(v) || k === 'mode' && ![0, 14, 15, 17, 19, 23, 24, 25, 35,36,37].includes(v)) throw Error('Unsupported terrain diagnostic/option');
          sampling.params.set(k, v);
        }
      },
      setView(name) {
        const preset = sceneData.cameras[name]; if (!preset) throw Error('Unknown saved camera');
        viewer.setTerrainCamera(preset,sceneData);viewer.currentView=name;update();
      },
      metadata() { return {renderer: 'native WebGPU / WGSL', height_sha256: native.sha256, shape: [...native.shape], spacing_xz_m: [...native.spacing], origin_xz_m: [...native.origin],
        surface_reconstruction:{...surface,...surfaceStats,shadow_subdivisions:curved?[...SURFACE_SHADOW_SUBDIVISIONS]:[1,1,1,1],shadow_receiver:curved?'rasterized surface with analytic curve normal':'native triangle surface',native_physics_unchanged:true,original_cpu_dem_unchanged:true,active_gpu_dem:viewer.terrainIntervention?.enabled?'authored mask composition':'original'},
        patches: geometry.instanceCount, min_grid_step: patches.length ? Math.min(...patches.map(r => r[2] / 64)) : null,
        max_grid_step: patches.length ? Math.max(...patches.map(r => r[2] / 64)) : null,
        display_skirts:curved?'none; 2:1 balanced edge constraints':'accepted coarse seam cover; excluded from solar depth by Material.shadow', source_samples_preserved: true,
        solar_casters:{method:curved?'independent constrained surface; fixed per-clipmap subdivision':'independent native integer DEM triangles, no display LOD or skirts',grid_step:curved?null:1,grid_steps:curved?SURFACE_SHADOW_SUBDIVISIONS.map(n=>1/n):[1,1,1,1],source_cells:(native.shape[0]-1)*(native.shape[1]-1),patches_per_level:shadowCasters.map(c=>c.patches),separate_layer_buffers:true},
        caster_demand: casterDemandGPU?.metadata?.()??null,
        fields_sha256: sceneData.surface.fields_sha256, field_textures: fields.textures.map(r => ({file: r.file, sha256: r.sha256})),
        coastal_surface: fields.coastal_surface ?? null, profile_sha256: sceneData.surface.profile_sha256, material_library_sha256: sceneData.surface.material_library_sha256,
        water_vertices: water.map(w => w.geometry.attributes.position.count), water_indices: water.map(w => w.geometry.index?.count ?? null),
        water: water.map(w => ({file: w.name, kind: w.userData.waterKind, sha256: w.userData.sha256, visible: w.visible,
          inland_body_index:w.userData.inland_body_index??null, atlas_layer:w.userData.inland_atlas_layer??null,
          flow:input.water.find(r=>r.row.file===w.name)?.flow??null})),
        lakes:lakes?.metadata(),
        inland_water_optics:inlandOptics?.metadata()??null,
        shore_driver: shoreMetadata, receiver_wetness: receiverEnabled,
        shader_validation: {preflight:'removed; normal render pipeline compilation remains authoritative'},
        landscape_pbr: landscape?.metadata?.() ?? null,
        grass_cells: input.grassCells?.manifest ?? null,
        lake_grass_exclusion:lakeGrassCells?.lake_exclusion??null,
        grass_pbr: grassPBR?.metadata() ?? null,
        groundcover: groundcover?.metadata() ?? null,
        surface_variation: variation?.metadata() ?? null,
        rock_pbr_layers:rockLayers?{manifest:rockLayers.manifest,options:rockLayers.options}:null,
        satmap_pbr:satMap?.manifest??null,
        material_channels: ['baseColor', 'normal', 'roughness', 'occlusion', 'metallic', 'specular', 'specularTint', 'anisotropy', 'subsurface', 'sheen', 'sheenTint', 'clearcoat', 'clearcoatGloss'],
        brdf: {method: 'preintegrated Smith GGX / Disney cosine sheen', size: brdf.size, samples: 256},
        algorithm_usage: {dem: 'decoded original float32 NPY / native integer texel fetch; SHA descriptive only', lod:curved?'screen-spacing balanced quadtree, sub-cell constrained Hermite, stitched edges; independent solar clipmaps':'existing selectHeightfieldPatches for display only; independent native DEM solar caster tiles',
          substrate: 'decoded generated GLSL -> restricted WGSL compiler, five UNORM fields + saved coastal sediment',
          normals:curved?'analytic constrained surface derivatives + original filtered complete blended relief derivative':'native metric finite differences + original filtered complete blended relief derivative',
          transport: 'existing Disney 2012 reflection + native SceneLighting / CSM / environment hooks'}, checks:{native_input_bytes:'decoded and used; SHA is descriptive only',shader_modules:'normal render pipeline compilation only',rendered_images:'not_checked_by_loader'}}; }, dispose: release};
                                                                              
                                                                           
    const encoder = GPU.device.createCommandEncoder({label: 'terrain input mipmaps'});
    for (const t of textures) { t.getGPU(); if (t.mipLevelCount > 1 && !t.apsPrefilteredLandscape) generateMipmaps(t, encoder); }
    GPU.queue.submit([encoder.finish()]); guard();
    viewer.options?.onLoadProgress?.('terrain patches');update();
    viewer.options?.onLoadProgress?.('terrain ready; ocean binding');
    if(deferCommit)return api;
    inlandOptics.install();
    const previous = viewer.heightfield;
    viewer.releaseAux?.(viewer.meshAsset?.root);viewer.meshAsset?.dispose();viewer.meshAsset=null;viewer.invalidateScene?.();
                                                                            
                                                                       
    if (viewer.ocean) viewer.clearOcean?.();
    viewer.scene.add(root); viewer.heightfield = api;viewer.root=root;
                                                                              
    previous?.dispose();
    return api;
  } catch (error) { release(); throw error; }
}
