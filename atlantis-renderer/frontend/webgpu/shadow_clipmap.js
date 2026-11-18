import {Matrix4,Vector3} from '../../vendor/tidewater/src/engine/math/index.js';
import {orthoStandardZ} from '../../vendor/tidewater/src/engine/render/Shadows.js';

                                                                          
                                                                               
export function fitShadowClipmaps(bounds,eye,sun,size,count=4){
  if((count!==4&&count!==1)||size<1||!bounds||![...bounds.min,...bounds.max,...eye,...sun].every(Number.isFinite)||bounds.min.some((v,i)=>v>bounds.max[i]))throw Error('Invalid shadow clipmap domain');
  const L=new Vector3(...sun).normalize();
  const basis=new Matrix4().lookAt(L,new Vector3(),new Vector3(...(Math.abs(L.y)>.99?[1,0,0]:[0,1,0])));
  const inverse=basis.clone().invert(),low=new Vector3(Infinity,Infinity,Infinity),high=new Vector3(-Infinity,-Infinity,-Infinity);
  for(const x of [bounds.min[0],bounds.max[0]])for(const y of [bounds.min[1],bounds.max[1]])for(const z of [bounds.min[2],bounds.max[2]]){
    const p=new Vector3(x,y,z).applyMatrix4(inverse);low.min(p);high.max(p);
  }
  const mapRadius=Math.max(8,Math.max(high.x-low.x,high.y-low.y)*.5);
                                                                               
  const globalRadius=Math.ceil((mapRadius+Math.max(8,mapRadius*64/size))*16)/16;
  const center=low.clone().add(high).multiplyScalar(.5),local=new Vector3(...eye).applyMatrix4(inverse);
  const singleRadius=Math.max(.001,.56*Math.max(high.x-low.x,high.y-low.y));
  const padding=count===1?Math.max(.002,singleRadius*.12):8;
  const near=count===1?padding*.1:.1,far=high.z-low.z+2*padding;
  return (count===1?[1]:[1/64,1/16,1/4,1]).map((scale,i)=>{
    const radius=count===1?singleRadius:Math.max(2,globalRadius*scale),texel=2*radius/size;
    const anchor=i===count-1?center:local;
    const x=Math.round(anchor.x/texel)*texel,y=Math.round(anchor.y/texel)*texel;
    const world=basis.clone().setPosition(new Vector3(x,y,high.z+padding).applyMatrix4(basis));
    const view=world.clone().invert(),projection=orthoStandardZ(new Matrix4(),-radius,radius,radius,-radius,near,far);
    return {radius,texel,near,far,world,view,projection,viewProj:new Matrix4().multiplyMatrices(projection,view),
      lightCenter:[x,y],lightEye:[local.x,local.y],projectionKey:JSON.stringify([radius,high.z,far,...L.toArray()]),
      key:JSON.stringify([x,y,radius,high.z,far,...L.toArray()])};
  });
}

                                                                                
export function clipmapShadowCode(code){
  if(code.includes('fn apsShadowClipEdge'))return code;
  function replace(name,replacement){
    const start=code.indexOf('fn '+name+'(');if(start<0)throw Error('Missing shadow function '+name);
    let end=code.indexOf('{',start)+1,depth=1;
    while(depth&&end<code.length){if(code[end]==='{')depth++;if(code[end]==='}')depth--;end++;}
    if(depth)throw Error('Unclosed shadow function '+name);code=code.slice(0,start)+replacement+code.slice(end);
  }
  replace('_sunShadowCascade',`fn _sunShadowCascade(P:vec3f,N:vec3f,c:i32,noise:f32,pcfNoise:f32,pcss:bool)->f32 {
    let info=shadowParams.cascades[c];let sc=shadowParams.matrices[c]*vec4f(P+N*info.z,1.0);
    let uv=vec2f(sc.x*.5+.5,.5-sc.y*.5);
    if(any(uv<vec2f(0))||any(uv>vec2f(1))||sc.z<0.0||sc.z>1.0){return 1.0;}
    let planeN=select(N,apsShadowPlaneNormal,dot(apsShadowPlaneNormal,apsShadowPlaneNormal)>.5);
    let z=sc.z-max(shadowParams.bias,max(2e-7,(.005+.1*info.y)/info.w));let gradient=apsShadowReceiverGradient(planeN,c);
    let texel=1.0/shadowParams.mapSize;
    if(pcss&&u32(c)<shadowParams.pcssCascades){
      // Subtract the receiver plane at each blocker tap. A tilted unoccluded
      // surface is not a blocker and must not invent a large penumbra.
      let phi=noise*TWO_PI;let searchUV=max(min(30.0*shadowParams.sunAngularDiameter/info.x,texel*24.0),texel*1.5);
      var deltaSum=apsShadowBlockerDelta(uv,c,z,gradient);var blocks=select(0.0,1.0,deltaSum>0.0);
      for(var k=0;k<SHADOW_SEARCH_TAPS;k++){
        let offset=vogelDiskSample(k,SHADOW_SEARCH_TAPS,phi)*searchUV;
        let d=apsShadowBlockerDelta(uv+offset,c,z+dot(gradient,offset),gradient);
        if(d>0.0){deltaSum+=d;blocks+=1.0;}
      }
      if(blocks<.5){return 1.0;}
      let radius=clamp(deltaSum/blocks*info.w*shadowParams.sunAngularDiameter/info.x,texel*1.2,.12);
      var sum=0.0;
      for(var k=0;k<SHADOW_FILTER_TAPS;k++){
        let offset=vogelDiskSample(k,SHADOW_FILTER_TAPS,phi+1.7)*radius;
        sum+=apsShadowCompare(uv+offset,c,z+dot(gradient,offset),gradient);
      }
      return sum/f32(SHADOW_FILTER_TAPS);
    }
    var sum=0.0;
    for(var k=0;k<5;k++){
      let offset=vogelDiskSample(k,5,pcfNoise*TWO_PI)*texel;
      sum+=apsShadowCompare(uv+offset,c,z+dot(gradient,offset),gradient);
    }
    return sum/5.0;
  }`);
  replace('sunShadowCascadeHard',`fn sunShadowCascadeHard(P:vec3f,c:i32)->f32 {
    let sc=shadowParams.matrices[c]*vec4f(P,1.0);let uv=vec2f(sc.x*.5+.5,.5-sc.y*.5);
    if(any(uv<vec2f(0))||any(uv>vec2f(1))||sc.z<0.0||sc.z>1.0){return 1.0;}
    return apsShadowCompare(uv,c,sc.z-max(shadowParams.bias,max(2e-7,.005/shadowParams.cascades[c].w)),vec2f(0));
  }`);
  replace('_sunShadow',`fn _sunShadow(P:vec3f,N:vec3f,pixel:vec2f,pcss:bool)->f32 {
    if(shadowParams.enabled<.5){return 1.0;}
    let noise=interleavedGradientNoise(P.xz*.5);
    for(var i=0;i<i32(shadowParams.count);i++){
      let edge=apsShadowClipEdge(P,i);if(edge<0.0){continue;}
      let value=_sunShadowCascade(P,N,i,noise,noise,pcss);
      if(i==i32(shadowParams.count)-1||edge>=.15){return value;}
      // A translated local square need not be contained by the next local one.
      // Search outward until a covering level is found, with the global map last.
      for(var j=i+1;j<i32(shadowParams.count);j++){
        if(apsShadowClipEdge(P,j)>=0.0){return mix(_sunShadowCascade(P,N,j,noise,noise,pcss),value,smoothstep(0.0,.15,edge));}
      }
      return value;
    }
    return 1.0;
  }`);
  replace('sunShadowHard',`fn sunShadowHard(P:vec3f)->f32 {
    if(shadowParams.enabled<.5){return 1.0;}
    for(var i=0;i<i32(shadowParams.count);i++){
      let edge=apsShadowClipEdge(P,i);if(edge<0.0){continue;}
      let value=sunShadowCascadeHard(P,i);if(edge>=.15||i==i32(shadowParams.count)-1){return value;}
      for(var j=i+1;j<i32(shadowParams.count);j++){
        if(apsShadowClipEdge(P,j)>=0.0){return mix(sunShadowCascadeHard(P,j),value,smoothstep(0.0,.15,edge));}
      }
      return value;
    }
    return 1.0;
  }`);
  return code+`\nfn apsShadowClipEdge(P:vec3f,c:i32)->f32 {
    let sc=shadowParams.matrices[c]*vec4f(P,1.0);
    if(sc.z<0.0||sc.z>1.0){return -1.0;}
    return (1.0-max(abs(sc.x),abs(sc.y)))*.5;
  }
fn apsShadowReceiverGradient(N:vec3f,c:i32)->vec2f {
  let m=shadowParams.matrices[c];let info=shadowParams.cascades[c];
  let n=vec3f(dot(vec3f(m[0].x,m[1].x,m[2].x),N)*info.x*.5,
              dot(vec3f(m[0].y,m[1].y,m[2].y),N)*info.x*.5,
             -dot(vec3f(m[0].z,m[1].z,m[2].z),N)*info.w);
  let nz=select(-1.0,1.0,n.z>=0.0)*max(abs(n.z),1e-4);
  return vec2f(n.x,-n.y)/nz*(info.x/info.w);
}
fn apsShadowCompare(uv:vec2f,c:i32,z:f32,gradient:vec2f)->f32 {
  let dim=vec2f(textureDimensions(sunShadowMap));let p=uv*dim-.5;let q=vec2i(floor(p));let f=fract(p);
  var result=0.0;
  for(var y=0;y<2;y++){for(var x=0;x<2;x++){
    let pixel=clamp(q+vec2i(x,y),vec2i(0),vec2i(dim)-1);
    let center=(vec2f(pixel)+.5)/dim;let reference=z+dot(gradient,center-uv);
    let depth=textureLoad(sunShadowMap,pixel,c,0);
    let weight=select(1.0-f.x,f.x,x==1)*select(1.0-f.y,f.y,y==1);
    result+=weight*select(0.0,1.0,reference<=depth);
  }}
  return result;
}
fn apsShadowBlockerDelta(uv:vec2f,c:i32,z:f32,gradient:vec2f)->f32 {
  let dim=vec2f(textureDimensions(sunShadowMap));let pixel=clamp(vec2i(uv*dim),vec2i(0),vec2i(dim)-1);
  let center=(vec2f(pixel)+.5)/dim;
  return max(0.0,z+dot(gradient,center-uv)-textureLoad(sunShadowMap,pixel,c,0));
}
var<private> apsShadowPlaneNormal:vec3f=vec3f(0);
fn sunShadowTerrain(P:vec3f,offsetN:vec3f,planeN:vec3f,pixel:vec2f,nativeOffset:f32)->f32 {
  // Offset follows the continuous normal. Comparison depth follows the actual
  // native triangle plane; interpolated shading normals cannot fit that plane.
  apsShadowPlaneNormal=planeN;let visibility=sunShadow(P+offsetN*nativeOffset,offsetN,pixel);apsShadowPlaneNormal=vec3f(0);return visibility;
}`;
}
