                                                                              
                                                                              
import {applyOverlayInspection} from './scene_overlay_inspection.js';
export function configureSceneOverlay(viewer,asset,definition,transparentLayer) {
  const {id,label,visible=false}=definition,root=asset.root;
  root.userData??={};root.userData.apsDiagnosticOverlay=true;
  root.userData.apsOverlayKind=definition.kind;
  root.visible=visible===true;
  const materials=new Set();
  root.traverse(object=>{
    if(!object.isMesh)return;
    object.userData??={};object.userData.apsDiagnosticOverlay=true;
    object.userData.apsOverlayCamera=viewer.camera;
    object.castShadow=false;object.receiveShadow=false;
    object.layers.set(transparentLayer);
    for(const material of Array.isArray(object.material)?object.material:[object.material]) {
      if(!material||materials.has(material))continue;materials.add(material);
      material.transparent=true;material.depthWrite=false;material.version=(material.version??0)+1;
    }
  });
  viewer.meshRenderer?.nativeCasterBounds?.delete(root);
  viewer.sceneOverlays??=new Map();
  const overlay={id,label:label??id,root,kind:definition.kind,...(definition.inspection?{inspection:definition.inspection}:{})};viewer.sceneOverlays.set(id,overlay);
  applyOverlayInspection(viewer,overlay,root.visible);
  return overlay;
}

export function sceneOverlayMetadata(viewer) {
  return [...(viewer.sceneOverlays?.values()??[])].map(({id,label,root,inspection,kind})=>({id,label,kind,visible:root.visible,...(inspection?{inspection}:{})}));
}

export function setSceneOverlayVisible(viewer,id,visible) {
  const overlay=viewer.sceneOverlays?.get(id);
  if(!overlay)throw Error('Unknown scene overlay: '+id);
  overlay.root.visible=visible===true;
  applyOverlayInspection(viewer,overlay,overlay.root.visible);
  viewer.invalidateVisibility();
  return overlay.root.visible;
}

export function overlayAllowedInPass(object,pass) {
  return !object.userData?.apsDiagnosticOverlay || (
    pass.kind==='main' && pass.camera===object.userData.apsOverlayCamera &&
    !pass.apsVegetationSeed && !pass.apsGrassTerrainSample && !pass.apsGrassEarlyZDepth);
}
