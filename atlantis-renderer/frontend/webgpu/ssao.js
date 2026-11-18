import {Texture} from '../../vendor/tidewater/src/engine/gpu/Texture.js';
import {ShaderModule,UniformBlock} from '../../vendor/tidewater/src/engine/gpu/Shader.js';
import {FullscreenPass} from '../../vendor/tidewater/src/engine/render/FullscreenPass.js';
import {destroyUniform,releaseAfterSubmit} from './lighting_native.js';

                                                                                 
const depthCode=          `
fn aoPosition(p:vec2i)->vec3f {
 let size=vec2i(textureDimensions(aoDepth));let q=clamp(p,vec2i(0),size-1);
 return viewFromDepth((vec2f(q)+.5)/vec2f(size),textureLoad(aoDepth,q,0));
}
fn aoNormal(p:vec2i,P:vec3f)->vec3f {
 let l=aoPosition(p-vec2i(1,0));let r=aoPosition(p+vec2i(1,0));
 let u=aoPosition(p-vec2i(0,1));let d=aoPosition(p+vec2i(0,1));
 let dx=select(P-l,r-P,abs(r.z-P.z)<abs(l.z-P.z));
 let dy=select(P-u,d-P,abs(d.z-P.z)<abs(u.z-P.z));
 let c=cross(dx,dy);if(length(c)<1e-8){return normalize(-P);}let N=normalize(c);
 return select(N,-N,dot(N,-P)<0.);
}`;
export const SSAO_WGSL=depthCode+          `
fn fragment(in:FSIn)->vec4f {
 let p=vec2i(in.pos.xy);let depth=textureLoad(aoDepth,p,0);
 if(isSky(depth)){return vec4f(1);}
 let P=aoPosition(p);let N=aoNormal(p,P);
 let size=vec2f(textureDimensions(aoDepth));
 let radiusPx=min(128.,ao.radius*.5*abs(frame.proj[1][1])*size.y/max(-P.z,.001));
 if(radiusPx<1.){return vec4f(1);}
 let phi=interleavedGradientNoise(in.pos.xy)*TWO_PI;
 var sum=0.;
 for(var i=0;i<24;i++){
  let offset=vogelDiskSample(i,24,phi)*radiusPx;
  let q=p+vec2i(round(offset));
  if(any(q<vec2i(0))||any(q>=vec2i(size))){continue;}
  if(isSky(textureLoad(aoDepth,q,0))){continue;}
  let V=aoPosition(q)-P;let distance=length(V);
  let angular=max(dot(N,V)-ao.bias,0.)/max(distance,.00001);
  sum+=angular*pow2(max(0.,1.-distance/ao.radius));
 }
 let visibility=clamp(1.-ao.intensity*sum*(4./24.),0.,1.);
 return vec4f(visibility,0,0,1);
}`;
const blurCode=horizontal=>depthCode+          `
fn fragment(in:FSIn)->vec4f {
 let p=vec2i(in.pos.xy);if(isSky(textureLoad(aoDepth,p,0))){return vec4f(1);}
 let P=aoPosition(p);let N=aoNormal(p,P);let size=vec2i(textureDimensions(aoDepth));
 var sum=0.;var weights=0.;
 for(var i=-3;i<=3;i++){
  let q=p+${horizontal?'vec2i(i,0)':'vec2i(0,i)'};
  if(any(q<vec2i(0))||any(q>=size)){continue;}
  if(isSky(textureLoad(aoDepth,q,0))){continue;}
  let Q=aoPosition(q);let normal=aoNormal(q,Q);
  let weight=select(exp(-f32(i*i)/8.-abs(dot(Q-P,N))/max(ao.radius*.05,.001))*pow(max(dot(N,normal),0.),8.),1.,i==0);
  sum+=textureLoad(aoSource,q,0).r*weight;weights+=weight;
 }
 return vec4f(sum/max(weights,1e-6),0,0,1);
}`;

export class ScreenSpaceAO {
 constructor(scene){
  this.scene=scene;this.frames=0;this.active=false;
  this.params=new UniformBlock('APSSSAO',{radius:['f32',1],intensity:['f32',1],bias:['f32',.02]});
  const module=new ShaderModule({name:'apsSSAO',uniforms:this.params,uniformName:'ao'});
  const make=label=>new Texture({label,width:1,height:1,format:'r16float',usage:['sample','render','copySrc']});
  this.raw=make('SSAO raw');this.ping=make('SSAO horizontal');this.filtered=make('SSAO filtered');
  const depth={texture:()=>scene.sceneRT.depthTexture};
  this.evaluate=new FullscreenPass({label:'SSAO 24 view-space taps',modules:[module],bindings:{aoDepth:depth},colorFormats:['r16float'],code:SSAO_WGSL});
  this.blur=[this.raw,this.ping].map((source,i)=>new FullscreenPass({label:'SSAO bilateral '+i,modules:[module],bindings:{aoDepth:depth,aoSource:{texture:source}},colorFormats:['r16float'],code:blurCode(i===0)}));
  this.apply=new FullscreenPass({label:'SSAO opaque HDR multiply',blend:'multiply',bindings:{aoSource:{texture:this.filtered}},code:'fn fragment(in:FSIn)->vec4f{return vec4f(vec3f(textureLoad(aoSource,vec2i(in.pos.xy),0).r),1);}'});
 }
 render(options,diagnostic=false){
  this.active=options.ssao&&options.ssaoIntensity>0&&!diagnostic;
  if(!this.active)return;
  if(this.scene.camera.reversedDepth===false)throw Error('SSAO requires reverse-Z');
  const {width,height}=this.scene;
  for(const t of [this.raw,this.ping,this.filtered])if(t.width!==width||t.height!==height)t.resize(width,height);
  for(const [key,option] of [['radius','ssaoRadius'],['intensity','ssaoIntensity'],['bias','ssaoBias']])this.params.fields[key].value=options[option];
  this.evaluate.render({colorViews:[this.raw]});this.blur[0].render({colorViews:[this.ping]});this.blur[1].render({colorViews:[this.filtered]});
  this.apply.render({colorViews:[this.scene.sceneRT.texture]});this.frames++;
 }
 metadata(){return {active:this.active,frames:this.frames,samples:24,resolution:[this.raw.width,this.raw.height],depth:'current opaque reverse-Z, read-only',filter:'separable depth/normal bilateral',composition:'opaque HDR before water/transparent/atmosphere',limitation:'modulates combined opaque radiance; no separate indirect-light buffer, offscreen occluders or temporal accumulation'};}
 dispose(){releaseAfterSubmit(()=>{for(const t of [this.raw,this.ping,this.filtered])t.destroy();destroyUniform(this.params);});}
}
