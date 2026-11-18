import {ShaderModule,UniformBlock} from '../../vendor/tidewater/src/engine/gpu/Shader.js';
import {surfaceModule} from '../../vendor/tidewater/src/engine/render/wgsl/lighting.js';
import {StorageBuffer} from '../../vendor/tidewater/src/engine/gpu/Texture.js';
import {buildLightGrid} from './point_light_math.js';
import {LOCAL_SHADOW_FILTER} from './local_shadow_filter.js';

export function localFalloff(distance,cutoff=0,decay=2) {
 const base=1/Math.max(distance**decay,.01);return base*(cutoff>0?Math.max(0,1-(distance/cutoff)**4)**2:1);
}
const vector=(v)=>Array.isArray(v)||ArrayBuffer.isView(v)?Array.from(v):[v?.x,v?.y,v?.z];
export class LocalLights {
 constructor(){this.grid=new StorageBuffer({label:'static local light cluster masks',count:4096,type:'u32',data:new Uint32Array(4096)});this.gridParams=new UniformBlock('APSLocalGrid',{origin:['vec4f',[0,0,0,16]],cell:['vec4f',[1,1,1,0]],always:['u32',0]});this.params=new UniformBlock('APSLocalLights',{count:['u32',0],pad:['vec3f',[0,0,0]],
 positionRange:['vec4f[32]',Array.from({length:32},()=>[0,0,0,0])],colorDecay:['vec4f[32]',Array.from({length:32},()=>[0,0,0,2])],
 directionCone:['vec4f[32]',Array.from({length:32},()=>[0,-1,0,-1])],penumbra:['vec4f[32]',Array.from({length:32},()=>[1,0,0,0])]});this.shadow=null;this.buildModule();}
 buildModule(){
 const shadow=this.shadow;
 this.module=new ShaderModule({name:'apsLocalLights',deps:[surfaceModule],uniforms:this.params,uniformName:'apsLocal',
 bindings:{apsLocalGrid:{uniform:this.gridParams},apsLocalMasks:{storage:this.grid,access:'read',type:'u32',visibility:'fragment'},...(shadow?{apsLocalDepth:{texture:()=>shadow.writing?shadow.neutral:shadow.texture,viewDimension:'2d-array'},apsLocalShadow:{uniform:shadow.params}}:{})},code:          `
struct APSLocalIncident { direction: vec3f, radiance: vec3f }
${shadow?LOCAL_SHADOW_FILTER:''}
fn apsLocalLightCount() -> u32 {return apsLocal.count;}
fn apsLocalLightMask(P:vec3f)->u32 {
 let q=vec3i(floor((P-apsLocalGrid.origin.xyz)/apsLocalGrid.cell.xyz));let n=i32(apsLocalGrid.origin.w);
 var mask=apsLocalGrid.always;
 if(all(q>=vec3i(0))&&all(q<vec3i(n))){mask=apsLocalMasks[u32(q.x+n*(q.y+n*q.z))];}
 return mask;
}
fn apsLocalLightAffects(i:u32,P:vec3f)->bool {
 let r=apsLocal.positionRange[i].w;let d=P-apsLocal.positionRange[i].xyz;
 return r<=0.0 || dot(d,d)<r*r;
}
fn apsLocalVisibility(i: u32,worldP: vec3f,N:vec3f) -> f32 {
 ${shadow?`let info=apsLocalShadow.info[i];if(info.x<0.0){return 1.0;}
 let lightDirection=normalize(apsLocal.positionRange[i].xyz-worldP);
 let receiverNormal=select(N,-N,dot(N,lightDirection)<0.0);
 let P=worldP+receiverNormal*info.w;
 var face=0u;if(info.y>0.5){let d=P-apsLocal.positionRange[i].xyz;let a=abs(d);
 if(a.x>=a.y && a.x>=a.z){face=select(1u,0u,d.x>=0.0);}else if(a.y>=a.z){face=select(3u,2u,d.y>=0.0);}else{face=select(5u,4u,d.z>=0.0);}}
 let index=u32(info.x)+face;let clip=apsLocalShadow.matrices[index]*vec4f(P,1);if(clip.w<=0.0){return 1.0;}
 let q=clip.xyz/clip.w;let uv=q.xy*vec2f(.5,-.5)+.5;if(any(uv<vec2f(0))||any(uv>vec2f(1))||q.z<0.0||q.z>1.0){return 1.0;}
 return apsSoftLocalVisibility(i,P,receiverNormal);`:'return 1.0;'}
}
fn apsLocalLight(i: u32,P: vec3f,N:vec3f) -> APSLocalIncident {
 if(!apsLocalLightAffects(i,P)){return APSLocalIncident(vec3f(0,1,0),vec3f(0));}
 let delta=apsLocal.positionRange[i].xyz-P;let distance=length(delta);let L=delta/max(distance,1e-8);
 let cutoff=apsLocal.positionRange[i].w;let c=apsLocal.colorDecay[i];var attenuation=1.0/max(pow(distance,c.w),.01);
 if(cutoff>0.0){attenuation*=pow(sat(1.0-pow(distance/cutoff,4.0)),2.0);}
 let cone=apsLocal.directionCone[i];if(cone.w>=0.0){let mu=dot(-L,cone.xyz);let inner=apsLocal.penumbra[i].x;
 if(inner<=cone.w){attenuation*=step(cone.w,mu);}else{attenuation*=smoothstep(cone.w,inner,mu);}}
 if(attenuation<=0.0 || all(c.rgb==vec3f(0))){return APSLocalIncident(L,vec3f(0));}
 return APSLocalIncident(L,c.rgb*attenuation*apsLocalVisibility(i,P,N));
}
fn hookLocalLights(s: Surface,P: vec3f,N: vec3f,V: vec3f,acc: ptr<function,LightAccum>) {
 var mask=apsLocalLightMask(P);
 while(mask!=0u){let i=firstTrailingBit(mask);mask=mask & (mask-1u);
 if(!apsLocalLightAffects(i,P)){continue;}
 let light=apsLocalLight(i,P,N);let L=light.direction;let E=light.radiance*sat(dot(N,L));
 (*acc).directDiffuse+=E*s.albedo*(1.0-s.metalness)*INV_PI+s.translucency*light.radiance;
 let f0=mix(vec3f(.04)*s.specularIntensity,s.albedo,s.metalness);let f90=mix(s.specularIntensity,1.0,s.metalness);
 (*acc).directSpecular+=E*BRDF_GGX(L,V,N,f0,f90,clamp(s.roughness,.03,1.0));
 #if SHEEN
 (*acc).directSpecular+=E*BRDF_Sheen(L,V,N,s.sheenColor,max(s.sheenRoughness,.07));
 #endif
 #if CLEARCOAT
 (*acc).directSpecular+=s.clearcoat*sat(dot(s.clearcoatNormal,L))*light.radiance*BRDF_GGX(L,V,s.clearcoatNormal,vec3f(.04),1.0,clamp(s.clearcoatRoughness,.03,1.0));
 #endif
 }
}
`});}
 set(lights=[]){if(!Array.isArray(lights)||lights.length>32)throw new RangeError('Native local-light limit is 32; no silent truncation');
 const rows=lights.map(light=>{
 const position=vector(light.position),color=light.color?Array.isArray(light.color)?light.color:[light.color.r,light.color.g,light.color.b]:[1,1,1];
 const range=light.distance??light.range??0,decay=light.decay??2,intensity=light.intensity??1;
 const spot=light.type==='spot'||light.isSpotLight;const direction=spot?vector(light.direction):[0,-1,0];const n=Math.hypot(...direction);
 const angle=light.angle??Math.PI/3,penumbra=light.penumbra??0;
 const sourceRadius=light.shadow?.sourceRadius??.06;
 if(!Number.isFinite(sourceRadius)||sourceRadius<=0)throw new TypeError('Shadow sourceRadius must be positive metres');
 if(position.length!==3||color.length!==3||![...position,...color,...direction,range,decay,intensity,angle,penumbra].every(Number.isFinite)||range<0||decay<0||intensity<0||color.some(x=>x<0)||n<1e-8||angle<0||angle>Math.PI/2||penumbra<0||penumbra>1)throw new TypeError('Invalid point/spot light');
 return [[...position,range],[...color.map(x=>x*intensity),decay],[...direction.map(x=>x/n),spot?Math.cos(angle):-1],[Math.cos(angle*(1-penumbra)),0,0,0]];});
 const u=this.params.fields;for(let i=0;i<rows.length;i++){u.positionRange.value[i]=rows[i][0];u.colorDecay.value[i]=rows[i][1];u.directionCone.value[i]=rows[i][2];u.penumbra.value[i]=rows[i][3];}u.count.value=rows.length;this.lights=lights;
 const key=JSON.stringify(rows.map(r=>r[0]));if(key!==this.gridKey){this.gridKey=key;const grid=buildLightGrid(rows.map(r=>({position:r[0].slice(0,3),range:r[0][3]})));this.grid.write(grid.masks);this.gridParams.set('origin',[...grid.min,grid.size]);this.gridParams.set('cell',[...grid.cell,0]);this.gridParams.set('always',grid.always);this.gridBuilds=(this.gridBuilds??0)+1;}}
                                                                                                               
 setShadowAtlas({texture,neutral=texture,matrices,info}){
 if(texture?.format!=='depth32float'||texture.dimension!=='2d-array'||!Array.isArray(matrices)||matrices.length>192||!Array.isArray(info)||info.length>32)throw new TypeError('Invalid native local shadow atlas');
 const m=matrices.map(x=>Array.from(x.elements??x));if(m.some(x=>x.length!==16||!x.every(Number.isFinite)))throw new TypeError('Invalid local shadow matrix');
 const entries=info.map(x=>Array.from(x));if(entries.some(x=>x.length!==4||!x.every(Number.isFinite)||x[0]<-1||!Number.isInteger(x[0])||x[2]<0||x[0]>=0&&(x[0]+(x[1]>.5?6:1)>m.length||x[0]+(x[1]>.5?6:1)>texture.depth)))throw new TypeError('Invalid local shadow layer');
 const previous=this.shadow?.params;this.shadow={texture,neutral,writing:false,params:new UniformBlock('APSLocalShadow',{matrices:['mat4x4f[192]',Array.from({length:192},(_,i)=>m[i]??[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1])],info:['vec4f[32]',Array.from({length:32},(_,i)=>entries[i]??[-1,0,0,0])],softness:['vec4f[32]',Array.from({length:32},()=>[.06,.01,100,0])]})};this.buildModule();return previous;
 }
 syncScene(scene,explicit=[]){const lights=[...explicit];scene.traverseVisible?.(node=>{if(!node.isPointLight&&!node.isSpotLight)return;node.updateWorldMatrix?.(true,false);
 const e=node.matrixWorld?.elements;const position=e?[e[12],e[13],e[14]]:vector(node.position);
 let direction;if(node.isSpotLight){node.target?.updateWorldMatrix?.(true,false);const t=node.target?.matrixWorld?.elements;const target=t?[t[12],t[13],t[14]]:vector(node.target?.position);direction=target.map((x,i)=>x-position[i]);}
 lights.push({type:node.isSpotLight?'spot':'point',position,direction,color:node.color,intensity:node.intensity,distance:node.distance,decay:node.decay,angle:node.angle,penumbra:node.penumbra,castShadow:node.castShadow,shadow:node.shadow});});this.set(lights);}
 dispose(){this.grid.destroy();this.gridParams.buffer?.destroy();this.params.buffer?.destroy();this.shadow?.params.buffer?.destroy();}
}
