                                                                            
export const OCEAN_REFRACTION_RECEIVER_WGSL=        `
fn apsOceanTransmissionBlend(mediumOnly:vec3f,straight:vec3f,straightCoverage:f32,refracted:vec3f,coverage:f32)->vec3f {
 // Receiver confidence is sampling support, not water opacity. Normalize valid
 // colour weights; spatial wet coverage is applied once by the surface shader.
 let bentWeight=clamp(coverage,0.0,1.0);
 let straightWeight=(1.0-bentWeight)*clamp(straightCoverage,0.0,1.0);
 let totalWeight=straightWeight+bentWeight;
 if(totalWeight<=1e-6){return mediumOnly;}
 return (straight*straightWeight+refracted*bentWeight)/totalWeight;
}
fn apsOceanReceiverGate(gap:f32,behind:f32,coverage:f32)->f32 {
 if(behind<=0.0001){return 0.0;}
 return smoothstep(0.0001,0.0003,gap)*coverage;
}
fn apsOceanContactGate(gap:f32,tolerance:f32,coverage:f32)->f32 {
 return smoothstep(-tolerance,tolerance,gap)*coverage;
}
fn apsOceanDepthTolerance(depthError:f32,worldScale:f32)->f32 {
 // Four encoded-depth ULPs plus eight float32 world-coordinate ULPs.
 return max(depthError*4.0,max(1.0,worldScale)*0.00000095367431640625);
}
fn apsOceanReceiverTolerance(start:vec3f,world:vec3f,uv:vec2f,depth:f32)->f32 {
 let nextDepth=bitcast<f32>(bitcast<u32>(depth)+1u);
 let nextWorld=oceanRefractionWorld(uv,nextDepth);
 let scale=max(length(start-frame.cameraPos),max(length(start),length(world)));
 return apsOceanDepthTolerance(length(nextWorld-world),scale);
}
fn apsOceanReceiverWater(world:vec3f,footprint:f32,contactTolerance:f32)->f32 {
 // Invert horizontal displacement just as the fragment wet-contact query does.
 // Wet-sand history and the wetness UI switch do not describe water occupancy.
 var q=world.xz;
 // Uniform bound keeps drivers from expanding this expensive shore/FFT query
 // into every neighbour and trace branch. The adapter always supplies five.
 for(var i=0;i<i32(oceanRefr.receiverIterations);i++){let d=oceanCompositeDisplacement(q,footprint).xyz;q=world.xz-d.xz;}
 let height=frame.seaLevel+oceanCompositeDisplacement(q,footprint).y;
 let coverage=oceanAnimatedShoreCoverage(world.xz,footprint,max(0.003,footprint*0.5));
 if(contactTolerance>0.0){return apsOceanContactGate(height-world.y,contactTolerance,coverage);}
 return apsOceanReceiverGate(height-world.y,1.0,coverage);
}
fn apsOceanReceiverRadiance(start:vec3f,hit:vec3f,uv:vec2f,tolerance:f32,matchHit:bool)->APSOceanRay {
 let dimensions=vec2i(textureDimensions(waterRefrDepth));let size=vec2f(dimensions);
 let q=uv*size-0.5;let base=vec2i(floor(q));let f=fract(q);
 let eye=normalize(start-frame.cameraPos);
 var colour=vec3f(0);var coverage=0.0;var path=0.0;
 for(var i=0;i<4;i++) {
  let corner=vec2i(i%2,i/2);let pixel=base+corner;
  // Do not clamp a missing neighbour into a duplicated edge texel.
  if(any(pixel<vec2i(0))||any(pixel>=dimensions)){continue;}
  let depth=textureLoad(waterRefrDepth,pixel,0).x;if(depth<=0.0){continue;}
  let sampleUV=(vec2f(pixel)+0.5)/size;let world=oceanRefractionWorld(sampleUV,depth);
  let behind=dot(world-start,eye);var uncertainty=0.0;
  if(matchHit){if(behind<=0.0001){continue;}}
  else {
   // Only the straight fallback may accept depth-coincident contact within
   // reconstruction precision. Bent taps keep strict foreground rejection.
   uncertainty=apsOceanReceiverTolerance(start,world,sampleUV,depth);
   if(behind < -uncertainty){continue;}
  }
  let w=mix(1.0-f,f,vec2f(corner));var weight=w.x*w.y;
  if(matchHit){weight*=1.0-smoothstep(tolerance,tolerance*4.0,length(world-hit));}
  if(weight<=0.0){continue;}
  let footprint=max(0.0001,length(world-frame.cameraPos)*2.0*max(abs(oceanRefr.inverseProjection[0][0])/size.x,abs(oceanRefr.inverseProjection[1][1])/size.y));
  weight*=apsOceanReceiverWater(world,footprint,uncertainty);
  // Exact colour texel paired with this depth: a filtered colour lookup here
  // could reintroduce a rejected dry/foreground neighbour at a silhouette.
  colour+=textureLoad(waterRefrColor,pixel,0).rgb*weight;
  coverage+=weight;path+=length(world-start)*weight;
 }
 if(coverage<=1e-6){return APSOceanRay(vec3f(0),0.0,180.0);}
 return APSOceanRay(colour/coverage,clamp(coverage,0.0,1.0),min(180.0,path/coverage));
}
fn apsOceanUndistortedReceiver(P:vec3f)->APSOceanRay {
 let source=apsOceanProject(P);
 if(source.z<=0.0||!oceanRefractionInside(source.xy)){return APSOceanRay(vec3f(0),0.0,180.0);}
 return apsOceanReceiverRadiance(P,P,source.xy,1.0,false);
}
`;
