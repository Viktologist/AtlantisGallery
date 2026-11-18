export const GRASS_POPULATION_WGSL=          `
struct Population {
 terrain:vec4f,shape:vec4u,eyeRadius:vec4f,domain:vec4f,
 root:vec4f,localMin:vec4f,localMax:vec4f,ids:vec4u,world:vec4i,
 interventionOriginSpacing:vec4f,interventionShapeEnabled:vec4f
}
@group(0) @binding(0) var<uniform> p:Population;
@group(0) @binding(1) var height:texture_2d<f32>;
@group(0) @binding(2) var planted:texture_2d<f32>;
@group(0) @binding(3) var<storage,read_write> matrices:array<mat4x4f>;
@group(0) @binding(4) var<storage,read_write> bounds:array<vec4f>;
@group(0) @binding(5) var<storage,read_write> blocks:array<u32>;
@group(0) @binding(6) var<storage,read_write> keys:array<u32>;
@group(0) @binding(8) var interventionMask:texture_2d<f32>;
// [0] initialized, [1..2] minimum world tile, [3] airborne, [4] epoch,
// [5] changed, [6] intervention version, [8..10] indirect dispatch, [11] total,
// [12+model] valid count.
@group(0) @binding(7) var<storage,read_write> state:array<atomic<u32>>;
fn hash32(value:u32)->f32{var h=value;h^=h>>16u;h*=2246822519u;h^=h>>13u;h*=3266489917u;h^=h>>16u;return f32(h>>8u)/16777216.;}
fn minTile()->vec2i{return vec2i(floor(floor(floor((p.eyeRadius.xz-p.eyeRadius.w)/4.)*4./p.root.x)/8.));}
fn native(q:vec2i)->f32{return textureLoad(height,clamp(q,vec2i(0),vec2i(p.shape.xy)-1),0).r;}
struct Surface {h:f32,slope:vec2f,normal:vec3f,valid:bool}
fn surfaceAt(xz:vec2f)->Surface {
 let g=(xz-p.terrain.xy)/p.terrain.zw;let ok=all(g>=vec2f(0))&&all(g<vec2f(p.shape.xy)-1.);
 let q=clamp(vec2i(floor(g)),vec2i(0),vec2i(p.shape.xy)-2);let f=g-vec2f(q);
 let a=native(q);let b=native(q+vec2i(1,0));let c=native(q+vec2i(0,1));let d=native(q+vec2i(1));
 let lower=f.x+f.y<=1.;let h=select(d*(f.x+f.y-1.)+b*(1.-f.y)+c*(1.-f.x),a*(1.-f.x-f.y)+b*f.x+c*f.y,lower);
 let slope=select(vec2f(d-c,d-b),vec2f(b-a,c-a),lower)/p.terrain.zw;
 return Surface(h,slope,normalize(vec3f(-slope.x,1,-slope.y)),ok);
}
fn interventionBlocked(xz:vec2f)->bool {
 if(p.interventionShapeEnabled.z<.5){return false;}
 let reg=p.interventionOriginSpacing;let shape=p.interventionShapeEnabled.xy;
 let g=(xz-reg.xy)/reg.zw;if(any(g<vec2f(0.))||any(g>shape-vec2f(1.))){return false;}
 let dims=vec2i(textureDimensions(interventionMask));
 let scale=(vec2f(dims)-vec2f(1.))/max(shape-vec2f(1.),vec2f(1.));
 let t=g*scale;let q=clamp(vec2i(floor(t)),vec2i(0),max(dims-vec2i(2),vec2i(0)));let f=clamp(t-vec2f(q),vec2f(0),vec2f(1));
 let a=textureLoad(interventionMask,q,0).r;let b=textureLoad(interventionMask,vec2i(min(q.x+1,dims.x-1),q.y),0).r;
 let c=textureLoad(interventionMask,vec2i(q.x,min(q.y+1,dims.y-1)),0).r;let d=textureLoad(interventionMask,vec2i(min(q.x+1,dims.x-1),min(q.y+1,dims.y-1)),0).r;
 return mix(mix(a,b,f.x),mix(c,d,f.x),f.y)>.5;
}
fn eligible(xz:vec2f)->bool {
 let uv=(xz-p.domain.xy)/p.domain.zw;if(any(uv<vec2f(0))||any(uv>=vec2f(1))){return false;}
 return textureLoad(planted,vec2i(uv*vec2f(textureDimensions(planted))),0).r>.5;
}
var<workgroup> heights:array<f32,64>;
@compute @workgroup_size(64) fn preparePopulation(@builtin(local_invocation_index) lane:u32){
 let tile=minTile();let lo=vec2f(tile*8)*p.root.x;let hi=lo+f32(p.shape.z*8u)*p.root.x;
 let a=clamp(vec2i(floor((lo-p.terrain.xy)/p.terrain.zw)),vec2i(0),vec2i(p.shape.xy)-1);
 let b=clamp(vec2i(ceil((hi-p.terrain.xy)/p.terrain.zw)),vec2i(0),vec2i(p.shape.xy)-1);let size=vec2u(b-a+1);
 var maximum=-1e30;for(var i=lane;i<size.x*size.y;i+=64u){maximum=max(maximum,native(a+vec2i(vec2u(i%size.x,i/size.x))));}
 heights[lane]=maximum;workgroupBarrier();
 for(var stride=32u;stride>0u;stride>>=1u){if(lane<stride){heights[lane]=max(heights[lane],heights[lane+stride]);}workgroupBarrier();}
 if(lane==0u){
  let air=u32(p.eyeRadius.y>heights[0]+p.eyeRadius.w);let interventionVersion=u32(p.interventionShapeEnabled.w);
  let changed=atomicLoad(&state[0])==0u||bitcast<i32>(atomicLoad(&state[1]))!=tile.x||bitcast<i32>(atomicLoad(&state[2]))!=tile.y||atomicLoad(&state[3])!=air||atomicLoad(&state[6])!=interventionVersion;
  atomicStore(&state[0],1u);atomicStore(&state[1],bitcast<u32>(tile.x));atomicStore(&state[2],bitcast<u32>(tile.y));atomicStore(&state[3],air);atomicStore(&state[5],u32(changed));atomicStore(&state[6],interventionVersion);
  atomicStore(&state[8],select(0u,p.shape.z*p.shape.z,changed));atomicStore(&state[9],1u);atomicStore(&state[10],1u);
  if(changed){atomicAdd(&state[4],1u);atomicStore(&state[11],0u);for(var row=0u;row<p.ids.z;row++){atomicStore(&state[12u+row],0u);}}
 }
}
var<workgroup> minima:array<vec3f,64>;
var<workgroup> maxima:array<vec3f,64>;
var<workgroup> validCounts:array<u32,64>;
fn positiveMod(a:vec2i,b:i32)->vec2i{return ((a%b)+b)%b;}
@compute @workgroup_size(64) fn generatePopulation(@builtin(workgroup_id) group:vec3u,@builtin(local_invocation_index) lane:u32){
 let id=group.x*64u+lane;let first=vec2i(bitcast<i32>(atomicLoad(&state[1])),bitcast<i32>(atomicLoad(&state[2])));
 let slot=vec2i(i32(group.x%p.shape.z),i32(group.x/p.shape.z));
 let tile=first+positiveMod(slot-first,i32(p.shape.z));let cell=tile*8+vec2i(i32(lane%8u),i32(lane/8u));
 let seed=(bitcast<u32>(cell.x)*1597334677u)^(bitcast<u32>(cell.y)*3812015801u)^p.ids.x;
 let xz=(vec2f(cell)+vec2f(hash32(seed+1u),hash32(seed+2u)))*p.root.x;let ground=surfaceAt(xz);
 var valid=atomicLoad(&state[3])==0u&&ground.valid&&eligible(xz)&&!interventionBlocked(xz)&&ground.h>=0.&&min(p.ids.z-1u,u32(floor(hash32(seed+4u)*f32(p.ids.z))))==p.ids.y;
 if(valid){
  for(var k=0u;k<8u;k++){
   let angle=f32(k)*0.7853981633974483;let delta=vec2f(cos(angle),sin(angle))*p.root.y;let probe=surfaceAt(xz+delta);
   if(!probe.valid||!eligible(xz+delta)||abs(probe.h-ground.h-dot(ground.slope,delta))>p.root.z){valid=false;break;}
  }
 }
 var m=mat4x4f(vec4f(0),vec4f(0),vec4f(0),vec4f(xz.x,ground.h,xz.y,1));var lo=vec3f(1e30);var hi=vec3f(-1e30);var key=0u;
 if(valid){
  let N=ground.normal;let T=normalize(vec3f(N.y,-N.x,0));let B=cross(T,N);let angle=hash32(seed+3u)*6.283185307179586;
  let X=cos(angle)*T+sin(angle)*B;let Z=cross(X,N);let P=vec3f(xz.x,ground.h,xz.y)-N*p.localMin.y;
  m=mat4x4f(vec4f(X,0),vec4f(N,0),vec4f(Z,0),vec4f(P,1));
  let c=(p.localMin.xyz+p.localMax.xyz)*.5;let e=(p.localMax.xyz-p.localMin.xyz)*.5;
  let center=(m*vec4f(c,1)).xyz;let extent=abs(X)*e.x+abs(N)*e.y+abs(Z)*e.z+vec3f(p.root.w);
  lo=center-extent;hi=center+extent;bounds[id*2u]=vec4f(center,0);bounds[id*2u+1u]=vec4f(extent,0);
  let world=cell-p.world.xy;key=u32(world.y)*u32(p.world.z)+u32(world.x)+1u;
  atomicAdd(&state[11],1u);atomicAdd(&state[12u+p.ids.y],1u);
 }else{bounds[id*2u]=vec4f(0,0,0,-1);bounds[id*2u+1u]=vec4f(0);}
 matrices[id]=m;keys[id]=key;
 minima[lane]=lo;maxima[lane]=hi;validCounts[lane]=u32(valid);workgroupBarrier();
 for(var stride=32u;stride>0u;stride>>=1u){if(lane<stride){minima[lane]=min(minima[lane],minima[lane+stride]);maxima[lane]=max(maxima[lane],maxima[lane+stride]);validCounts[lane]+=validCounts[lane+stride];}workgroupBarrier();}
 let at=group.x*72u;blocks[at+8u+lane]=id;
 if(lane==0u){
  let count=validCounts[0];var center=vec3f(0);var extent=vec3f(0);
  if(count>0u){center=(minima[0]+maxima[0])*.5;extent=max(center-minima[0],maxima[0]-center)+max(vec3f(1),max(abs(minima[0]),abs(maxima[0])))*2e-6;}
  blocks[at]=bitcast<u32>(center.x);blocks[at+1u]=bitcast<u32>(center.y);blocks[at+2u]=bitcast<u32>(center.z);blocks[at+3u]=64u;
  blocks[at+4u]=bitcast<u32>(extent.x);blocks[at+5u]=bitcast<u32>(extent.y);blocks[at+6u]=bitcast<u32>(extent.z);blocks[at+7u]=select(0u,0xffffffffu,count==0u);
 }
}
`;
