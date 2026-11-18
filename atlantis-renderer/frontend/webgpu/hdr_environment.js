import {FullscreenPass} from '../../vendor/tidewater/src/engine/render/FullscreenPass.js';
import {SCENE_FORMATS,DEPTH_FORMAT} from '../../vendor/tidewater/src/engine/render/SceneRenderer.js';
import {Sky} from '../../vendor/tidewater/src/sky/Sky.js';
import {ShaderModule,UniformBlock} from '../../vendor/tidewater/src/engine/gpu/Shader.js';
import {Texture} from '../../vendor/tidewater/src/engine/gpu/Texture.js';
import {commonModule} from '../../vendor/tidewater/src/engine/render/wgsl/common.js';

export function environmentOptions(texture,{intensity=1,rotation=0,flipX}={}) {
 if(!texture?.isTexture || !['cube','2d'].includes(texture.dimension) || !['rgba16float','rgba32float'].includes(texture.format))throw new TypeError('Expected native linear HDR cube or equirectangular Texture');
 if(texture.dimension==='cube'&&(texture.width!==texture.height||texture.depth!==6))throw new TypeError('Expected six square native cube faces');
 if(texture.format==='rgba32float')throw new TypeError('Convert linear float32 input using linearHDRTexture (portable float16 filtering)');
 if(!Number.isFinite(intensity)||intensity<0||intensity>100||!Number.isFinite(rotation)||Math.abs(rotation)>100)throw new RangeError('Invalid HDR intensity/rotation');
 const handedness=texture.dimension==='2d'?1:flipX??(texture.isRenderTargetTexture?1:-1);
 if(flipX!==undefined && flipX!==1 && flipX!==-1)throw new RangeError('flipX must be +1 or -1');
 return {intensity,rotation,flipX:handedness};
}
export class HDRSky extends Sky {
 constructor(atmosphere,texture,options,environmentFrame=null){super(atmosphere);this.texture=texture;this.options=options;this.environmentFrame=environmentFrame;
 this.orientation=new UniformBlock('APSHDROrientation',{cosine:['f32',Math.cos(options.rotation)],sine:['f32',Math.sin(options.rotation)],flip:['f32',options.flipX],pad:['f32',0]});}
 get background(){
  if(!this._background)this._background=new FullscreenPass({label:'APS HDR background',modules:[this.module],colorFormats:SCENE_FORMATS,depthFormat:DEPTH_FORMAT,depthCompare:'equal',depthWrite:false,depth:0,code:          `
struct APSHDRSkyOut { @location(0) color: vec4f, @location(1) velocity: vec4f, @location(2) mask: vec4f }
@fragment fn fs(in: FSIn) -> APSHDRSkyOut {
 let dir=viewRay(in.pos.xy*frame.invResolution);var o: APSHDRSkyOut;o.color=vec4f(skyViewRadiance(dir),1);
 let c=frame.viewProjNoJitter*vec4f(dir,0);let p=frame.prevViewProjNoJitter*vec4f(dir,0);
 let cur=c.xy/max(abs(c.w),1e-6)*sign(c.w);let prev=p.xy/max(abs(p.w),1e-6)*sign(p.w);
 o.velocity=vec4f(select(vec2f(0),(cur-prev)*vec2f(.5,-.5),c.w>1e-6&&p.w>1e-6),0,1);o.mask=vec4f(0);return o;
}`});return this._background;
 }
 _buildModule(){return new ShaderModule({name:'apsHDRSky',deps:[commonModule,this.environmentFrame?.module].filter(Boolean),uniforms:this.orientation,uniformName:'apsHDR',bindings:{apsHDRMap:{texture:this.texture,viewDimension:this.texture.dimension}},code:          `
fn apsHDRRadiance(dir: vec3f) -> vec3f {
 var d=vec3f(apsHDR.cosine*dir.x+apsHDR.sine*dir.z,dir.y,-apsHDR.sine*dir.x+apsHDR.cosine*dir.z);d.x*=apsHDR.flip;
 ${this.texture.dimension==='cube'?'return textureSampleLevel(apsHDRMap,smpLinearClamp,d,0.0).rgb;':`let uv=vec2f(atan2(d.z,d.x)/(2.0*PI)+.5,acos(clamp(d.y,-1.0,1.0))/PI);
 let size=vec2i(textureDimensions(apsHDRMap));let p=uv*vec2f(size)-.5;let a=vec2i(floor(p));let f=fract(p);
 let x0=((a.x%size.x)+size.x)%size.x;let x1=(x0+1)%size.x;let y0=clamp(a.y,0,size.y-1);let y1=clamp(a.y+1,0,size.y-1);
 return mix(mix(textureLoad(apsHDRMap,vec2i(x0,y0),0).rgb,textureLoad(apsHDRMap,vec2i(x1,y0),0).rgb,f.x),mix(textureLoad(apsHDRMap,vec2i(x0,y1),0).rgb,textureLoad(apsHDRMap,vec2i(x1,y1),0).rgb,f.x),f.y);`}
}
fn skyRadianceWithClouds(dir: vec3f,withSun: bool) -> vec3f {return apsHDRRadiance(dir);}
fn skyReflectionRadiance(dir: vec3f) -> vec3f {return apsHDRRadiance(${this.environmentFrame?'apsEnvironmentDirection(dir)':'dir'});}
fn skyViewRadiance(dir: vec3f) -> vec3f {return apsHDRRadiance(${this.environmentFrame?'apsEnvironmentDirection(dir)':'dir'})*frame.envIntensity;}
`});}
}
                                                                           
export function halfFloat(value) {
 if(!Number.isFinite(value)||value<0||value>65504)throw new RangeError('Linear HDR exceeds finite rgba16float range');
 if(value===0)return 0;
 const exponent=Math.floor(Math.log2(value));
 if(exponent< -14)return Math.round(value/2**-24);
 let mantissa=Math.round((value/2**exponent-1)*1024),e=exponent+15;
 if(mantissa===1024){e++;mantissa=0;}return (e<<10)|mantissa;
}
export function linearHDRTexture({width,height,data,dimension='2d'}) {
 if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||!['2d','cube'].includes(dimension)||dimension==='cube'&&width!==height)throw new RangeError('Invalid HDR dimensions');
 const layers=dimension==='cube'?6:1;
 if(data.length!==width*height*layers*4)throw new RangeError('Expected linear RGBA data');
 return new Texture({label:'APS linear HDR import',width,height,dimension,format:'rgba16float',data:Uint16Array.from(data,halfFloat),usage:['sample','copyDst']});
}
                                                                                 
export function decodeRGBE(buffer) {
 const bytes=new Uint8Array(buffer);let pos=0;
 const line=()=>{const start=pos;while(pos<bytes.length&&bytes[pos]!==10)pos++;if(pos===bytes.length)throw new Error('Truncated HDR header');return new TextDecoder().decode(bytes.subarray(start,pos++)).trim();};
 if(!/^#\?(RADIANCE|RGBE)$/.test(line()))throw new Error('Expected Radiance HDR');
 let format=false;for(;;){const s=line();if(!s)break;if(s==='FORMAT=32-bit_rle_rgbe')format=true;}
 if(!format)throw new Error('Unsupported HDR encoding');
 const match=/^([+-])Y\s+(\d+)\s+([+-])X\s+(\d+)$/.exec(line());if(!match)throw new Error('Unsupported HDR resolution orientation');
 const height=Number(match[2]),width=Number(match[4]),pixels=new Uint8Array(width*height*4);
 const read=()=>{if(pos>=bytes.length)throw new Error('Truncated RGBE data');return bytes[pos++];};
 for(let y=0;y<height;y++) {
  const first=[read(),read(),read(),read()];const row=new Uint8Array(width*4);
  if(width>=8&&width<=32767&&first[0]===2&&first[1]===2&&(first[2]&128)===0){
   if((first[2]<<8|first[3])!==width)throw new Error('HDR scanline width mismatch');
   for(let c=0;c<4;c++){let x=0;while(x<width){const n=read();if(n===0)throw new Error('Invalid RGBE run');const count=n>128?n-128:n;
    if(x+count>width)throw new Error('RGBE run overflow');if(n>128){const v=read();for(let i=0;i<count;i++)row[(x+i)*4+c]=v;}else for(let i=0;i<count;i++)row[(x+i)*4+c]=read();x+=count;}}
  }else{
   let x=0,shift=0,record=first;
   while(x<width){if(record[0]===1&&record[1]===1&&record[2]===1){const count=record[3]*2**shift;if(x===0||count===0||x+count>width)throw new Error('Invalid old RGBE run');
    for(let i=0;i<count;i++)row.set(row.subarray((x-1)*4,x*4),(x+i)*4);x+=count;shift+=8;
   }else{row.set(record,x*4);x++;shift=0;}if(x<width)record=[read(),read(),read(),read()];}
  }
  const destY=match[1]==='-'?y:height-1-y;
  for(let x=0;x<width;x++){const destX=match[3]==='+'?x:width-1-x;pixels.set(row.subarray(x*4,x*4+4),(destY*width+destX)*4);}
 }
 const data=new Float32Array(width*height*4);
 for(let i=0;i<pixels.length;i+=4){const scale=pixels[i+3]?2**(pixels[i+3]-128)/256:0;for(let c=0;c<3;c++)data[i+c]=pixels[i+c]*scale;data[i+3]=1;}
 return {width,height,data};
}

                                                                                   
export function adaptHDRInput(input) {
 if(input?.dimension)return {texture:input,owned:false};
 if(!input?.isTexture)throw new TypeError('Expected native or CPU-backed HDR texture');
 const cube=!!input.isCubeTexture,images=cube?input.image:[input.image];
 if(!Array.isArray(images)||images.length!==(cube?6:1))throw new TypeError('Expected six CPU-backed HDR cube faces');
 const first=images[0]?.image??images[0],width=first?.width,height=first?.height;
 const data=new Float32Array(width*height*images.length*4);
 for(let face=0;face<images.length;face++){
  const image=images[face]?.image??images[face],src=image?.data;
  if(!src||image.width!==width||image.height!==height||!Number.isInteger(width)||!Number.isInteger(height))throw new TypeError('HDR import requires matching CPU linear pixel data');
  const channels=src.length/(width*height);if(channels!==3&&channels!==4)throw new TypeError('Expected RGB/RGBA HDR data');
  for(let i=0;i<width*height;i++)for(let c=0;c<4;c++){
   let v=c<channels?src[i*channels+c]:1;
   if(src instanceof Uint16Array&&c<channels){const e=(v>>10)&31,m=v&1023,sign=(v&32768)?-1:1;v=sign*(e===0?m*2**-24:e===31?Infinity:(1+m/1024)*2**(e-15));}
   data[(face*width*height+i)*4+c]=v;
  }
 }
 const texture=linearHDRTexture({width,height,data,dimension:cube?'cube':'2d'});texture.isRenderTargetTexture=!!input.isRenderTargetTexture;
 return {texture,owned:true};
}
