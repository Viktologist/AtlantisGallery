                                                                                
                                                                                
export function isRoofObject(object) {
 const data=object.userData??{};
 if(data.aps_static_roof===true)return true;
 if(data.aps_instance_prototype&&['pan','cap'].includes(data.aps_instance_role)&&data.aps_instance_material==='terracotta')return true;
 if(/(?:^|[_\s])(?:roof|gable)(?:[_\s]|$)/i.test(object.name??''))return true;
 const sources=data.aps_instance_sources;
 return Array.isArray(sources)&&sources.length>0&&sources.every(source=>isRoofObject({userData:source}));
}

export function applyOverlayInspection(viewer,overlay,visible) {
 if(!overlay.inspection)return;
 overlay.hiddenInspectionObjects??=new Map();
 if(!visible){
  for(const [object,previous] of overlay.hiddenInspectionObjects)object.visible=previous;
  overlay.hiddenInspectionObjects.clear();return;
 }
 const ids=new Set(overlay.inspection.hide_roofs??[]);
 const roots=[viewer.root,...[...(viewer.meshCompanions??[])].map(asset=>asset.root)].filter(Boolean);
 for(const root of roots){
  if(!ids.has(root.userData?.apsSceneAssetId))continue;
  root.traverse(object=>{
   if(!object.isMesh||!isRoofObject(object))return;
   if(!overlay.hiddenInspectionObjects.has(object))overlay.hiddenInspectionObjects.set(object,object.visible);
   object.visible=false;
  });
 }
}
