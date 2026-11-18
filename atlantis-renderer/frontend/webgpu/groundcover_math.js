                                                                           
                                                         
export function groundcoverRetention(distance,start,end,forced=-1){
 if(forced>=0)return Math.max(0,Math.min(1,forced));
 const t=Math.max(0,Math.min(1,(distance-start)/(end-start)));return 1-t*t*(3-2*t);
}
export function conditionalCover(c,q){return q>=1?0:c*(1-q)/Math.max(1-c*q,1e-8);}
                                                                          
                                                                            
export function groundcoverBoundsExcluded(bounds,data){
 if(!bounds||!data||data[6]<.5)return false;
 if(data[7]>=0)return data[7]===0;
 const [x,y,z,end,minY,maxY]=data;
 const dx=Math.max(bounds.min.x-x,x-bounds.max.x,0),dz=Math.max(bounds.min.z-z,z-bounds.max.z,0);
 const dy=Math.max(minY-y,y-maxY,0);
                                                                           
                                                                           
 const scale=Math.max(1,end,Math.abs(x),Math.abs(y),Math.abs(z),Math.abs(minY),Math.abs(maxY),
  ...['x','z'].flatMap(k=>[Math.abs(bounds.min[k]),Math.abs(bounds.max[k])]));
 return Math.hypot(dx,dy,dz)>=end+scale*32*1.1920928955078125e-7;
}
export const groundcoverWGSL=`
fn gcRetained(P:vec3f)->f32{
 if(gcParams.ready<.5){return 1.;}
 if(gcParams.forced>=0.){return clamp(gcParams.forced,0.,1.);}
 let nativeP=apsTerrainNativePosition(P);
 let ground=apsTerrainWorldPosition(vec3f(nativeP.x,terrainHeightAt(nativeP.xz),nativeP.z));
 let d=distance(ground,gcParams.eye);
 return 1.-smoothstep(gcParams.start,gcParams.end,d);
}
fn gcNoise(P:vec3f)->f32{
 // Stable world-space samples: no frame/camera/view/shadow-cascade seed.
 let p=vec3i(floor(P*2048.));
 var h=(bitcast<u32>(p.x)*1597334677u)^(bitcast<u32>(p.y)*3812015801u)^(bitcast<u32>(p.z)*2798796415u);
 h^=h>>16u;h*=2246822519u;h^=h>>13u;
 return f32(h>>8u)/16777216.;
}
fn gcVisible(P:vec3f)->bool{return gcNoise(P)<gcRetained(P);}
fn gcConditional(c:f32,q:f32)->f32{
 if(q>=1.){return 0.;}return c*(1.-q)/max(1.-c*q,1e-8);
}
`;
