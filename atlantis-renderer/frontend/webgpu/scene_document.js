                                                                                  
import {normalizePostOptions} from './post_options.js';
import {normalizeRendererEnvironment,applyRendererEnvironment} from './renderer_environment.js';
import {loadInterventionInputs,createTerrainIntervention} from './terrain_intervention.js';
import {warmupInterventionStates} from './intervention_warmup.js';
import {availableQuickCameras} from './scene_quick_bar.js';
import {IndoorLPV} from './indoor_lpv.js';
import {IndoorLPVMulti} from './indoor_lpv_multi.js';
import {installBuildingLayers} from './building_layers.js';
import {hasPendingTaskResources} from './task_resource_status.js';

const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const originalRootTransforms=new WeakMap();

                                                                            
                                                                            
export function independentTaskModel(document,asset){
  return asset?.kind==='glb'&&!asset.grass&&!asset.impostor&&!asset.water&&!asset.overlay&&
    /^[0-9a-f]{64}$/.test(document?.gateway?.task_scene_key??'')&&
    /^task_[0-9a-f]{64}$/.test(asset.id??'')&&
    /\/api\/build-assets\/ba_[0-9a-f]{32}\/content\?revision=[0-9a-f]{64}$/.test(asset.url??'');
}

                                                                            
                                                                          
export function applySceneAssetTransform(viewer,asset,root) {
  const pose=asset.transform;
  if((pose===undefined||pose===null)&&(!root||!originalRootTransforms.has(root)))return;
  if((pose===undefined||pose===null)&&root){
    const original=originalRootTransforms.get(root);
    root.position.fromArray(original.position);root.quaternion.fromArray(original.rotation);root.scale.fromArray(original.scale);
    root.matrix.fromArray(original.matrix);root.matrixAutoUpdate=original.auto;root.matrixWorldNeedsUpdate=true;
    root.updateMatrixWorld?.(true);viewer.invalidateObjectTransforms?.([root]);viewer.invalidateVisibility?.();return;
  }
  if(!object(pose)||!root)throw Error(`Asset ${asset.id} transform requires a loaded root`);
  if(asset.kind==='heightfield')throw Error(`Asset ${asset.id} heightfield transform is not supported`);
  const vector=(name,n)=>{
    const value=pose[name];
    if(value===undefined)return null;
    if(!Array.isArray(value)||value.length!==n||!value.every(Number.isFinite))throw Error(`Asset ${asset.id} transform ${name} is invalid`);
    return value;
  };
  const matrix=vector('matrix',16),translation=vector('translation',3),rotation=vector('rotation',4),scale=vector('scale',3);
  if(matrix&&(translation||rotation||scale))throw Error(`Asset ${asset.id} transform must use matrix or TRS`);
  if(!originalRootTransforms.has(root))originalRootTransforms.set(root,{position:root.position.toArray(),rotation:root.quaternion.toArray(),scale:root.scale.toArray(),matrix:root.matrix.toArray(),auto:root.matrixAutoUpdate});
  const original=originalRootTransforms.get(root);
  root.position.fromArray(original.position);root.quaternion.fromArray(original.rotation);root.scale.fromArray(original.scale);
  root.matrix.fromArray(original.matrix);
  if(matrix){root.matrixAutoUpdate=false;root.matrix.fromArray(matrix);root.matrixWorldNeedsUpdate=true;}
  else {
    root.matrixAutoUpdate=true;
    if(translation)root.position.fromArray(translation);
    if(rotation)root.quaternion.fromArray(rotation);
    if(scale)root.scale.fromArray(scale);
  }
  root.updateMatrixWorld?.(true);
  viewer.invalidateObjectTransforms?.([root]);
  viewer.invalidateVisibility?.();
}

                                                                               
                                                                            
                                                                               
                                                  
export function sceneURL(file,base) {
  if(typeof file!=='string'||!file.trim())throw Error('Scene input file must be a nonempty URL');
  const url=new URL(file,base);
  if(!['http:','https:','blob:'].includes(url.protocol)||url.username||url.password)throw Error('Scene inputs require HTTP(S) or a local blob URL without embedded credentials');
  return url.href;
}

function camera(value) {
  if(!object(value))return {fit:true};
  if(value.options!==undefined)normalizePostOptions(value.options);
  if(value.fit===true)return {...value,fit:true};
                                                                                
                                                                               
                                                                              
                                                                        
  const fov=value.fov_degrees??value.fov??36;
  return {...value,fov};
}

export function normalizeSceneDocument(document,base) {
  if(!object(document))throw Error('Scene document must be an object');
  if(!Array.isArray(document.assets)||(!document.assets.length&&document.asset_batch!==true))throw Error('Scene requires at least one compiled asset');
  const warnings=[],ids=new Set();
  const assets=document.assets.map((asset,index)=>{
    if(!object(asset))throw Error('Scene asset must be an object');
    let id=typeof asset.id==='string'&&asset.id?asset.id:`asset_${index+1}`;
    if(ids.has(id)){let suffix=2;while(ids.has(`${id}_${suffix}`))suffix++;id=`${id}_${suffix}`;warnings.push(`Asset id duplicated; using ${id}`);}
    ids.add(id);
    const kind=['glb','heightfield','vegetation'].includes(asset.kind)?asset.kind:'glb';
    if(asset.kind!==undefined&&kind!==asset.kind)warnings.push(`Asset ${id} kind ${asset.kind} treated as glb`);
    if(typeof asset.file!=='string'||!asset.file.trim())throw Error(`Asset ${id} needs a file`);
    let impostor;
    if(asset.impostor!==undefined&&asset.impostor!==null){
      const source=object(asset.impostor)?asset.impostor:{};
      if(typeof source.file==='string'&&source.file.trim())impostor={...source,url:sceneURL(source.file,base)};
      else warnings.push(`Asset ${id} impostor reference has no file; loading as native grass`);
    }
    return {...asset,id,kind,...(impostor?{impostor}:{}),url:sceneURL(asset.file,base)};
  });
  const environment=normalizeRendererEnvironment(document.environment??{});
  if(document.intervention!==undefined&&(typeof document.intervention?.file!=='string'||!document.intervention.file.trim()))throw Error('Intervention manifest reference needs a file');
  if(document.indoor_lpv!==undefined&&(typeof document.indoor_lpv?.file!=='string'||!document.indoor_lpv.file.trim()))throw Error('LPV manifest reference needs a file');
  if(document.indoor_lpv_multi!==undefined&&(typeof document.indoor_lpv_multi?.file!=='string'||!document.indoor_lpv_multi.file.trim()))throw Error('LPV multi manifest reference needs a file');
  const cameras=Object.create(null);
  if(document.cameras!==undefined){
    if(object(document.cameras))for(const [name,pose] of Object.entries(document.cameras))cameras[name]=camera(pose);
    else warnings.push('cameras is not a named pose object; ignored');
  }
  if(document.initial_camera!==undefined&&!Object.hasOwn(cameras,document.initial_camera))warnings.push(`initial_camera ${document.initial_camera} is not declared; using the default camera`);
  return {...document,assets,environment,cameras,camera:camera(document.camera??{fit:true}),warnings};
}

                                                                              
                                                                                
export function sceneAssetsForSave(active) {
  if(!active?.legacy_heightfield&&Array.isArray(active?.document?.assets)){
    return active.document.assets.map(({url,impostor,...asset})=>({
      ...asset,file:url,
      ...(impostor?{impostor:(()=>{const {url:impostorURL,...rest}=impostor;return {...rest,file:impostorURL??rest.file};})()}:{}),
    }));
  }
  return active?.assets?.map(({id,kind,url,sha256,grass,impostor})=>({id,kind,file:url,
    ...(sha256?{sha256}:{}),...(grass!==undefined?{grass}:{}),
    ...(impostor?{impostor:{file:impostor.url,sha256:impostor.sha256,source_sha256:impostor.source_sha256}}:{})}))??
    [{id:'ground',kind:'heightfield',file:active.source},...(active.document.vegetation_lod_assets??[]).map((file,i)=>({id:'vegetation-'+i,kind:'vegetation',file:new URL(file,active.source).href}))];
}

                                                                           
                                                                       
                                                                               
export function quickCameraViews(document) {
  if (!document?.cameras) return [];
  return availableQuickCameras(document).map(({camera}) => ({name: camera, pose: document.cameras[camera]}));
}

export function selectSceneScope(document,scope) {
  if(scope==='built-terrain') {
    const {indoor_lpv,indoor_lpv_multi,...selected}=document;
    return {...selected,title:`${document.title??'场景'} · 山海与全部建筑`,
      assets:(document.assets??[]).filter(asset=>asset.kind==='glb'||asset.kind==='heightfield')};
  }
  if(scope!=='buildings'&&scope!=='roads'&&scope!=='built')return document;
  const assets=(document.assets??[]).filter(asset=>asset.kind==='glb'&&(scope==='built'||(scope==='roads'
    ?['resort-civil-construction','covered-walks'].includes(asset.id)
    :asset.id?.startsWith('building-')&&!asset.id.startsWith('building-support-')&&!asset.id.endsWith('-pool'))));
  const label=scope==='built'?'道路、连廊与全部建筑':scope==='roads'?'仅道路与连廊':'仅建筑';
  if(!assets.length)throw Error(`场景中没有${label}资产`);
  const {intervention,indoor_lpv,indoor_lpv_multi,...selected}=document;
  return {...selected,title:`${document.title??'场景'} · ${label}`,assets};
}

export async function loadSceneDocument(viewer,url,{signal,fetcher=fetch,scope}={}) {
  const tracked=Number.isFinite(viewer.loading);if(tracked)viewer.loading++;
  try{return await loadSceneInputs(viewer,url,{signal,fetcher,scope});}finally{viewer.loadingPreview=false;if(tracked)viewer.loading--;}
}

async function loadSceneInputs(viewer,url,{signal,fetcher,scope}) {
  const absolute=sceneURL(url,globalThis.location?.href??'http://localhost/');
  const response=await fetcher(absolute,{credentials:'include',signal,cache:'no-store'});
  if(!response.ok)throw Error(`Scene description HTTP ${response.status}`);
  const raw=selectSceneScope(await response.json(),scope);
  await viewer.ready;
  const previousWeather=viewer.lighting.weather?{...viewer.lighting.weather}:null;
  const previousShadows=viewer.shadows?.enabled;
  const previousRenderScale=viewer.renderScale??1;
  const restoreRendering=()=>{
    if(viewer.setRenderScale&&(viewer.renderScale??1)!==previousRenderScale){
                                                                                      
      try{viewer.setRenderScale(previousRenderScale);}catch(error){viewer.reportError?.(error);}
    }
  };
  const restoreEnvironment=()=>{
    if(previousWeather){const weather={...previousWeather};for(const key of ['groundHeight','probePosition'])if(viewer.lighting.weather?.[key]!==undefined)weather[key]=viewer.lighting.weather[key];viewer.lighting.setWeather(weather);}
    if(previousShadows!==undefined)viewer.shadows.enabled=previousShadows;
  };
                                                                           
  if(object(raw)&&object(raw.stages)&&object(raw.cameras)) {
    await viewer.loadHeightfield(absolute);
    const warnings=[];
    if(raw.companions?.file){
      const manifestURL=sceneURL(raw.companions.file,absolute);
      const response=await fetcher(manifestURL,{credentials:'include',signal,cache:'no-store'});
      if(!response.ok)throw Error(`Scene companion HTTP ${response.status}: ${manifestURL}`);
      const companions=await response.json();
      for(const asset of companions.assets??[])await viewer.addAsset(sceneURL(asset.file,manifestURL),signal,{deferCompile:true});
      await viewer.compile();
    }
    for(const file of raw.vegetation_lod_assets??[])await viewer.loadVegetation(sceneURL(file,absolute),signal);
    if(viewer.heightfield?.groundcover&&!viewer.heightfield.groundcover.metadata().ready)warnings.push('Groundcover foliage assets missing from scene');
    const name=raw.cameras.outdoor?'outdoor':Object.keys(raw.cameras)[0];
    if(name)viewer.setTerrainCamera(raw.cameras[name],raw);
    restoreEnvironment();
    if(!Object.hasOwn(raw.environment??{},'local_lights'))viewer.lighting?.setLocalLights?.([]);
    try{if(raw.environment)await applyRendererEnvironment(viewer,raw.environment);}catch(error){restoreRendering();throw error;}
    const result={schema:'aps-webgpu-scene-loaded/1',source:absolute,legacy_heightfield:true,title:raw.title??'Terrain scene',document:raw,warnings};
    viewer.clearTaskHeightfields?.();viewer.sceneDocument=result;return result;
  }
  const document=normalizeSceneDocument(raw,absolute);
  const warnings=[...(document.warnings??[])];
                                                                             
                                                                             
  if(document.asset_batch===true)return loadAssetBatchScene(viewer,document,absolute,{signal,warnings,restoreEnvironment,restoreRendering});
                                                                              
                                                                            
  await viewer.ready;
  const primary=document.assets[0];
  viewer.clearSceneAssets?.();
  viewer.terrainIntervention?.dispose();
  viewer.indoorLPV?.dispose();
  const selected=(document.initial_camera&&document.cameras[document.initial_camera])||document.camera;
  const quickViews=quickCameraViews(document);
  if(!selected.fit)viewer.setCamera(selected);
  viewer.options.onLoadProgress?.(`场景资源 1/${document.assets.length} · ${primary.id} · ${primary.kind}`);
  if(primary.kind==='heightfield')await viewer.loadHeightfield(primary.url,{deferOcean:true});else await viewer.load(primary.url,signal,...(primary.kind==='vegetation'||primary.grass?[{...(primary.kind==='vegetation'?{plant:true}:{}),...(primary.grass?{grass:true}:{}),...(primary.impostor?{impostor:primary.impostor}:{})}]:[]));
  applySceneAssetTransform(viewer,primary,viewer.root);
                                                                                
                                                                              
  viewer.registerSceneAsset?.(primary.id,primary.kind==='heightfield'?viewer.heightfield:viewer.meshAsset,{kind:primary.kind,url:primary.url,root:viewer.root,tagRoot:false});
  let intervention=null;
  if(document.intervention){
    if(primary.kind!=='heightfield')throw Error('Terrain intervention needs a heightfield primary asset');
    const inputs=await loadInterventionInputs(document.intervention,absolute,viewer.heightfield.native,{fetcher,signal});
    intervention=await createTerrainIntervention(viewer,inputs);
  }
  for(const [offset,asset] of document.assets.slice(1).entries()) {
    const assetStage=`场景资源 ${offset+2}/${document.assets.length} · ${asset.id} · ${asset.kind}`;
    viewer.options.onLoadProgress?.(assetStage);
    let loaded;
    if(asset.kind==='vegetation')loaded=await viewer.loadVegetation(asset.url,signal,{grass:asset.grass===true,...(asset.impostor?{impostor:asset.impostor}:{}),...(asset.groundcover_file?{groundcoverSourceUrl:sceneURL(asset.groundcover_file,absolute)}:{}),deferCompile:true});else loaded=await viewer.addAsset(asset.url,signal,{deferCompile:true,...(independentTaskModel(document,asset)?{independentModel:true}:{}),...(asset.overlay?{overlay:{...asset.overlay,id:asset.id}}:{})});
    applySceneAssetTransform(viewer,asset,loaded?.root);
    viewer.registerSceneAsset?.(asset.id,loaded,{kind:asset.kind,url:asset.url});
                                                                              
                                                                              
    if(asset.overlay&&viewer.sceneOverlays?.has(asset.id))viewer.sceneOverlays.get(asset.id).kind=asset.overlay.kind;
    if(asset.water)viewer.attachBoundedWater(loaded,asset.water);
                                                                          
                                                                              
                                                                              
    if(intervention&&loaded&&!asset.overlay)intervention.registerAsset(asset.id,loaded);
    viewer.options.onLoadProgress?.(`${assetStage} · 就绪`);
  }
  viewer.options.onLoadProgress?.('场景资源 · 全部就绪');
  if(viewer.heightfield?.groundcover&&!viewer.heightfield.groundcover.metadata().ready)warnings.push('Groundcover foliage assets missing from scene');
  if(selected.fit)viewer.fitScene();else viewer.setCamera(selected);
  restoreEnvironment();
  let warmup=null;
  try{
  await applyRendererEnvironment(viewer,document.environment);
                                                                              
                                                                                   
  if(!Object.hasOwn(document.environment,'local_lights'))viewer.lighting?.setLocalLights?.([]);
  if(document.indoor_lpv){
    viewer.options.onLoadProgress?.('室内 LPV · 加载');
    viewer.sceneDocumentCandidateAssets=document.assets;
    try{const lpv=await IndoorLPV.load(viewer,document.indoor_lpv,absolute,{fetcher,signal});lpv.publish();}finally{delete viewer.sceneDocumentCandidateAssets;}
    viewer.options.onLoadProgress?.('室内 LPV · 已发布');
  }
  if(document.indoor_lpv_multi){
    viewer.options.onLoadProgress?.('室内 LPV · 多建筑加载');
    viewer.sceneDocumentCandidateAssets=document.assets;
    try{const lpv=await IndoorLPVMulti.load(viewer,document.indoor_lpv_multi,absolute,{fetcher,signal});lpv.publish();}finally{delete viewer.sceneDocumentCandidateAssets;}
    viewer.options.onLoadProgress?.('室内 LPV · 已发布');
  }
  if(selected.options)viewer.renderPipeline.setOptions(selected.options);
  installBuildingLayers(viewer,document);
  if(primary.kind==='heightfield'&&viewer.heightfield?.oceanConfig!=null){
    viewer.options.onLoadProgress?.('先显示完整地形与建筑');
    await viewer.compile();viewer.renderFrame?.(0);viewer.loadingPreview=true;
    await viewer.replaceOceanCandidate(viewer.heightfield.oceanConfig,viewer.heightfield,{pausePreviewOnPublish:true});
    viewer.loadingPreview=false;
  }
  viewer.options.onLoadProgress?.('场景编译 · 开始');
  if(intervention)warmup=await warmupInterventionStates(viewer,intervention,{
   initial:intervention.manifest.initial_state??'before',signal,views:quickViews,
   finalView:quickViews.length&&!selected.fit?{name:document.initial_camera??'selected',pose:selected}:null});
  else await viewer.compile();
  if(signal?.aborted||viewer.disposed)throw Error('Scene load cancelled/disposed');
  viewer.options.onLoadProgress?.('场景就绪');
  }catch(error){restoreRendering();throw error;}
  const result={schema:'aps-webgpu-scene-loaded/1',source:absolute,title:document.title??'Scene',document,...(intervention?{intervention:intervention.metadata()}:{}),...(warmup?{warmup}:{}),warnings,assets:document.assets.map(({id,kind,url,sha256,grass,impostor,overlay})=>({id,kind,url,sha256,...(grass!==undefined?{grass}:{}),...(impostor?{impostor}:{}),...(overlay?{overlay}:{})}))};
  if(hasPendingTaskResources(document,raw,absolute))result.task_update_pending=true;
  viewer.clearTaskHeightfields?.();viewer.sceneDocument=result;return result;
}

                                                                              
                                                                             
                                                           
async function loadAssetBatchScene(viewer,document,absolute,{signal,warnings,restoreEnvironment,restoreRendering}={}){
  if(document.assets.some(asset=>asset.kind!=='glb'))throw Error('asset_batch scenes require every asset to be a GLB');
  if(document.intervention!==undefined)throw Error('asset_batch scenes do not support terrain intervention');
  await viewer.ready;
  if(viewer.disposed)throw Error('Viewer has been disposed');
                                                                               
                                                                          
  viewer.clear();
  const failures=[];
  for(const [index,asset] of document.assets.entries()){
    viewer.options.onLoadProgress?.(`批量资产 ${index+1}/${document.assets.length} · ${asset.id}`);
    let loaded;
    try{
      loaded=await viewer.addAsset(asset.url,signal,{deferCompile:true});
      if(!loaded?.root)throw Error('Asset loader returned no root');
      applySceneAssetTransform(viewer,asset,loaded.root);
      viewer.registerSceneAsset?.(asset.id,loaded,{kind:asset.kind,url:asset.url});
    }catch(error){
      if(loaded){viewer.meshCompanions?.delete(loaded);viewer.releaseAux?.(loaded.root);loaded.dispose?.();viewer.invalidateVisibility?.();}
      if(signal?.aborted||viewer.disposed)throw error;
      failures.push({id:asset.id,url:asset.url,error:String(error?.message??error)});
      warnings.push(`资产 ${asset.id} 加载失败并跳过：${String(error?.message??error)}`);
    }
  }
  viewer.assetFailures=failures;
  const selected=(document.initial_camera&&document.cameras[document.initial_camera])||document.camera;
  if(selected.fit)viewer.fitScene();else viewer.setCamera(selected);
  restoreEnvironment?.();
  try{
    await applyRendererEnvironment(viewer,document.environment);
    if(!Object.hasOwn(document.environment,'local_lights'))viewer.lighting?.setLocalLights?.([]);
    if(selected.options)viewer.renderPipeline.setOptions(selected.options);
    installBuildingLayers(viewer,document);
    viewer.options.onLoadProgress?.('批量资产 · 编译');
    await viewer.compile();
  }catch(error){restoreRendering?.();throw error;}
  if(signal?.aborted||viewer.disposed)throw Error('Scene load cancelled/disposed');
  viewer.options.onLoadProgress?.('场景就绪');
  const result={schema:'aps-webgpu-scene-loaded/1',source:absolute,title:document.title??'Scene',document,asset_batch:true,asset_failures:failures,warnings,assets:document.assets.map(({id,kind,url,sha256})=>({id,kind,url,sha256}))};
  viewer.sceneDocument=result;return result;
}
