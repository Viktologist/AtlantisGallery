import {GRASS_DENSITY_WGSL} from './grass_density.js';
import {GRASS_NEAR_SAMPLE_STEP} from './vegetation_area.js';
import {GRASS_PROJECTION_DENSITY_WGSL} from './grass_projection_density.js';
export const GRASS_SCREEN_WGSL=          `
${GRASS_DENSITY_WGSL}
struct GrassSample {
 inverse:mat4x4f,vp:mat4x4f,screen:vec4f,maskRect:vec4f,
 localMin:vec4f,localMax:vec4f,scale:vec4f,terrain:vec4f,shape:vec4f,policy:vec4f,sampling:vec4f,anchor:vec4f,tiles:vec4u,densityEye:vec4f,densityPolicy:vec4f,
 near:vec4u, // near grid width/height, output offset, native source capacity (0 = far input)
 nearDensity:vec4f, // imported bbox target root area, enabled, reserved, reserved
 interventionOriginSpacing:vec4f,interventionShapeEnabled:vec4f
}
@group(0) @binding(0) var<uniform> p:GrassSample;
@group(0) @binding(1) var sampleDepth:texture_depth_2d;
@group(0) @binding(2) var nativeHeight:texture_2d<f32>;
@group(0) @binding(3) var plantedMask:texture_2d<f32>;
@group(0) @binding(4) var<storage,read_write> grassMatrices:array<mat4x4f>;
@group(0) @binding(5) var<storage,read_write> commands:array<atomic<u32>>;
// Per screen bin: eligibility, nearest positive reversed-Z, world ID.
// Far bins are followed by near collision bins; density is projected in world space.
@group(0) @binding(6) var<storage,read_write> pixels:array<atomic<u32>>;
@group(0) @binding(7) var<storage,read_write> grassKeys:array<u32>;
// Bind world tile bounds for far work; native matrices for near work. Reusing
// these two input slots keeps both routes within seven storage bindings.
@group(0) @binding(8) var<storage,read> tileBounds:array<vec4f>;
// First three words are copied to a separate indirect-dispatch buffer.
@group(0) @binding(9) var<storage,read_write> queue:array<atomic<u32>>;
@group(0) @binding(10) var pyramid:texture_2d<f32>;
@group(0) @binding(11) var<storage,read_write> pixelMask:array<u32>;
@group(0) @binding(12) var interventionMask:texture_2d<f32>;
fn screenBin(pixel:vec2u)->u32{let q=pixel/u32(p.sampling.x);return (q.y*u32(p.screen.z)+q.x)*3u;}
fn grassHash(value:u32)->f32{var h=value;h^=h>>16u;h*=2246822519u;h^=h>>13u;h*=3266489917u;h^=h>>16u;return f32(h>>8u)/16777216.;}
fn heightTex(q:vec2i)->f32{return textureLoad(nativeHeight,clamp(q,vec2i(0),vec2i(p.shape.xy)-1),0).r;}
fn grassHeight(xz:vec2f)->f32{
 let grid=clamp((xz-p.terrain.xy)/p.terrain.zw,vec2f(0),p.shape.xy-1.);
 let q=min(vec2i(floor(grid)),vec2i(p.shape.xy)-2);let f=grid-vec2f(q);
 let a=heightTex(q);let b=heightTex(q+vec2i(1,0));let c=heightTex(q+vec2i(0,1));let d=heightTex(q+vec2i(1));
 if(f.x+f.y<=1.){return a*(1.-f.x-f.y)+b*f.x+c*f.y;}
 return d*(f.x+f.y-1.)+b*(1.-f.y)+c*(1.-f.x);
}
fn grassNormal(xz:vec2f)->vec3f{
 let dx=vec2f(p.terrain.z,0);let dz=vec2f(0,p.terrain.w);
 return normalize(vec3f(-(grassHeight(xz+dx)-grassHeight(xz-dx))/(2.*p.terrain.z),1.,-(grassHeight(xz+dz)-grassHeight(xz-dz))/(2.*p.terrain.w)));
}
fn grassPlanted(xz:vec2f)->bool{
 let uv=(xz-p.maskRect.xy)/p.maskRect.zw;
 if(any(uv<vec2f(0))||any(uv>=vec2f(1))){return false;}
 return textureLoad(plantedMask,vec2i(uv*vec2f(textureDimensions(plantedMask))),0).r>.5;
}
// Root-XZ intervention gate. It runs before depth competition and before any
// near/far candidate can write a grid winner, so a modified root cannot ghost.
fn interventionBlocked(xz:vec2f)->bool{
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
fn seedOf(cell:vec2i)->u32{return (bitcast<u32>(cell.x)*1597334677u)^(bitcast<u32>(cell.y)*3812015801u)^bitcast<u32>(p.policy.z);}
fn matrixAt(P:vec3f,seed:u32)->mat4x4f{
 if(p.near.x>0u){
  // The GPU population's exact native triangle frame/yaw. Both bands classify
  // the same original world plant, so changing bands cannot duplicate its ID
  // or change its pose. Leaf geometry/UVs remain untouched.
  let g=(P.xz-p.terrain.xy)/p.terrain.zw;let q=clamp(vec2i(floor(g)),vec2i(0),vec2i(p.shape.xy)-2);let f=g-vec2f(q);
  let a=heightTex(q);let b=heightTex(q+vec2i(1,0));let c=heightTex(q+vec2i(0,1));let d=heightTex(q+vec2i(1));
  let slope=select(vec2f(d-c,d-b),vec2f(b-a,c-a),f.x+f.y<=1.)/p.terrain.zw;
  let N=normalize(vec3f(-slope.x,1,-slope.y));let T=normalize(vec3f(N.y,-N.x,0));let B=cross(T,N);let angle=grassHash(seed+3u)*6.283185307179586;
  let X=cos(angle)*T+sin(angle)*B;let Z=cross(X,N);
  return mat4x4f(vec4f(X,0),vec4f(N,0),vec4f(Z,0),vec4f(P-N*p.localMin.y,1));
 }
 let N=normalize(grassNormal(P.xz)+vec3f((grassHash(seed+8u)-.5)*.08,0.,(grassHash(seed+9u)-.5)*.08));
 let axis=select(vec3f(0,1,0),vec3f(1,0,0),abs(N.y)>.9);
 let T=normalize(cross(axis,N));let B=cross(T,N);let angle=grassHash(seed+7u)*6.283185307;
 let X=(cos(angle)*T+sin(angle)*B)*p.scale.x;let Y=N*p.scale.y;let Z=cross(X,N)*p.scale.z/max(length(X),1e-8);
 return mat4x4f(vec4f(X,0),vec4f(Y,0),vec4f(Z,0),vec4f(P-Y*p.localMin.y,1));
}
fn pointOf(cell:vec2i)->vec3f{
 let seed=seedOf(cell);let xz=(vec2f(cell)+vec2f(grassHash(seed+1u),grassHash(seed+2u)))*p.anchor.x;
 return vec3f(xz.x,grassHeight(xz),xz.y);
}
struct Projection {lo:vec3f,hi:vec3f,near:bool,outside:bool}
fn project(center:vec3f,extent:vec3f)->Projection{
 var lo=vec3f(1e30);var hi=vec3f(-1e30);var near=false;var outside=array<bool,6>(true,true,true,true,true,true);
 for(var k=0u;k<8u;k++){
  let s=vec3f(select(-1.,1.,(k&1u)!=0u),select(-1.,1.,(k&2u)!=0u),select(-1.,1.,(k&4u)!=0u));let c=p.vp*vec4f(center+extent*s,1.);
  outside[0]=outside[0]&&c.x < -c.w;outside[1]=outside[1]&&c.x>c.w;outside[2]=outside[2]&&c.y < -c.w;outside[3]=outside[3]&&c.y>c.w;outside[4]=outside[4]&&c.z<0.;outside[5]=outside[5]&&c.z>c.w;
  near=near||c.w<=1e-6||c.z<0.||c.z>c.w;let q=c.xyz/max(c.w,1e-6);let pixel=vec3f((q.x*.5+.5)*p.screen.x,(.5-q.y*.5)*p.screen.y,q.z);lo=min(lo,pixel);hi=max(hi,pixel);
 }
 var reject=false;for(var i=0u;i<6u;i++){reject=reject||outside[i];}return Projection(lo,hi,near,reject);
}
fn projectedMatrix(m:mat4x4f)->Projection{
 let c=(p.localMin.xyz+p.localMax.xyz)*.5;let e=(p.localMax.xyz-p.localMin.xyz)*.5;
 return project((m*vec4f(c,1)).xyz,abs(m[0].xyz)*e.x+abs(m[1].xyz)*e.y+abs(m[2].xyz)*e.z+vec3f(p.localMin.w));
}
fn area(b:Projection)->f32{if(b.near){return 1e30;}return max(b.hi.x-b.lo.x,0.)*max(b.hi.y-b.lo.y,0.);}
${GRASS_PROJECTION_DENSITY_WGSL}
fn hidden(b:Projection)->bool{
 if(b.near||b.outside){return false;}
 let lo=clamp(b.lo.xy,vec2f(0),p.screen.xy-.001);let hi=clamp(b.hi.xy,vec2f(0),p.screen.xy-.001);
 let mip=min(i32(textureNumLevels(pyramid))-1,i32(ceil(log2(max(1.,max(hi.x-lo.x,hi.y-lo.y))))));
 let scale=exp2(f32(mip));let dims=vec2i(textureDimensions(pyramid,mip));let a=clamp(vec2i(floor(lo/scale)),vec2i(0),dims-1);let z=clamp(vec2i(floor(hi/scale)),vec2i(0),dims-1);
 let far=min(min(textureLoad(pyramid,a,mip).r,textureLoad(pyramid,vec2i(z.x,a.y),mip).r),min(textureLoad(pyramid,vec2i(a.x,z.y),mip).r,textureLoad(pyramid,z,mip).r));
 let offset=length(vec3f(p.vp[0][2],p.vp[1][2],p.vp[2][2]));let d=max(far,b.hi.z)+offset;
 let bias=d*d*.02/(max(p.sampling.z,1e-6)*(1.+offset))+d*9.536743e-7;
 return b.hi.z<far-bias;
}
@compute @workgroup_size(1) fn resetGrass(){
 atomicStore(&commands[1],0u);for(var i=5u;i<18u;i++){atomicStore(&commands[i],0u);}
 atomicStore(&commands[19],0u);for(var i=23u;i<32u;i++){atomicStore(&commands[i],0u);}
 atomicStore(&queue[0],0u);atomicStore(&queue[1],1u);atomicStore(&queue[2],1u);atomicStore(&queue[3],0u);
}
@compute @workgroup_size(8,8) fn maskGrass(@builtin(global_invocation_id) id:vec3u){
 if(any(id.xy>=vec2u(p.screen.xy))){return;}let at=id.y*u32(p.screen.x)+id.x;
 pixelMask[at]=0u;
 if(p.policy.w==0.){return;}let depth=textureLoad(sampleDepth,vec2i(id.xy),0);if(depth<=0.){return;}
 let uv=(vec2f(id.xy)+.5)/p.screen.xy;let h=p.inverse*vec4f(uv.x*2.-1.,1.-uv.y*2.,depth,1.);let P=h.xyz/h.w;
 if(interventionBlocked(P.xz)||!grassPlanted(P.xz)||P.y<p.shape.z){return;}
 let a=area(projectedMatrix(matrixAt(P,seedOf(vec2i(floor(P.xz/p.anchor.x))))));
 if(a<=p.sampling.w||a>=p.policy.x){return;}pixelMask[at]=1u;atomicAdd(&commands[5],1u);
 if(atomicOr(&pixels[screenBin(id.xy)],1u)==0u){atomicAdd(&commands[15],1u);}
}
@compute @workgroup_size(8,8) fn clearGrassBins(@builtin(global_invocation_id) id:vec3u){
 if(all(id.xy<vec2u(p.screen.zw))){let at=(id.y*u32(p.screen.z)+id.x)*3u;
  atomicStore(&pixels[at],0u);atomicStore(&pixels[at+1u],0u);atomicStore(&pixels[at+2u],0xffffffffu);}
 if(all(id.xy<p.near.xy)){let at=(p.near.z+id.y*p.near.x+id.x)*3u;
  atomicStore(&pixels[at],0u);atomicStore(&pixels[at+1u],0u);atomicStore(&pixels[at+2u],0xffffffffu);}
}
@compute @workgroup_size(64) fn selectGrassTiles(@builtin(global_invocation_id) id:vec3u){
 if(id.x>=p.tiles.x*p.tiles.y||p.policy.w==0.){return;}let c=tileBounds[id.x*2u];let e=tileBounds[id.x*2u+1u].xyz;if(c.w==0.){return;}
 let w=vec3f(p.vp[0][3],p.vp[1][3],p.vp[2][3]);let nearest=(p.vp*vec4f(c.xyz,1.)).w-dot(abs(w),e);
 if(nearest>p.policy.y){atomicAdd(&commands[11],1u);return;}
 let b=project(c.xyz,e);if(b.outside){atomicAdd(&commands[9],1u);return;}if(hidden(b)){atomicAdd(&commands[10],1u);return;}
 // Unresolved far patches have a fixed minimum display footprint. Bound the
 // candidate lattice to roughly one point per pixel, in world-cell powers of two,
 // rather than enumerating thousands of indistinguishable roots per pixel.
 // Retained roots keep their original IDs/positions; no screen-following seeds.
 var shift=0u;
 if(p.sampling.y>0.&&!b.near){
  let span=max(b.hi.x-b.lo.x,b.hi.y-b.lo.y);
  shift=u32(clamp(floor(log2(64./max(1.,span))),0.,4.));
 }
 let groups=max(1u,64u>>(shift*2u));let slot=atomicAdd(&queue[3],groups);
 for(var row=0u;row<groups;row++){atomicStore(&queue[4u+slot+row],id.x|(shift<<20u)|(row<<23u));}
 atomicAdd(&commands[17],1u);
}
@compute @workgroup_size(1) fn dispatchGrassTiles(){let n=atomicLoad(&queue[3]);atomicStore(&queue[0],min(n,p.tiles.z));atomicStore(&queue[2],max(1u,(n+p.tiles.z-1u)/p.tiles.z));}
struct Candidate {key:u32,pixel:u32,depth:u32}
fn nativeMatrix(index:u32)->mat4x4f{let at=index*4u;return mat4x4f(tileBounds[at],tileBounds[at+1u],tileBounds[at+2u],tileBounds[at+3u]);}
fn nearCandidate(index:u32,record:bool)->Candidate{
 let none=Candidate(0u,0u,0u);if(index>=p.near.w||p.policy.w==0.){return none;}
 let key=atomicLoad(&queue[index]);if(key==0u){return none;}if(record){atomicAdd(&commands[23],1u);}
 let m=nativeMatrix(index);let P=m[3].xyz+m[1].xyz*p.localMin.y;
 if(interventionBlocked(P.xz)){if(record){atomicAdd(&commands[31],1u);}return none;}
 if(!apsGrassDensityKeep(key,P,p.densityEye,p.densityPolicy)){if(record){atomicAdd(&commands[28],1u);}return none;}
 let b=projectedMatrix(m);if(b.outside){return none;}let a=area(b);if(a<p.policy.x){return none;}
 if(!apsGrassProjectionKeep(key,a,m)){if(record){atomicAdd(&commands[29],1u);}return none;}
 let clip=p.vp*vec4f(P,1.);if(clip.w<=0.){return none;}
 let pixel=vec2u(clamp(vec2f(clip.x/clip.w*.5+.5,.5-clip.y/clip.w*.5)*p.screen.xy,vec2f(0),p.screen.xy-1.));
 let bin=pixel/${GRASS_NEAR_SAMPLE_STEP}u;let at=(p.near.z+bin.y*p.near.x+bin.x)*3u;let depth=bitcast<u32>(clamp(clip.z/clip.w,0.,1.));
 let winner=atomicLoad(&pixels[at+1u]);if((record&&depth<winner)||(!record&&depth!=winner)){return none;}
 if(hidden(b)){if(record){atomicAdd(&commands[25],1u);}return none;}
 return Candidate(key,at,depth);
}
fn candidate(group:vec3u,lane:u32,record:bool)->Candidate{
 if(p.near.w>0u){return nearCandidate(group.x*64u+lane,record);}
 let none=Candidate(0u,0u,0u);let tileSlot=group.x+group.z*p.tiles.z;if(tileSlot>=atomicLoad(&queue[3])){return none;}let packed=atomicLoad(&queue[4u+tileSlot]);let tile=packed&0x000fffffu;let shift=(packed>>20u)&7u;let side=64u>>shift;let k=(packed>>23u)*64u+lane;
 if(k>=side*side){return none;}
 let local=vec2u(tile%p.tiles.x,tile/p.tiles.x)*64u+(vec2u(k%side,k/side)<<vec2u(shift));
 if(local.x>=u32(p.anchor.w)||local.y>=u32(p.shape.w)){return none;}
 if(record){atomicAdd(&commands[12],1u);}
 let cell=vec2i(local)+vec2i(p.anchor.yz);let P=pointOf(cell);
 let grid=(P.xz-p.terrain.xy)/p.terrain.zw;if(any(grid<vec2f(0))||any(grid>p.shape.xy-1.)){return none;}
 if(interventionBlocked(P.xz)){if(record){atomicAdd(&commands[31],1u);}return none;}
 if(!grassPlanted(P.xz)||P.y<p.shape.z){return none;}
 let key=local.y*u32(p.anchor.w)+local.x+1u;
 if(!apsGrassDensityKeep(key,P,p.densityEye,p.densityPolicy)){if(record){atomicAdd(&commands[16],1u);}return none;}
 let clip=p.vp*vec4f(P,1.);if(clip.w<=0.||clip.z<=0.||clip.z>clip.w){return none;}
 let uv=vec2f(clip.x/clip.w*.5+.5,.5-clip.y/clip.w*.5);if(any(uv<vec2f(0))||any(uv>=vec2f(1))){return none;}
 let pixel=vec2u(uv*p.screen.xy);if(pixelMask[pixel.y*u32(p.screen.x)+pixel.x]==0u){return none;}let at=screenBin(pixel);
 // An accepted nearer root can only increase the final reversed-Z winner.
 // Reject losers before the expensive normal/AABB/Hi-Z work. The second
 // dispatch sees immutable final depths, so only exact depth ties proceed.
 let depth=bitcast<u32>(clip.z/clip.w);
 if(p.sampling.y>0.){
  let winner=atomicLoad(&pixels[at+1u]);
  if((record&&depth<winner)||(!record&&depth!=winner)){return none;}
 }
 let b=projectedMatrix(matrixAt(P,seedOf(cell)));if(b.outside){return none;}let a=area(b);
 if(a<=p.sampling.w||a>=p.policy.x){if(record){atomicAdd(&commands[6],1u);}return none;}
 if(hidden(b)){if(record){atomicAdd(&commands[13],1u);}return none;}
 return Candidate(key,at,depth);
}
@compute @workgroup_size(64) fn competeGrassDepth(@builtin(workgroup_id) group:vec3u,@builtin(local_invocation_index) lane:u32){
 let c=candidate(group,lane,true);if(c.key==0u){return;}atomicMax(&pixels[c.pixel+1u],c.depth);atomicAdd(&commands[select(8u,27u,p.near.w>0u)],1u);
}
// A separate dispatch makes the winning depth immutable before choosing an ID.
// Exact depth ties choose the lowest world ID, independent of execution order.
@compute @workgroup_size(64) fn resolveGrassIDs(@builtin(workgroup_id) group:vec3u,@builtin(local_invocation_index) lane:u32){
 let c=candidate(group,lane,false);if(c.key!=0u&&c.depth==atomicLoad(&pixels[c.pixel+1u])){atomicMin(&pixels[c.pixel+2u],c.key);}
}
@compute @workgroup_size(8,8) fn emitGrass(@builtin(global_invocation_id) id:vec3u){
 if(p.near.w>0u){
  if(any(id.xy>=p.near.xy)){return;}let at=(p.near.z+id.y*p.near.x+id.x)*3u;let key=atomicLoad(&pixels[at+2u]);if(key==0xffffffffu){return;}
  let cell=vec2i(vec2u((key-1u)%u32(p.anchor.w),(key-1u)/u32(p.anchor.w)))+vec2i(p.anchor.yz);
  let side=i32(sqrt(f32(p.near.w/64u)));let tile=vec2i(floor(vec2f(cell)/8.));let slot=((tile%side)+side)%side;let lane=((cell%8)+8)%8;
  let source=u32(slot.y*side+slot.x)*64u+u32(lane.y*8+lane.x);
  if(atomicLoad(&queue[source])!=key){atomicAdd(&commands[30],1u);return;}
  let output=p.near.z+atomicAdd(&commands[19],1u);grassKeys[output]=key;grassMatrices[output]=nativeMatrix(source);return;
 }
 if(any(id.xy>=vec2u(p.screen.zw))){return;}let at=(id.y*u32(p.screen.z)+id.x)*3u;let key=atomicLoad(&pixels[at+2u]);
 if(key==0xffffffffu){if(atomicLoad(&pixels[at])!=0u){atomicAdd(&commands[14],1u);}return;}
 let cell=vec2i(vec2u((key-1u)%u32(p.anchor.w),(key-1u)/u32(p.anchor.w)))+vec2i(p.anchor.yz);
 let slot=atomicAdd(&commands[1],1u);grassKeys[slot]=key;grassMatrices[slot]=matrixAt(pointOf(cell),seedOf(cell));atomicAdd(&commands[7],1u);
}
`;
