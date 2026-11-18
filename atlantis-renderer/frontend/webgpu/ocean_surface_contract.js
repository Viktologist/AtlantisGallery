                                                                            
                                                                               
export const OCEAN_RECEIVER_SURFACE_WGSL =           `
struct OceanReceiverSurface {wet:f32,residue:f32};
struct OceanReceiverMaterial {baseColor:vec3f,roughness:f32,clearcoat:f32,clearcoatGloss:f32};
fn oceanReceiverWetWorld(P:vec3f)->f32 {
 if(shoreP.enabled==0u||shoreP.wetness==0u){return 0.0;}
 let current=oceanReceiverFragmentContact(P,0.06);
 if(!oceanBedKnown(P.xz)){return current;}
 let contact=1.0-smoothstep(0.05,0.2,abs(P.y-oceanBed(P.xz)));
 return max(current,shoreSimSample(P.xz).y*contact);
}
fn oceanReceiverSurface(P:vec3f,footprint:f32)->OceanReceiverSurface {
 return OceanReceiverSurface(oceanReceiverWetWorld(P),oceanReceiverResidueWorld(P,footprint));
}
// Sand has one pigment across the shoreline. Keep the accepted submerged
// residue response separate; wet roughness/coat still use the usual receiver.
fn terrainReceiverSandColor(P:vec3f,footprint:f32,color:vec3f)->vec3f {
 let residue=oceanReceiverResidueWorld(P,footprint)*(1.0-oceanBeachFoamBlend(P.xz));
 return mix(color,vec3f(0.82,0.85,0.84),residue);
}
// Shading-only color: the saved recipe/basecolor diagnostic remains unchanged.
// Persistent coarse wetness history is not the instantaneous waterline.
fn terrainReceiverShadeColor(P:vec3f,footprint:f32,color:vec3f)->vec3f {
 return color*mix(1.0,0.62,oceanReceiverFragmentContact(P,footprint));
}
fn oceanApplyReceiverMaterial(P:vec3f,footprint:f32,baseColor:vec3f,roughness:f32,coat:f32,gloss:f32)->OceanReceiverMaterial {
 let surface=oceanReceiverSurface(P,footprint);let wet=surface.wet;
 // Wetness affects surface finish only. Being below sea level must never
 // multiply or replace the receiver's substrate pigment.
 let color=baseColor;
 let rough=mix(roughness,max(0.065,roughness*0.42),wet);
 // Beach foam is a continuous overlay, never a white replacement of sand.
 let residue=surface.residue*(1.0-oceanBeachFoamBlend(P.xz));
 return OceanReceiverMaterial(mix(color,vec3f(0.82,0.85,0.84),residue),mix(rough,0.58,residue),max(coat,wet*0.45),mix(gloss,max(gloss,0.7),wet));
}
fn terrainReceiverWetnessWorld(P:vec3f)->f32{return oceanReceiverWetWorld(P);}
// Compatibility XZ entry: bed contact only. Consumers must use the world hook
// AFTER their recipe; folding this value into a moisture prior is not parity.
fn terrainReceiverWetness(xz:vec2f)->f32{return oceanReceiverWetWorld(vec3f(xz.x,oceanBed(xz),xz.y));}
fn terrainReceiverResidue(xz:vec2f)->f32 {if(shoreP.enabled==0u){return 0.0;}return shoreSimSample(xz).z;}
fn terrainReceiverFoam(P:vec3f,footprint:f32)->vec2f{return oceanBeachFoamWorld(P,footprint);}
`;

                                                                            
export function oceanSimulationStep(dt,paused){
 if(!Number.isFinite(dt)||dt<0)throw Error('Ocean expects finite nonnegative dt');
 return paused?0:Math.min(dt,0.1);
}
