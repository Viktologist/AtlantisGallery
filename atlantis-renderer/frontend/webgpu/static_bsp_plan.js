                                                                             
                                                                                 
export function buildStaticBSP(spans,{leafSize=16,maxDepth=20,maxReferences=spans.length*8+64}={}){
  if(!spans.length)return {nodes:[],references:new Uint32Array(),splits:0};
  const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];
  for(const s of spans)for(let a=0;a<3;a++){
    if(!Number.isFinite(s.min[a])||!Number.isFinite(s.max[a])||s.min[a]>s.max[a])throw Error('Invalid static BSP bounds');
    min[a]=Math.min(min[a],s.min[a]);max[a]=Math.max(max[a],s.max[a]);
  }
  const nodes=[],refs=[];let splits=0,reserved=0;
  function visit(ids,lo,hi,depth){
    const at=nodes.length,node={min:lo,max:hi,escape:0,start:0,count:0,axis:3,plane:0};nodes.push(node);
    const axes=[0,1,2].sort((a,b)=>(hi[b]-lo[b])-(hi[a]-lo[a]));let chosen=null;
    if(ids.length>leafSize&&depth<maxDepth)for(const axis of axes){
      const plane=(lo[axis]+hi[axis])*.5;if(!(plane>lo[axis]+1e-5&&plane<hi[axis]-1e-5))continue;
      const left=ids.filter(i=>spans[i].min[axis]<=plane),right=ids.filter(i=>spans[i].max[axis]>=plane);
                                                                          
      if(!left.length||!right.length||Math.max(left.length,right.length)>=ids.length||reserved+left.length+right.length>maxReferences)continue;
      chosen={axis,plane,left,right};break;
    }
    if(chosen){
      const {axis,plane,left,right}=chosen;reserved+=left.length+right.length;splits++;node.axis=axis;node.plane=plane;
      const lh=hi.slice(),rl=lo.slice();lh[axis]=plane;rl[axis]=plane;
      visit(left,lo.slice(),lh,depth+1);visit(right,rl,hi.slice(),depth+1);
    }else{node.start=refs.length;node.count=ids.length;refs.push(...ids);}
    node.escape=nodes.length;return at;
  }
  visit(spans.map((_,i)=>i),min,max,0);
  return {nodes,references:Uint32Array.from(refs),splits};
}

export function staticBSPAdmission(object){
  if(!object?.isMesh)return 'not_mesh';
  if(object.isInstancedMesh)return 'instances_excluded';
  const u=object.userData??{},g=object.geometry,m=object.material;
  if(u.apsTerrainOccluder)return 'landscape_excluded';
  if(u.apsVegetationManaged||u.apsVegetationSource||u.apsGrassGenerated||u.apsDiagnosticOverlay||u.aps_deformed||u.aps_animated||object.isSkinnedMesh||g?.attributes?.skinIndex||Object.keys(g?.morphAttributes??{}).length)return 'non_static';
  if(!g?.index||!g.attributes.position||g.groups?.length||g.drawRange?.start||g.drawRange?.count!==Infinity)return 'unsupported_geometry';
  if(!m||Array.isArray(m)||m.transparent||m.alphaTest>0||m.shadow||m.topology!=='triangle-list'||!m.depthWrite||!m.depthTest||m.depthBias||m.depthBiasSlopeScale)return 'unsupported_coverage';
  if(m.userData?.sourceMaterial?.extensions?.KHR_materials_transmission||m.userData?.sourceMaterial?.extensions?.KHR_materials_volume)return 'transmission';
  if(u.aps_static_visibility_disabled||u.apsWire)return 'explicit_source';
  return null;
}
