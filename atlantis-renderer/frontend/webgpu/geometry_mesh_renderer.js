import {MeshRenderer,Material,GPU,FrameUniforms} from '../../vendor/tidewater/src/engine/webgpu.js';
import {BufferGeometry,BufferAttribute} from '../../vendor/tidewater/src/engine/index.js';
import {prepareVegetationView,disposeVegetationViews} from './vegetation_visibility.js';
import {auditVegetationMaterialResources} from './vegetation_material.js';
import {StaticDrawGPU} from './static_draw_gpu.js';
import {StaticMaterialBatch} from './static_material_batch.js';
import {StaticBSPGPU} from './static_bsp_gpu.js';
import {staticDrawEligibility} from './static_draw_gpu_plan.js';
import {overlayAllowedInPass} from './scene_overlays.js';
import {receiverXYZFilter,receiverXYZItemEligible} from './receiver_xyz_pipeline.js';

                                                                                
                                                                             
                                                                              
                                           
export class GeometryMeshRenderer extends MeshRenderer {
  _pipeline(material,vl,pass){
    try{return super._pipeline(material,vl,pass);}catch(error){
      if(this.precompiling)this.pipelinePreparationErrors.set(material.id+':'+material.version+':'+pass.kind+':'+vl.key,{material:material.name,pass:pass.kind,message:String(error?.message??error)});
      throw error;
    }
  }
  validateMaterialResources(material,vl,pass,source=null){
    if(material.userData?.apsFacesetCount||globalThis.__APS_RESOURCE_DEBUG){
      const overflow=auditVegetationMaterialResources(material,vl.layout,pass,GPU.limits,source);
      if(globalThis.__APS_RESOURCE_DEBUG)globalThis.__APS_CURRENT_RESOURCE_AUDIT={material:material.name,pass:pass.kind,...overflow};
      if(overflow.failed)throw Error('Vegetation final shader resource overflow: '+material.name+' '+JSON.stringify(overflow));
    }
  }
  _createPipeline(material,vl,pass,key){
    this.validateMaterialResources(material,vl,pass);
    return super._createPipeline(material,vl,pass,key);
  }
  _geometryGPU(geometry){return super._geometryGPU(geometry.userData?.apsVegetationBufferOwner??geometry);}
  _attributeBuffer(geometry,attr){
    const grid=geometry?.userData?.apsPointTerrainGrid??geometry?.userData?.apsPlanarTerrainGrid;
    if(grid&&attr===grid.attributes.position)return super._attributeBuffer(grid,attr);
                                                                                  
                                                                                
                                                                              
                                                                                 
    return super._attributeBuffer(geometry?.userData?.apsStaticVertexOwner??geometry,attr);
  }
  _indexBuffer(geometry){
    if(geometry?.userData?.apsStaticCompactedIndex)return {buffer:geometry.userData.apsStaticCompactedIndex.getGPU(),format:'uint32'};
                                                                              
                                                                           
                                                  
    return super._indexBuffer(geometry?.userData?.apsStaticIndexOwner??geometry);
  }
  constructor(){super();this.grassDepthPrepass=false;this.vegetationSystems=new Set();this.nativeCasterBounds=new Map();this.geometryDepthMaterials=new Map();this.depthPolicy={geometry_only_items:0,coverage_or_deformation_items:0};
                                                                                  
                                                                                 
                                                                               
                                                                              
    this.staticVisibility=null;this.visibilityFrame=null;this.visibilityProxies=new Map();this.visibilityProxyCount=0;
                                                                        
                                                                        
    this.staticDraw=null;this.staticVisibilityDiagnostics=false;this.staticDrawEnabled=true;this.requirePreparedDrawResources=true;this.materialBatch=new StaticMaterialBatch(this,{requirePrepared:true});this.resourceLedger=new WeakMap();this.resourceRoots=new Map();this.pipelinePreparationErrors=new Map();}
  prepareImportedRoot(root,{cameras=[]}={}){
    if(!root)return null;this.materialBatch.prepareRoot(root);
    if(GPU.device){this.staticDraw??=new StaticDrawGPU(this);this.staticDraw.enabled=this.staticDrawEnabled;this.staticDraw.prepareScene(root,cameras);this.staticBSP??=new StaticBSPGPU(this);this.staticBSP.prepare(root,cameras);}
    const report={schema:'aps-import-draw-resources/1',revision:'static-material-import-r2',objects:0,accounted_objects:0,unaccounted_objects:0,routes:{},fallback_reasons:{}};
    root.traverse(object=>{
      if(!object.isMesh)return;report.objects++;let route,reason=null;
      if(this.staticDraw?.preparationErrors?.has(object))throw Error('Imported GPU resource preparation failed: '+object.name+' '+this.staticDraw.preparationErrors.get(object));
      const geometry=object.geometry,material=object.material;
      if(!geometry||!material)throw Error('Imported Mesh is missing required draw resources: '+object.name);
      else if(object.userData?.apsVegetationSource){route='retained_source_readback';}
      else if(object.userData?.apsVegetationManaged||object.userData?.apsGrassGenerated){route='vegetation_gpu';}
      else if(Array.isArray(material)){route='explicit_fallback';reason='multi_material_groups';}
      else if(this.materialBatch.records.get(object)?.batch){route='material_batch';}
      else if(this.staticBSP?.entries.has(object)){route='gpu_bsp';}
      else{
        const planned=staticDrawEligibility({object,geometry,material}),entry=this.staticDraw?.entries.get(object);
        if(planned.mode!=='fallback'&&entry&&cameras.every(camera=>entry.views.has(this.staticDraw.viewStates.get(camera)?.slot)))route=planned.mode==='instances'?'gpu_instances':'gpu_compacted_indices';
        else if(GPU.device&&planned.mode!=='fallback'){
          if(cameras.some(camera=>!this.staticDraw.viewStates.has(camera))){route='explicit_fallback';reason='view_limit';}
          else throw Error('Required imported GPU draw resources were not prepared: '+object.name+' '+(this.staticDraw.lastError?.message??planned.mode));
        }else{route='explicit_fallback';reason=this.materialBatch.records.has(object)?'singleton_family':this.materialBatch.eligibility({object,geometry,material,start:geometry.drawRange?.start??0,count:geometry.drawRange?.count??Infinity,renderOrder:object.renderOrder??0})??planned.reason??'gpu_resource_unavailable';}
      }
      if(!route||route==='explicit_fallback'&&!reason)throw Error('Unaccounted imported draw resource: '+object.name);
      this.resourceLedger.set(object,{route,reason,geometry,material});report.routes[route]=(report.routes[route]??0)+1;if(reason)report.fallback_reasons[reason]=(report.fallback_reasons[reason]??0)+1;report.accounted_objects++;
    });
    if(report.objects!==report.accounted_objects)throw Error('Imported draw-resource ledger does not reconcile');
    root.userData.apsDrawResources=report;this.resourceRoots.set(root,report);this.lastResourcePreparation=report;return report;
  }
  forgetImportedRoot(root){this.staticBSP?.forgetRoot(root);this.staticDraw?.forgetRoot(root);this.materialBatch.forgetRoot(root);this.resourceRoots.delete(root);root.traverse(object=>this.resourceLedger.delete(object));}
  prepareStaticDraw(scene=null,cameras=[]){if(!GPU.device)return null;this.staticDraw??=new StaticDrawGPU(this);this.staticDraw.enabled=this.staticDrawEnabled;const prepared=this.staticDraw.prepare();this.prepareImportedRoot(scene,{cameras});return prepared;}
  setStaticDrawEnabled(enabled){this.staticDrawEnabled=!!enabled;this.staticDraw?.setEnabled(this.staticDrawEnabled);return this.staticDrawEnabled;}
  render(scene,pass){
    if(GPU.device&&this.staticDrawEnabled&&!pass.apsPlanarReflection&&!pass.apsStaticStage&&!pass.late&&pass.kind==='main'&&pass.colorViews?.length&&pass.depthView&&pass.camera&&FrameUniforms.fields.reversedDepth.value!==0){
      this.staticBSP??=new StaticBSPGPU(this);
      return this.staticBSP.renderStages(scene,pass,part=>this.render(scene,part));
    }
    this.actualDraws??={indexed_calls:0,instanced_indexed_calls:0,nonindexed_calls:0,instances:0,max_instance_count:0,indirect_calls:0};
    if(!pass.apsStaticStage||pass.apsStaticStage==='remaining'||pass.apsStaticStage==='fallback'){
      const selection=prepareVegetationView(this.vegetationSystems,scene,pass.apsStaticStage==='remaining'?{...pass,filter:pass.apsStaticOriginalFilter}:pass,seed=>super.render(scene,seed));
      if(selection?.invariantPosition)pass={...pass,invariantPosition:true};
    }
    if(this.grassDepthPrepass&&!pass.late&&!pass.apsVegetationSeed&&!pass.apsGrassTerrainSample&&pass.depthView&&['main','color'].includes(pass.kind)){
      const depthCompare=pass.depthCompare??'greater-equal';
      const draws=new Set([...this.vegetationSystems].filter(s=>s.isGrass).flatMap(s=>[...s.models.flatMap(m=>m.draws),...(s.screenGrass?.models??[]).flatMap(row=>[row.mesh,...(row.near?[row.near.mesh]:[])])]).filter(o=>{const m=o.material;return !m.transparent&&m.depthTest&&m.depthWrite&&!m.depthBias&&!m.depthBiasSlopeScale&&(!m.depthCompare||m.depthCompare===depthCompare);}));
      if(draws.size){
        const permitted=pass.filter;
        super.render(scene,{...pass,label:(pass.label??pass.kind)+' grass alpha depth',kind:'depth',items:undefined,colorViews:[],colorFormats:[],after:null,betweenLists:null,apsVegetationSeed:true,apsGrassEarlyZDepth:true,invariantPosition:true,depthCompareOverride:depthCompare,depthWriteOverride:true,depthBias:0,depthBiasSlopeScale:0,filter:o=>draws.has(o)&&(!permitted||permitted(o))});
        pass={...pass,clearDepth:null,apsGrassPrepassDraws:draws};
      }
    }
    for(const system of this.vegetationSystems)if(system.profile&&!pass.timestampWrites)pass={...pass,timestampWrites:system.timestamps(pass.label+' geometry draw')};
    this._beginFrame();
    if(this.passSummary?.frame!==GPU.frame){this.passSummary={frame:GPU.frame,passes:[]};this.depthPolicy={geometry_only_items:0,coverage_or_deformation_items:0};}
    this.actualDraws={indexed_calls:0,instanced_indexed_calls:0,nonindexed_calls:0,instances:0,max_instance_count:0,indirect_calls:0};
    const before={...this.stats};super.render(scene,pass);
    this.passSummary.passes.push({label:pass.label??pass.kind,kind:pass.kind,draws:this.stats.draws-before.draws,triangles:this.stats.triangles-before.triangles,gpu_api:{...this.actualDraws},...(pass.kind==='main'&&!pass.late?{material_batch:this.materialBatch.metadata()}: {})});
  }
  drawItems(rp,items,pass){
    const counts=this.actualDraws;
    const measured=new Proxy(rp,{get(target,key){
      if(key==='drawIndexed'||key==='draw')return (...args)=>{
        const instances=args[1]??1;
        if(key==='drawIndexed'){counts.indexed_calls++;if(instances>1)counts.instanced_indexed_calls++;}else counts.nonindexed_calls++;
        counts.instances+=instances;counts.max_instance_count=Math.max(counts.max_instance_count,instances);
        return target[key](...args);
      };
      if(key==='drawIndexedIndirect'||key==='drawIndirect')return (...args)=>{counts.indirect_calls++;return target[key](...args);};
      const value=target[key];return typeof value==='function'?value.bind(target):value;
    }});
    if(!pass.apsGrassPrepassDraws)return super.drawItems(measured,items,pass);
                                                                               
                                                                       
    for(let start=0;start<items.length;){
      const grass=pass.apsGrassPrepassDraws.has(items[start].object);let end=start+1;
      while(end<items.length&&pass.apsGrassPrepassDraws.has(items[end].object)===grass)end++;
      const selected=grass?{...pass,invariantPosition:true,depthCompareOverride:'equal',depthWriteOverride:false,passKey:pass.passKey+'|grass-depth-equal-invariant'}:pass;
      super.drawItems(measured,items.slice(start,end),selected);start=end;
    }
  }
  _applyMainVisibility(lists,pass){
    if(this.precompiling){this.visibilityFrame=null;return this.visibilityFrame;}
    if(!GPU.device){
      this.visibilityFrame={schema:'aps-static-draw-gpu/1',culling:'gpu-conservative-frustum',enabled:false,pass:pass.kind,objects:lists.opaque.length,fallback_objects:lists.opaque.length,fallback_reasons:{gpu_unavailable:lists.opaque.length}};
      return this.visibilityFrame;
    }
    try{
      this.staticDraw??=new StaticDrawGPU(this);
      this.staticDraw.enabled=this.staticDrawEnabled;
      this.visibilityFrame=this.staticDraw.apply(lists,pass);
    }catch(error){
      if(!this.staticDraw?.apply)this.staticDraw=null;
      else this.staticDraw.lastError={message:String(error?.message??error),stage:'static_draw_gpu_apply'};
      this.visibilityFrame={schema:'aps-static-draw-gpu/1',culling:'gpu-conservative-frustum',enabled:false,pass:pass.kind,objects:lists.opaque.length,fallback_objects:lists.opaque.length,fallback_reasons:{apply_error:lists.opaque.length},error:String(error?.message??error)};
    }
    return this.visibilityFrame;
  }
                                                                                
                                                                                    
                                                                             
                                                                                    
                                     
  _applyStaticVisibility(lists,pass){
    const camera=pass.camera,provider=this.staticVisibility;
    const frame={culling:'conservative-frustum-bsp',occlusion:false,pass:pass.kind,enabled:!!provider?.visibilityEnabled?.(),objects:0,culled_objects:0,zero_visible_objects:0,fallback_objects:0,full_triangles:0,visible_triangles:0,index_bytes_saved:0};
    if(!frame.enabled){if(this.visibilityProxies.size)this.disposeVisibilityProxies();return frame;}
    if(!camera)return frame;
    for(const item of lists.opaque){
      const object=item.object,geometry=item.geometry,material=item.material;
                                                                            
                                                                              
                                               
      if(!object?.isMesh||!(geometry?.userData?.aps_source_parts||object.userData?.aps_bsp_source_parts)||material?.transparent||material?.alphaTest>0)continue;
      if((object.isInstancedMesh&&object.userData?.aps_no_instancing)||object.userData?.aps_static_visibility_disabled||geometry.groups?.length||(geometry.drawRange&&geometry.drawRange.count!==Infinity))continue;
      frame.objects++;
      let plan=null;try{plan=provider.planVisibility(object,camera);}catch{plan={fallback:true,reason:'selector_error'};}
      if(!plan||plan.fallback||!plan.index){frame.fallback_objects++;continue;}
                                                                                 
                                                                               
                                                        
      if(plan.visibleTriangles===0){
        item.count=0;frame.culled_objects++;frame.zero_visible_objects++;
        frame.full_triangles+=plan.fullTriangles;
        frame.index_bytes_saved+=plan.fullTriangles*3*4;
        provider.noteCulledDraw?.(plan,{object:object.name||null,instances:object.isInstancedMesh?object.count:1,full_triangles:plan.fullTriangles,visible_triangles:0,zero_draw:true});
        continue;
      }
      if(plan.visibleTriangles>=plan.fullTriangles){frame.fallback_objects++;continue;}
      const proxy=this._visibilityProxy(geometry,plan);
      if(!proxy){frame.fallback_objects++;continue;}
      item.geometry=proxy;item.start=0;item.count=Infinity;
      frame.culled_objects++;frame.full_triangles+=plan.fullTriangles;frame.visible_triangles+=plan.visibleTriangles;
      frame.index_bytes_saved+=(plan.fullTriangles-plan.visibleTriangles)*3*4;
      provider.noteCulledDraw?.(plan,{object:object.name||null,instances:object.isInstancedMesh?object.count:1,full_triangles:plan.fullTriangles,visible_triangles:plan.visibleTriangles});
    }
    frame.draw_triangle_reduction=frame.full_triangles?1-frame.visible_triangles/frame.full_triangles:0;
    return frame;
  }
  _visibilityProxy(geometry,plan){
                                                                                
                                                                                 
                                                                                 
                                                                            
                                                                             
                                                                                  
                                               
    const source=geometry?.index?.array,index=plan?.index;
    if(!source||!index||index.length===0||index.length>source.length)return null;
    let hash=2166136261;for(const v of index){hash^=v;hash=Math.imul(hash,16777619)>>>0;}
    const key=geometry.uuid+':'+hash+':'+index.length;
    let bucket=this.visibilityProxies.get(key);
    if(bucket){
      for(const entry of bucket){
        if(entry.index.length===index.length&&sameIndexValues(entry.index,index)){
                                                 
          this.visibilityProxies.delete(key);this.visibilityProxies.set(key,bucket);
          return entry.proxy;
        }
      }
    }else{bucket=[];this.visibilityProxies.set(key,bucket);}
    const proxy=new BufferGeometry();
    for(const [name,attribute] of Object.entries(geometry.attributes))proxy.setAttribute(name,attribute);
    proxy.setIndex(new BufferAttribute(index,1));
                                                                              
                                                                          
    const {apsVegetationBufferOwner,...sourceUserData}=geometry.userData??{};
    proxy.userData={...sourceUserData,aps_culled_proxy:true,aps_visibility_schema:plan.schema,apsStaticVertexOwner:geometry};
    bucket.push({index,proxy});this.visibilityProxyCount+=1;
    this._trimVisibilityProxies();
    return proxy;
  }
  _trimVisibilityProxies(){
    while(this.visibilityProxyCount>16){
      const [key,bucket]=this.visibilityProxies.entries().next().value;
      const entry=bucket.shift();this.visibilityProxyCount-=1;
      try{entry.proxy.dispose();}catch{}
      if(!bucket.length)this.visibilityProxies.delete(key);
    }
  }
  disposeVisibilityProxies(){
    for(const bucket of this.visibilityProxies.values())for(const entry of bucket){try{entry.proxy.dispose();}catch{}}
    this.visibilityProxies.clear();this.visibilityProxyCount=0;
  }
  collect(scene,pass={}){
                                                                         
                                                                          
    const receiverXYZ=pass.apsReceiverXYZ===true;
    const priorFilter=pass.filter;
    const filter=o=>overlayAllowedInPass(o,pass)&&!o.userData?.apsVegetationSource&&(!o.userData?.apsGrassViewCamera||o.userData.apsGrassViewCamera===pass.camera)&&(!pass.apsVegetationSeed||!o.userData?.apsShadowOnly&&(!o.userData?.apsGrassGenerated||pass.apsGrassEarlyZDepth))&&(!receiverXYZ||receiverXYZFilter(o,pass))&&(!priorFilter||priorFilter(o));
                                                                           
                                                                        
                                                                            
                                                                             
                                                                            
    const sources=pass.apsStaticSourceLists;
    const lists=sources?{opaque:sources.opaque.filter(i=>filter(i.object)).map(i=>({...i})),transparent:sources.transparent.filter(i=>filter(i.object)).map(i=>({...i}))}:super.collect(scene,{...pass,filter,kind:receiverXYZ||pass.apsVegetationSeed?'color':pass.kind});
    if(pass.apsStaticSourceOnly)return lists;
    if(receiverXYZ){
                                                                           
                                                                           
                                                                            
                                                                               
      lists.opaque=lists.opaque.filter(receiverXYZItemEligible);
      lists.transparent=lists.transparent.filter(receiverXYZItemEligible);
    }
    const batchColor=!pass.apsPlanarReflection&&['main','color'].includes(pass.kind)&&!pass.late&&!pass.apsVegetationSeed&&!pass.apsGrassTerrainSample&&!pass.apsGrassEarlyZDepth&&pass.colorViews?.length;
    const batchVisibilityDepth=pass.kind==='depth'&&pass.apsVegetationSeed&&!pass.apsGrassTerrainSample&&!pass.apsGrassEarlyZDepth;
    if(pass.apsStaticStage!=='mesh'&&(pass.kind==='main'&&!pass.late&&!pass.apsVegetationSeed&&!pass.apsGrassTerrainSample&&!pass.apsGrassEarlyZDepth&&pass.colorViews?.length||batchVisibilityDepth))this._applyMainVisibility(lists,pass);
    if(batchColor||batchVisibilityDepth)this.materialBatch.apply(lists,pass);
    if(pass.apsStaticStage==='mesh')this.staticBSP.apply(lists,pass);
    if(pass.kind!=='depth'&&!receiverXYZ)return lists;
    for(const item of [...lists.opaque,...lists.transparent]){
      const original=item.material,mesh=item.object;
      if(batchVisibilityDepth&&original.userData?.apsStaticBatchDepth){item.material=original.userData.apsStaticBatchDepth;item.pipeKey=item.material.id;this.depthPolicy.geometry_only_items++;continue;}
      if(pass.apsGrassEarlyZDepth&&mesh.userData?.apsGrassGenerated){
        const key='screen-grass-alpha-depth:'+original.id+':'+original.version;
        let depth=this.geometryDepthMaterials.get(key);
        if(!depth){
          const coverage=original.userData?.apsCoverageDepth;
          if(coverage){
            const storage={};for(const name of ['apsScreenGrassMatrices','apsScreenGrassKeys'])storage[name]=original.bindings[name];
            depth=new Material({name:'screen grass alpha-only depth',lit:false,side:original.side,opacity:original.opacity,uniforms:coverage.uniforms,vertex:original.userData.apsScreenGrassDepthVertex+coverage.vertex+(original.userData.apsScreenGrassDepthPostVertex??''),attributes:coverage.attributes,varyings:coverage.varyings,bindings:{...storage,...coverage.bindings},modules:[coverage.module,...(original.userData.apsScreenGrassDepthModules??[])],shadow:original.shadow});
            for(const name of ['opacity','alphaTest',...Object.keys(coverage.uniforms??{})])depth.uniforms[name]=depth.uniformBlock.fields[name]=original.uniforms[name];
          }else{depth=original.clone();}
          this.geometryDepthMaterials.set(key,depth);
        }
        item.material=depth;item.pipeKey=depth.id;continue;
      }
      if(pass.apsVegetationSeed&&mesh.userData?.apsTerrainOccluder){
                                                                              
                                                                       
        const clip=pass.vegetationClip??[0,0,0,0],key='visibility-terrain:'+original.id+':'+original.version+':'+clip.join(',');
        let depth=this.geometryDepthMaterials.get(key);
        if(!depth){depth=original.clone();depth.side='double';
                                                                          
                                                                             
          if(clip.some(v=>v!==0))depth.shadow=`if(dot(vec4f(in.P,1.0),vec4f(${clip.map(v=>Number(v).toFixed(6)).join(',')}))<0.0){return false;}\n`+(original.shadow||'return true;');
          delete depth.__pk;delete depth.__pkFrame;this.geometryDepthMaterials.set(key,depth);}
        item.material=depth;item.pipeKey=depth.id;this.depthPolicy.coverage_or_deformation_items++;continue;
      }
      let managedDepth=null;for(const system of this.vegetationSystems){managedDepth=system.depthMaterial(original,pass,mesh);if(managedDepth)break;}
      if(managedDepth){item.material=managedDepth;item.pipeKey=managedDepth.id;this.depthPolicy[original.alphaTest>0?'coverage_or_deformation_items':'geometry_only_items']++;continue;}
      if(!mesh.userData?.aps_native_static_geometry||original.alphaTest>0||original.transparent||original.shadow){this.depthPolicy.coverage_or_deformation_items++;continue;}
      const key=[original.side,original.topology,original.depthTest].join(':');
      let depth=this.geometryDepthMaterials.get(key);
      if(!depth){depth=new Material({name:'APS geometry-only depth '+key,lit:false,side:original.side,topology:original.topology,depthTest:original.depthTest});this.geometryDepthMaterials.set(key,depth);}
      item.material=depth;item.pipeKey=depth.id;this.depthPolicy.geometry_only_items++;
    }
    return lists;
  }
  dispose(){this.resourceRoots.clear();this.resourceLedger=new WeakMap();this.lastResourcePreparation=null;this.staticBSP?.dispose();this.staticBSP=null;this.materialBatch.dispose();this.staticDraw?.dispose?.();this.staticDraw=null;this.disposeVisibilityProxies();disposeVegetationViews(this);for(const material of this.geometryDepthMaterials.values()){material.dispose();material.uniformBlock.buffer?.destroy();}this.geometryDepthMaterials.clear();}
}
function sameIndexValues(a,b){
  if(a===b)return true;
  if(a.length!==b.length)return false;
  for(let i=0;i<a.length;i++)if(a[i]!==b[i])return false;
  return true;
}
