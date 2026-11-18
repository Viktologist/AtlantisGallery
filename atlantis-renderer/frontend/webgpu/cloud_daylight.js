import {ShaderModule} from '../../vendor/tidewater/src/engine/gpu/Shader.js';
import {ComputeKernel} from '../../vendor/tidewater/src/engine/gpu/Compute.js';
import {Texture} from '../../vendor/tidewater/src/engine/gpu/Texture.js';
import {commonModule} from '../../vendor/tidewater/src/engine/render/wgsl/common.js';

                                                                               
                                                                               
export class CloudDaylight {
 constructor(atmosphere){
  this.atmosphere=atmosphere;
  this.texture=new Texture({label:'Cloud incident daylight',width:1,height:1,format:'rgba16float',usage:['sample','storage']});
  this.module=new ShaderModule({name:'apsCloudDaylight',deps:[atmosphere?.multiScatModule??commonModule],
   bindings:{apsCloudDaylightLUT:{texture:this.texture}},code:          `
fn apsCloudIncidentDaylight()->vec3f {return textureLoad(apsCloudDaylightLUT,vec2i(0),0).rgb;}
${atmosphere?'': 'fn atmosphereSampleMultiScat(r:f32,mu:f32)->vec3f {return vec3f(0);}' }
`});
  this.kernel=atmosphere?new ComputeKernel({label:'Cloud current clear-sky incident radiance',modules:[atmosphere.module],
   bindings:{outDaylight:{storageTexture:this.texture}},workgroupSize:[1,1,1],code:          `
@compute @workgroup_size(1) fn main(){
 var upper=vec3f(0);var irradiance=vec3f(0);
 // Uniform solid-angle quadrature: separate mean radiance from E/pi.
 for(var y=0;y<8;y++){for(var x=0;x<16;x++){
  let mu=(f32(y)+.5)/8.0;let phi=(f32(x)+.5)*2.0*PI/16.0;let s=sqrt(1.0-mu*mu);
  let L=atmosphereSkyLuminance(vec3f(s*cos(phi),mu,s*sin(phi)));
  upper+=L;irradiance+=2.0*mu*L;
 }}
 upper/=128.0;irradiance/=128.0;
 var direct=vec3f(0);
 if(atmosphereParams.sunDir.y>0.0){direct=atmosphereSampleTransmittance(ATMO_RG+.001,atmosphereParams.sunDir.y)*atmosphereParams.sunIlluminance*atmosphereParams.sunDir.y/PI;}
 let ground=atmosphereParams.groundAlbedo*(irradiance+direct);
 // Isotropic cloud scattering integrates incoming radiance over 4pi.
 textureStore(outDaylight,vec2i(0),vec4f(.5*(upper+ground),1));
}` }):null;
 }
 update(key){if(this.key===key)return;this.kernel?.dispatch(1);this.key=key;}
 dispose(){this.texture.destroy();}
}
