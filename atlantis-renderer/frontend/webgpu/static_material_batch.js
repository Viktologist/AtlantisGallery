                                                                                 
                                                                                 
                                                                                  
                                                                                  
                                                                       
import {GPU,StorageBuffer,ShaderModule,Material} from '../../vendor/tidewater/src/engine/webgpu.js';
import {Mesh,Object3D,BufferGeometry,BufferAttribute} from '../../vendor/tidewater/src/engine/index.js';
import {STATIC_CHUNK_MIN_INDICES} from './static_draw_gpu_plan.js';

const ATTRS=new Set(['position','normal','tangent','color','uv','uv1','uv2','uv3']);
const MAX_PARTS=256,MAX_VERTICES=131072,DRAW_WORDS=36;
const SOURCE_REMAP='if(draw.params.w>=0.0){v.instance=apsStaticInstanceIds[u32(draw.params.w)+v.instance];}';
const sourceSentinel=o=>!o.isInstancedMesh&&o.material?.userData?.aps_static_instance_remap&&o.drawParams?.length===3&&o.drawParams[0]===0&&o.drawParams[1]===0&&o.drawParams[2]===-1&&o.material.vertex.includes(SOURCE_REMAP);
const ordinaryVertex=m=>m.userData?.aps_static_instance_remap?m.vertex.replace('\n'+SOURCE_REMAP,''):m.vertex;
const ordinaryBindings=m=>Object.fromEntries(Object.entries(m.bindings).filter(([k])=>k!=='apsStaticInstanceIds'||!m.userData?.aps_static_instance_remap));
const wireActive=o=>{const w=o.userData?.apsWire;return !!w&&(typeof w!=='object'||o.geometry===w.geometry||o.material===w.material);};
const rewrite=text=>text.replace(/\bmat\s*\./g,'apsBatchMat.');
const valuesEqual=(a,b)=>a.length===b.length&&a.every((v,i)=>v===b[i]);

export class StaticMaterialBatch {
  constructor(renderer,{requirePrepared=false}={}){
    this.renderer=renderer;this.requirePrepared=requirePrepared;this.enabled=true;this.records=new Map();this.families=new Map();
    this.materialKeys=new WeakMap();this.ids=new WeakMap();this.serial=0;this.retired=[];
    this.preparedRoots=new Map();this.builds=0;this.unpreparedItems=0;
    this.last={schema:'aps-static-material-batch/1',enabled:true,source_items:0,saved_draw_items:0};
  }
  id(value){if(value===null||typeof value!=='object'&&typeof value!=='function')return value;let id=this.ids.get(value);if(!id){id=++this.serial;this.ids.set(value,id);}return id;}
  materialKey(m){
    const state=[m.side,m.blending,m.depthWrite,m.depthTest,m.depthCompare,m.depthBias,m.depthBiasSlopeScale,m.colorWrite,m.topology,m.velocityWeight,m.receiveShadows,m.vertexColors];
    const cached=this.materialKeys.get(m);if(cached?.version===m.version&&valuesEqual(state,cached.state))return cached.key;
    const module=m.modules[0];
                                                                                  
                                                                               
    const key=JSON.stringify([ordinaryVertex(m),m.surface,m.output,module.code,module.deps.map(d=>this.id(d)),
      Object.entries(ordinaryBindings(m)).sort(([a],[b])=>a.localeCompare(b)).map(([k,s])=>[k,Object.entries(s).map(([n,v])=>[n,this.id(v)])]),
      m.uniformBlock.order.map(k=>[k,m.uniformBlock.layout[k].typeStr]),m.attributes,m.varyings,m.allDefines(),
      state]);
    this.materialKeys.set(m,{version:m.version,state,key});return key;
  }
  eligibility(item){
    const {object:o,geometry:g,material:m}=item,u=o.userData??{};
    if(!o.isMesh||o.isInstancedMesh)return 'existing_instances';
    if(u.apsTerrainOccluder)return 'landscape_separate';
    if(g.indirect||g.userData?.apsStaticVertexOwner)return 'gpu_visibility_proxy';
                                                                           
                                                                                
                                                                                
    if(u.aps_no_batch||wireActive(o)||u.apsDiagnosticOverlay)return 'protected_draw';
    if(u.aps_deformed||u.aps_animated||o.isSkinnedMesh||Object.keys(g.morphAttributes??{}).length)return 'deformed_or_animated';
    if(o.onBeforeRender&&o.onBeforeRender!==Object3D.prototype.onBeforeRender||o.drawParams&&!sourceSentinel(o))return 'custom_object_hook';
    if(m.userData?.materialAdapter!=='aps-native-webgpu/1'||m.modules.length!==1||m.modules[0].name!=='aps-mesh-material'||/\bmat\s*\./.test(m.vertex))return 'custom_program';
    if(m.transparent||m.alphaTest>0||m.shadow||(m.userData.sourceMaterial?.alphaMode??'OPAQUE')!=='OPAQUE')return 'alpha_or_shadow_hook';
    if(m.topology!=='triangle-list'||g.groups?.length||item.start!==0||item.count!==Infinity||g.drawRange?.start||g.drawRange?.count!==Infinity)return 'partial_or_nontriangle';
    const count=g.index?.count??g.attributes.position?.count??0;
    if(count>=STATIC_CHUNK_MIN_INDICES)return 'large_gpu_chunk_mesh';
    if(!count||count%3||!g.attributes.position||g.attributes.position.count>MAX_VERTICES)return 'invalid_geometry';
    const attrs=Object.entries(g.attributes);
    if(attrs.length+1>(GPU.limits?.maxVertexBuffers??8))return 'vertex_buffer_budget';
    if(attrs.some(([name,a])=>!ATTRS.has(name)||a.isInterleavedBufferAttribute||a.isInstancedBufferAttribute||!a.array||a.count!==g.attributes.position.count||a.itemSize<1||a.itemSize>4))return 'unsupported_attributes';
    if(Object.values(ordinaryBindings(m)).some(s=>!s.texture&&!s.sampler))return 'custom_material_binding';
    return null;
  }
  signature(item){
    const {geometry:g,material:m}=item;
    return [g,m,m.version,item.renderOrder,item.object.layers.mask,m.side,m.blending,m.depthWrite,m.depthTest,m.depthCompare,m.depthBias,m.depthBiasSlopeScale,m.colorWrite,m.velocityWeight,m.receiveShadows,m.vertexColors,g.attributesVersion,g.index,g.index?.version,g.index?.array,...Object.entries(g.attributes).sort().flatMap(([n,a])=>[n,a,a.version,a.array,a.itemSize,a.normalized,a.gpuType])];
  }
  matches(record,item){
    const {object:o,geometry:g,material:m}=item,s=record.signature,u=o.userData??{};
    if(o.isInstancedMesh||item.start!==0||item.count!==Infinity||g.groups?.length||g.drawRange?.start||g.drawRange?.count!==Infinity||m.topology!=='triangle-list')return false;
    if(g!==s[0]||m!==s[1]||m.version!==s[2]||item.renderOrder!==s[3]||o.layers.mask!==s[4]||m.side!==s[5]||m.blending!==s[6]||m.depthWrite!==s[7]||m.depthTest!==s[8]||m.depthCompare!==s[9]||m.depthBias!==s[10]||m.depthBiasSlopeScale!==s[11]||m.colorWrite!==s[12]||m.velocityWeight!==s[13]||m.receiveShadows!==s[14]||m.vertexColors!==s[15]||g.attributesVersion!==s[16]||g.index!==s[17]||g.index?.version!==s[18]||g.index?.array!==s[19])return false;
    if(u.apsTerrainOccluder||u.aps_no_batch||wireActive(o)||u.apsDiagnosticOverlay||u.aps_deformed||u.aps_animated||m.transparent||m.alphaTest>0||m.shadow||o.onBeforeRender!==record.beforeRender||o.drawParams!==record.drawParams)return false;
    if(o.drawParams&&(o.drawParams[0]!==0||o.drawParams[1]!==0||o.drawParams[2]!==-1||o.drawParams.length!==3))return false;
    for(let i=20;i<s.length;i+=7){const a=g.attributes[s[i]];if(a!==s[i+1]||a.version!==s[i+2]||a.array!==s[i+3]||a.itemSize!==s[i+4]||a.normalized!==s[i+5]||a.gpuType!==s[i+6])return false;}
    return true;
  }
  familyKey(item){
    return JSON.stringify([this.materialKey(item.material),item.renderOrder,item.object.layers.mask,
      Object.entries(item.geometry.attributes).sort().map(([n,a])=>[n,a.array.constructor.name,a.itemSize,a.normalized,a.gpuType])]);
  }
  remove(record){
    record.family.members.delete(record.object);record.family.dirty=true;this.records.delete(record.object);
  }
  register(item){
    const signature=this.signature(item),existing=this.records.get(item.object);
    if(existing&&valuesEqual(signature,existing.signature))return existing;
    if(existing)this.remove(existing);
    const key=this.familyKey(item);let family=this.families.get(key);
    if(!family){family={members:new Map(),batches:[],dirty:true};this.families.set(key,family);}
    const record={object:item.object,geometry:item.geometry,material:item.material,signature,family,batch:null,start:0,count:0,beforeRender:item.object.onBeforeRender,drawParams:item.object.drawParams};
    family.members.set(item.object,record);family.dirty=true;this.records.set(item.object,record);return record;
  }
  makeBatch(members){
    this.builds++;
    const source=members[0].material,geometry=new BufferGeometry(),names=Object.keys(members[0].geometry.attributes).sort();
    const vertices=members.reduce((s,r)=>s+r.geometry.attributes.position.count,0),indices=members.reduce((s,r)=>s+(r.geometry.index?.count??r.geometry.attributes.position.count),0);
    for(const name of names){const a=members[0].geometry.attributes[name];geometry.setAttribute(name,new BufferAttribute(new a.array.constructor(vertices*a.itemSize),a.itemSize,a.normalized));geometry.attributes[name].gpuType=a.gpuType;}
    const ids=new Uint32Array(vertices),index=new Uint32Array(indices),materials=[...new Set(members.map(r=>r.material))],materialRows=new Map(materials.map((m,i)=>[m,i]));
    let vo=0,io=0;
    members.forEach((r,row)=>{
      const g=r.geometry,n=g.attributes.position.count;
      for(const name of names)geometry.attributes[name].array.set(g.attributes[name].array,vo*g.attributes[name].itemSize);
      ids.fill(row,vo,vo+n);r.start=io;r.count=g.index?.count??n;
      for(let j=0;j<r.count;j++){const v=g.index?g.index.array[j]:j;if(v>=n)throw Error('Static material batch source index outside vertices');index[io+j]=vo+v;}
      vo+=n;io+=r.count;
    });
    geometry.setAttribute('apsBatchObject',new BufferAttribute(ids,1));geometry.setIndex(new BufferAttribute(index,1));
    geometry.userData.apsMaterialBatch=true;
    const params=new Uint32Array(materials.length*source.uniformBlock.byteLength/4),draws=new Float32Array(members.length*DRAW_WORDS),drawU32=new Uint32Array(draws.buffer);
    const materialBuffer=new StorageBuffer({label:'static batch material parameters',type:'u32',count:params.length,data:params});
    const drawBuffer=new StorageBuffer({label:'static batch object matrices',type:'u32',count:draws.length,data:drawU32});
    const tableType=source.uniformBlock.wgsl.replace(source.uniformBlock.structName,'APSStaticBatchParams');
    const table=new ShaderModule({name:'aps-static-batch-table',code:tableType+`
var<private> apsBatchMat: APSStaticBatchParams;
struct APSStaticBatchDraw { model: mat4x4f, prevModel: mat4x4f, params: vec4u, };
`,bindings:{apsBatchMaterials:{storage:materialBuffer,wgslType:'array<APSStaticBatchParams>',access:'read',visibility:'fragment'},apsBatchDraws:{storage:drawBuffer,wgslType:'array<APSStaticBatchDraw>',access:'read',visibility:'vertex'}}});
    const originalModule=source.modules[0],module=new ShaderModule({name:'aps-static-batch-surface',deps:[table,...originalModule.deps],code:rewrite(originalModule.code)});
    const material=source.clone();delete material.__pk;delete material.__pkFrame;material.name='Static batch: '+source.name;material.modules=[module];material.bindings=ordinaryBindings(source);
    material.attributes={...source.attributes,apsBatchObject:'u32'};material.varyings={...source.varyings,apsBatchMaterial:'u32'};
    material.vertex=`let apsObject=apsBatchDraws[v.apsBatchObject];v.model=apsObject.model;v.prevModel=apsObject.prevModel;o.apsBatchMaterial=apsObject.params.x;\n`+ordinaryVertex(source);
    material.surface='apsBatchMat=apsBatchMaterials[in.vs.apsBatchMaterial];\n'+rewrite(source.surface);material.output=rewrite(source.output);
                                                                                
                                                                            
    delete material.setOceanReceiver;
    const depthMaterial=new Material({name:'Static batch visibility depth',lit:false,side:source.side,topology:source.topology,depthTest:source.depthTest,depthWrite:source.depthWrite,
      depthCompare:source.depthCompare,depthBias:source.depthBias,depthBiasSlopeScale:source.depthBiasSlopeScale,modules:[table],attributes:{apsBatchObject:'u32'},
      vertex:'let apsObject=apsBatchDraws[v.apsBatchObject];v.model=apsObject.model;v.prevModel=apsObject.prevModel;'});
    material.userData={...source.userData,apsStaticBatchDepth:depthMaterial};
    const object=new Mesh(geometry,material);object.frustumCulled=false;object.renderOrder=members[0].object.renderOrder;object.layers.mask=members[0].object.layers.mask;
    const batch={members,materials,geometry,material,depthMaterial,object,params,draws,drawU32,materialBuffer,drawBuffer,materialRows,models:members.map(()=>null),modelFrames:members.map(()=>-1),moving:members.map(()=>false)};
    members.forEach(r=>{r.batch=batch;});this.update(batch,new Set(members.map(r=>r.object)),true);return batch;
  }
  update(batch,selected,initial=false){
    let paramsChanged=initial,drawsChanged=initial;
    if(initial||batch.parameterFrame!==GPU.frame)batch.materials.forEach((m,row)=>{
      m.uniformBlock._pack();const data=m.uniformBlock.u32,offset=row*data.length;
      for(let j=0;j<data.length;j++)if(batch.params[offset+j]!==data[j]){batch.params[offset+j]=data[j];paramsChanged=true;}
    });
    batch.parameterFrame=GPU.frame;
    batch.members.forEach((r,i)=>{
        if(!selected.has(r.object)||!initial&&batch.modelFrames[i]===GPU.frame)return;
        const e=r.object.matrixWorld.elements,offset=i*DRAW_WORDS,old=batch.models[i],previous=!old||r.object.staticVelocity||r.object.resetVelocity?e:old;
        let changed=!old;if(old)for(let j=0;j<16;j++)if(old[j]!==e[j]){changed=true;break;}
        batch.modelFrames[i]=GPU.frame;if(!initial&&!changed&&!batch.moving[i]&&!r.object.resetVelocity)return;
                                                                              
                                                                                   
        for(let j=0;j<16;j++){
          const cur=Math.fround(e[j]),prev=Math.fround(previous[j]);
          if(batch.draws[offset+j]!==cur||batch.draws[offset+16+j]!==prev)drawsChanged=true;
          batch.draws[offset+j]=cur;batch.draws[offset+16+j]=prev;
        }
        if(changed)batch.models[i]=Array.from(e);batch.moving[i]=!!old&&changed&&!r.object.staticVelocity&&!r.object.resetVelocity;batch.drawU32[offset+32]=batch.materialRows.get(r.material);
        if(!this.renderer.precompiling)r.object.resetVelocity=false;
      });
    if(paramsChanged){if(GPU.device)batch.materialBuffer.write(batch.params);else batch.materialBuffer.pendingData=batch.params;}
    if(drawsChanged){if(GPU.device)batch.drawBuffer.write(batch.drawU32);else batch.drawBuffer.pendingData=batch.drawU32;}
  }
  rebuild(family){
    this.retired.push(...family.batches);family.batches=[];
    let part=[],vertices=0;
    const flush=()=>{if(part.length>1)family.batches.push(this.makeBatch(part));else for(const r of part)r.batch=null;part=[];vertices=0;};
    for(const r of family.members.values()){
      const n=r.geometry.attributes.position.count;if(part.length>=MAX_PARTS||vertices+n>MAX_VERTICES)flush();part.push(r);vertices+=n;
    }
    flush();family.dirty=false;
  }
  prepareRoot(root){
    root.updateMatrixWorld(true);const rows=[],reasons={};
    root.traverse(object=>{
      if(!object.isMesh||!object.geometry||!object.material)return;
      const materials=Array.isArray(object.material)?object.material:[object.material];
      for(const material of materials){
        const item={object,geometry:object.geometry,material,start:object.geometry.drawRange?.start??0,count:object.geometry.drawRange?.count??Infinity,renderOrder:object.renderOrder??0};
        const reason=Array.isArray(object.material)?'multi_material_groups':this.eligibility(item);
        if(reason){reasons[reason]=(reasons[reason]??0)+1;const prior=this.records.get(object);if(prior)this.remove(prior);}
        else this.register(item);
        rows.push({object,material,reason});
      }
    });
    for(const [key,family] of this.families){if(family.dirty)this.rebuild(family);if(!family.members.size)this.families.delete(key);}this.retire();
    let packed=0,singletons=0;for(const row of rows)if(!row.reason){if(this.records.get(row.object)?.batch)packed++;else singletons++;}
    const report={schema:'aps-static-import-batching/1',source_material_items:rows.length,batched_items:packed,singleton_items:singletons,explicit_fallback_items:rows.filter(r=>r.reason).length,fallback_reasons:reasons,accounted_items:packed+singletons+rows.filter(r=>r.reason).length,unaccounted_items:0};
    if(report.accounted_items!==report.source_material_items)throw Error('Imported batching coverage does not reconcile');
    this.preparedRoots.set(root,{report});root.userData.apsImportBatching=report;
    if(GPU.device&&this.renderer._attributeBuffer)for(const family of this.families.values())for(const b of family.batches){for(const a of Object.values(b.geometry.attributes))this.renderer._attributeBuffer(b.geometry,a);this.renderer._indexBuffer(b.geometry);}
    return report;
  }
  prepareScene(scene){return this.prepareRoot(scene);}
  retire(){
    if(!this.retired.length)return;
                                                                                
                                                                                  
    const old=this.retired.splice(0),dispose=()=>{for(const b of old){b.geometry.dispose();b.material.dispose();b.material.uniformBlock.buffer?.destroy();b.depthMaterial.dispose();b.depthMaterial.uniformBlock.buffer?.destroy();b.materialBuffer.destroy();b.drawBuffer.destroy();}};
    if(GPU.device){GPU.submit();GPU.queue.onSubmittedWorkDone().then(dispose,dispose);}else dispose();
  }
  apply(lists,pass={}){
    const frame={schema:'aps-static-material-batch/1',enabled:this.enabled,pass:pass.kind??'cpu-plan',source_items:lists.opaque.length,eligible_items:0,batched_source_items:0,batch_draw_items:0,saved_draw_items:0,fallback_reasons:{}};
    this.last=frame;if(!this.enabled)return frame;
    const active=new Map();
    for(const item of lists.opaque){
      const known=this.records.get(item.object);if(known&&this.matches(known,item)){active.set(item.object,known);frame.eligible_items++;continue;}
      const reason=this.eligibility(item);
      if(reason){frame.fallback_reasons[reason]=(frame.fallback_reasons[reason]??0)+1;const old=this.records.get(item.object);if(old&&!this.requirePrepared)this.remove(old);continue;}
      if(this.requirePrepared){
        const record=this.records.get(item.object);
        if(!record||!this.matches(record,item)){this.unpreparedItems++;const why=record?'resource_revision_unprepared':'import_not_prepared';frame.fallback_reasons[why]=(frame.fallback_reasons[why]??0)+1;continue;}
        active.set(item.object,record);frame.eligible_items++;continue;
      }
      if(!this.records.has(item.object))this.unpreparedItems++;
      const r=this.register(item);active.set(item.object,r);frame.eligible_items++;
    }
    if(!this.requirePrepared)for(const [key,family] of this.families){if(family.dirty)this.rebuild(family);if(!family.members.size)this.families.delete(key);}
    this.retire();
    const selected=new Set(active.keys()),emitted=new Set(),output=[];
    for(const item of lists.opaque){
      const r=active.get(item.object),batch=r?.batch;
      if(!batch){output.push(item);continue;}
      frame.batched_source_items++;
      if(emitted.has(batch))continue;emitted.add(batch);this.update(batch,selected);
      let run=null;
      for(const member of batch.members){
        if(!selected.has(member.object)){run=null;continue;}
        if(run&&run.start+run.count===member.start)run.count+=member.count;
        else{run={...item,object:batch.object,geometry:batch.geometry,material:batch.material,pipeKey:batch.material.id,start:member.start,count:member.count};output.push(run);frame.batch_draw_items++;}
      }
    }
    lists.opaque=output;frame.saved_draw_items=frame.batched_source_items-frame.batch_draw_items;frame.output_items=output.length;frame.packed_batches=emitted.size;
    return frame;
  }
  metadata(){return {...this.last,total_batch_builds:this.builds,unprepared_item_encounters:this.unpreparedItems,prepared_roots:this.preparedRoots.size};}
  forgetRoot(root){const objects=new Set();root.traverse(o=>objects.add(o));for(const o of objects){const r=this.records.get(o);if(r)this.remove(r);}for(const [key,family] of this.families){if(family.dirty)this.rebuild(family);if(!family.members.size)this.families.delete(key);}for(const key of this.preparedRoots.keys())if(key===root||objects.has(key))this.preparedRoots.delete(key);this.retire();}
  dispose(){for(const f of this.families.values())this.retired.push(...f.batches);this.records.clear();this.families.clear();this.preparedRoots.clear();this.retire();}
}
