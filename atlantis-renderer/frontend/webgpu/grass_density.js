                                                                           
                                                                                
                                                                              
export const DEFAULT_GRASS_RETENTION=1;
export const GRASS_DENSITY_RANGE=Object.freeze([2,8]);
export function validateGrassRetention(value){
 if(!Number.isFinite(value)||value<0||value>1)throw RangeError('Grass retention must be between 0 and 1');
 return value;
}
export function grassDensityRank(key){
 let h=(key^2654435769)>>>0;h^=h>>>16;h=Math.imul(h,2246822519);h^=h>>>13;h=Math.imul(h,3266489917);h^=h>>>16;
 return (h>>>8)/16777216;
}
export function grassDensityUniforms(system,viewer=null){
 viewer??=system.population?.viewer??system.screenGrass?.viewer;
 const retention=system.isGrass?validateGrassRetention(system.grassDensityRetention??viewer?.grassDensityRetention??1):1;
 const eye=viewer?.camera?.position;
 return {eye:[eye?.x??0,eye?.y??0,eye?.z??0,Number(retention<1)],policy:[1,retention,...GRASS_DENSITY_RANGE]};
}
export const GRASS_DENSITY_WGSL=          `
fn apsGrassDensityRank(key:u32)->f32{
 var h=key^2654435769u;h^=h>>16u;h*=2246822519u;h^=h>>13u;h*=3266489917u;h^=h>>16u;
 return f32(h>>8u)/16777216.;
}
fn apsGrassDensityKeep(key:u32,P:vec3f,eye:vec4f,policy:vec4f)->bool{
 if(eye.w==0.){return true;}
 let t=clamp((distance(P,eye.xyz)-policy.z)/max(.001,policy.w-policy.z),0.,1.);
 let retention=mix(policy.x,policy.y,t*t*(3.-2.*t));
 return apsGrassDensityRank(key)<retention;
}
`;
