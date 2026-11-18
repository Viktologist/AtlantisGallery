                                                                               
                                                                                
export function inheritedBuildingData(object){
 const result={};
 for(let p=object;p;p=p.parent)for(const key of ['aps_storey_id','aps_storey_ids','aps_building_role','aps_interaction'])
  if(result[key]===undefined&&p.userData?.[key]!==undefined)result[key]=p.userData[key];
 return result;
}
export function semanticLayerKey(data={}){return JSON.stringify([data.aps_storey_id??null,data.aps_storey_ids??null,data.aps_building_role??null]);}
export function layerAllows(data,state){
 const ids=data.aps_storey_ids??(data.aps_storey_id?[data.aps_storey_id]:[]);
 return (state.storey==='all'||!ids.length||ids.includes(state.storey))&&(state.roofs||data.aps_building_role!=='roof');
}
export function installBuildingLayers(viewer,document){
 const storeys=document.storeys??[];
 if(!Array.isArray(storeys))throw Error('storeys must be an authored array');
 const ids=new Set();for(const row of storeys){if(!row.id||ids.has(row.id)||!Number.isFinite(row.elevation))throw Error('Invalid/duplicate storey');ids.add(row.id);}
 const state={storey:'all',roofs:true,...document.view_layers},records=[];
 if(state.storey!=='all'&&!ids.has(state.storey))throw Error('Unknown selected storey');
 viewer.scene.traverse(object=>{if(!object.isMesh)return;const data=inheritedBuildingData(object);
  if(!data.aps_storey_id&&!data.aps_storey_ids&&!data.aps_building_role)return;
  for(const id of data.aps_storey_ids??(data.aps_storey_id?[data.aps_storey_id]:[]))if(!ids.has(id))throw Error('Mesh references undeclared storey: '+id);
  records.push({object,data,baseVisible:object.visible});
 });
 const apply=()=>{for(const row of records)row.object.visible=row.baseVisible&&layerAllows(row.data,state);viewer.invalidateVisibility();};
 const controller={storeys,state,records,setStorey(id){if(id!=='all'&&!ids.has(id))throw Error('Unknown storey: '+id);state.storey=id;apply();},
  setRoofs(visible){state.roofs=!!visible;apply();},metadata(){return {storey:state.storey,roofs:state.roofs,storeys:storeys.length,
   roof_meshes:records.filter(r=>r.data.aps_building_role==='roof').length,visible_meshes:records.filter(r=>r.object.visible).length};}};
 viewer.buildingLayers=controller;apply();return controller;
}
