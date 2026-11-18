export const SHALLOW_DEPTH_MODE=37;
                                                                         
                                                                                 
export function shoreShadowFadeDistance(value){return value;}
export function shallowDepthDisplayMax(value){return value;}
export const SHALLOW_DEPTH_COLORS=[
 [0,[.005,.02,.12]],[.25,[0,.3,.85]],[.5,[0,.7,.35]],[.75,[.95,.7,.015]],[1,[.9,.03,.005]],
];
export const OCEAN_SHALLOW_DEPTH_WGSL=`
fn terrainReceiverShallowDepth(P:vec3f)->vec2f {
 if(shoreP.enabled==0u||!oceanBedKnown(P.xz)||oceanPageSupport(P.xz).x<1e-5){return vec2f(0);}
 // Exactly the current column used by the foam-flow stage, including the
 // cached profile/support division. No independent visualization surface.
 let h=oceanPageWaterDepth(P.xz);return vec2f(h,select(0.0,1.0,h>=0.001));
}
fn oceanShallowDepthRamp(depth:f32,maximum:f32)->vec3f {
 let t=clamp(depth/max(0.01,maximum),0.0,1.0);
 ${SHALLOW_DEPTH_COLORS.slice(1).map(([stop,color],i)=>{
  const [previousStop,previous]=SHALLOW_DEPTH_COLORS[i];
  return `if(t<=${stop.toFixed(2)}){return mix(vec3f(${previous.join(',')}),vec3f(${color.join(',')}),(t-${previousStop.toFixed(2)})/${(stop-previousStop).toFixed(2)});}`;
 }).join('\n ')}
 return vec3f(${SHALLOW_DEPTH_COLORS.at(-1)[1].join(',')});
}
fn terrainReceiverShallowDepthColor(P:vec3f)->vec3f {
 let water=terrainReceiverShallowDepth(P);if(water.y<=0.0){return vec3f(0.12);}
 return oceanShallowDepthRamp(water.x,oceanReceiverP.depthDisplayMax);
}
`;
