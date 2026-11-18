import {Texture} from '../../vendor/tidewater/src/engine/gpu/Texture.js';
import {ComputeKernel} from '../../vendor/tidewater/src/engine/gpu/Compute.js';
import {ShaderModule} from '../../vendor/tidewater/src/engine/gpu/Shader.js';
import {commonModule} from '../../vendor/tidewater/src/engine/render/wgsl/common.js';

                                                                        
                                                                           
export const DFG_WGSL =           `
fn apsDFGSequence(i:u32) -> f32 {
  var b=i;
  b=(b<<16u)|(b>>16u);
  b=((b&0x55555555u)<<1u)|((b&0xAAAAAAAAu)>>1u);
  b=((b&0x33333333u)<<2u)|((b&0xCCCCCCCCu)>>2u);
  b=((b&0x0F0F0F0Fu)<<4u)|((b&0xF0F0F0F0u)>>4u);
  b=((b&0x00FF00FFu)<<8u)|((b&0xFF00FF00u)>>8u);
  return f32(b)*2.3283064365386963e-10;
}
@compute @workgroup_size(8,8,1) fn main(@builtin(global_invocation_id) gid:vec3u) {
  if(gid.x>=128u || gid.y>=128u){return;}
  let nv=(f32(gid.x)+.5)/128.0;let rough=(f32(gid.y)+.5)/128.0;
  let alpha=max(.001,rough*rough);let a2=alpha*alpha;
  let V=vec3f(sqrt(1.0-nv*nv),0,nv);var ab=vec2f(0);
  for(var i=0u;i<256u;i++) {
    let xi=vec2f(f32(i)/256.0,apsDFGSequence(i));let phi=TWO_PI*xi.x;
    let nh=sqrt((1.0-xi.y)/(1.0+(a2-1.0)*xi.y));let sh=sqrt(max(0.0,1.0-nh*nh));
    let H=vec3f(sh*cos(phi),sh*sin(phi),nh);let vh=max(0.0,dot(V,H));
    let L=2.0*vh*H-V;let nl=max(0.0,L.z);
    if(nl>0.0) {
      let gv=nl*sqrt(a2+(1.0-a2)*nv*nv);let gl=nv*sqrt(a2+(1.0-a2)*nl*nl);
      let vis=.5/max(gv+gl,1e-5);let weight=4.0*vis*nl*vh/max(nh,1e-5);
      let fc=pow(1.0-vh,5.0);ab+=vec2f(1.0-fc,fc)*weight;
    }
  }
  textureStore(dfgOutput,gid.xy,vec4f(ab/256.0,0,1));
}
`;
export class PreintegratedDFG {
  constructor() {
    this.texture=new Texture({label:'APS native GGX/Smith DFG A/B',width:128,height:128,format:'rgba16float',usage:['sample','storage']});
    this.kernel=new ComputeKernel({label:'APS preintegrated DFG (once)',modules:[commonModule],bindings:{dfgOutput:{storageTexture:this.texture}},workgroupSize:[8,8,1],code:DFG_WGSL});
    this.module=new ShaderModule({name:'apsDFGLookup',deps:[commonModule],bindings:{apsDFGLUT:{texture:this.texture}},code:          `
fn apsDFG(dotNV:f32,roughness:f32)->vec2f {
  let uv=clamp(vec2f(dotNV,roughness),vec2f(.5/128.0),vec2f(1.0-.5/128.0));
  return textureSampleLevel(apsDFGLUT,smpLinearClamp,uv,0.0).rg;
}`});
  }
  bake(){if(this.baked)return;this.kernel.dispatch([16,16,1]);this.baked=true;this.bakes=1;}
  dispose(){this.texture.destroy();}
}
