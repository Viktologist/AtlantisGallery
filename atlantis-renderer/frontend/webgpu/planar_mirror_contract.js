                                                                                  
export const PLANAR_MIRROR_KEY='aps_planar_mirror';
export function mirrorOptions(value){
 if(value===false)return false;if(value===true)return {};
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('aps_planar_mirror must be false, true or an options object');
 const allowed=['normal','point','tint','clipBias','tolerance'];
 if(Object.keys(value).some(k=>!allowed.includes(k)))throw Error('Unknown aps_planar_mirror option');
 for(const key of ['normal','point','tint'])if(key in value){const a=value[key];if(!Array.isArray(a)||a.length!==3||!a.every(Number.isFinite))throw Error(`aps_planar_mirror.${key} requires three finite numbers`);if(key==='normal'&&a.reduce((s,v)=>s+v*v,0)<1e-16)throw Error('Mirror normal must be nonzero');if(key==='tint'&&a.some(v=>v<0))throw Error('Mirror tint must be nonnegative');}
 for(const key of ['clipBias','tolerance'])if(key in value&&(!Number.isFinite(value[key])||value[key]<0))throw Error(`aps_planar_mirror.${key} must be finite and nonnegative`);
 return {...value};
}
export function primitiveMirror(nodeExtras,mesh,primitive){
 const key=PLANAR_MIRROR_KEY;
 if(Object.hasOwn(primitive.extras??{},key))return mirrorOptions(primitive.extras[key]);
 for(const extras of [mesh.extras??{},nodeExtras??{}])if(Object.hasOwn(extras,key)){
  const value=mirrorOptions(extras[key]);
  if(value!==false&&mesh.primitives.length!==1)throw Error('Multi-primitive mirror must mark each reflective primitive explicitly');
  return value;
 }
 return undefined;
}
