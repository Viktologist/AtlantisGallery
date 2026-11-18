                                         
  
                                                                               
                                                                          
                                                                            
                                                         
export const RECEIVER_XYZ_LABEL = 'aps receiver xyz';
export const RECEIVER_XYZ_FORMAT = 'rgba32float';
export const RECEIVER_XYZ_VALID_COMPONENT = 'w';
export const RECEIVER_XYZ_CLEAR_COLOR = Object.freeze([0, 0, 0, 0]);

                                                                              
                                                                              
                                                                                
export function receiverXYZMaterialEligible(material) {
  return !!material && material.visible !== false && material.transparent !== true && material.receiveShadows !== false;
}

export function receiverXYZItemEligible(item) {
  return !!item && receiverXYZMaterialEligible(item.material);
}

                                                                          
                                                                             
                                                                         
                                                                             
                                                                  
export function receiverXYZFilter(object, pass = {}) {
  if (!object || object.isMesh !== true || !object.material || !object.geometry) return false;
  if (object.visible === false) return false;
  const userData = object.userData || {};
  const geometryData = object.geometry?.userData || {};
  if (userData.apsShadowOnly === true || geometryData.apsShadowOnly === true) return false;
  if (userData.apsShadowBatch === true || geometryData.apsShadowBatch === true) return false;
  if (userData.apsVegetationSource === true) return false;
  if (userData.apsDiagnosticOverlay === true) return false;
  if (object.receiveShadow === false) return false;
  const layerMask = pass.layerMask ?? 1;
  if (object.layers && Number.isFinite(object.layers.mask) && (object.layers.mask & layerMask) === 0) return false;
  const materials = Array.isArray(object.material) ? object.material : [object.material];
  if (!materials.length) return false;
  return materials.some(receiverXYZMaterialEligible);
}

                                                                     
                                                                            
                                                                        
export function receiverXYZPassForCollect(pass = {}) {
  return { ...pass, kind: 'color' };
}

export function receiverXYZDepthCompare(reversedDepth = true) {
  return reversedDepth === false ? 'less-equal' : 'greater-equal';
}

export function receiverXYZClearDepth(reversedDepth = true) {
  return reversedDepth === false ? 1 : 0;
}

export function receiverXYZPass({
  xyzView,
  depthView,
  camera = null,
  frameBlock = null,
  width = 1,
  height = 1,
  reversedDepth = true,
  label = RECEIVER_XYZ_LABEL,
  layerMask = 1,
  filter = receiverXYZFilter,
} = {}) {
  if (!xyzView) throw Error('Receiver XYZ pass requires an rgba32float view');
  if (!depthView) throw Error('Receiver XYZ pass requires a depth view');
  return {
    label,
    kind: 'depth',
    camera,
    frameBlock,
    colorViews: [xyzView],
    colorFormats: [RECEIVER_XYZ_FORMAT],
    clearColors: [RECEIVER_XYZ_CLEAR_COLOR.slice()],
    depthView,
    depthFormat: 'depth32float',
    clearDepth: receiverXYZClearDepth(reversedDepth),
    depthCompare: receiverXYZDepthCompare(reversedDepth),
    depthCompareOverride: receiverXYZDepthCompare(reversedDepth),
    depthWriteOverride: true,
    layerMask,
    defines: { APS_RECEIVER_XYZ: 1 },
    apsReceiverXYZ: true,
    filter,
    cull: true,
    width,
    height,
  };
}

                                                                              
                                    
export function receiverXYZSampleIsValid(sample) {
  if (!sample || sample.length < 4) return false;
  const [x, y, z, valid] = sample;
  return valid >= 0.5 && Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z);
}
