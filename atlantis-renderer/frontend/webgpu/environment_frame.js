import {ShaderModule,UniformBlock} from '../../vendor/tidewater/src/engine/gpu/Shader.js';
import {normalizeEnvironmentYaw,rotateEnvironmentVector} from './environment_math.js';

                                                                           
export class EnvironmentFrame {
 constructor(){
  this.revision=0;this.yaw=0;this.origin=[0,2,0];
  this.params=new UniformBlock('APSEnvironmentFrame',{rotation:['vec2f',[1,0]],origin:['vec3f',this.origin]});
  this.module=new ShaderModule({name:'apsEnvironmentFrame',uniforms:this.params,uniformName:'apsEnvFrame',code:          `
fn apsEnvironmentDirection(D:vec3f)->vec3f {
 let c=apsEnvFrame.rotation.x;let s=apsEnvFrame.rotation.y;
 return vec3f(c*D.x-s*D.z,D.y,s*D.x+c*D.z);
}
fn apsEnvironmentWorldDirection(D:vec3f)->vec3f {
 let c=apsEnvFrame.rotation.x;let s=apsEnvFrame.rotation.y;
 return vec3f(c*D.x+s*D.z,D.y,-s*D.x+c*D.z);
}
fn apsEnvironmentPoint(P:vec3f)->vec3f {return apsEnvFrame.origin+apsEnvironmentDirection(P-apsEnvFrame.origin);}
fn apsEnvironmentWorldPoint(P:vec3f)->vec3f {return apsEnvFrame.origin+apsEnvironmentWorldDirection(P-apsEnvFrame.origin);}
`});
 }
 update(degrees,origin){
  const yaw=normalizeEnvironmentYaw(degrees);
  if(!Array.isArray(origin)||origin.length!==3||!origin.every(Number.isFinite))throw new TypeError('Environment frame requires a finite probe');
  if(yaw===this.yaw&&origin.every((v,i)=>v===this.origin[i]))return false;
  this.yaw=yaw;this.origin=[...origin];this.revision++;
  const radians=yaw*Math.PI/180;
  this.params.fields.rotation.value=[Math.cos(radians),Math.sin(radians)];this.params.fields.origin.value=this.origin;return true;
 }
 directionToWorld(direction){return rotateEnvironmentVector(direction,this.yaw);}
 pointToEnvironment(point){return rotateEnvironmentVector(point.map((v,i)=>v-this.origin[i]),-this.yaw).map((v,i)=>v+this.origin[i]);}
 wrapIBL(hooks){
  const result={};
  for(const key of ['envSpecular','envDiffuse']){
   const original=hooks[key],fn=key==='envSpecular'?'hookEnvSpecular':'hookEnvDiffuse',canonical='apsCanonical'+fn;
   if(!original?.code.includes('fn '+fn+'('))throw Error('Pinned IBL hook changed: '+fn);
   const base=new ShaderModule({name:original.name+'-canonical',deps:original.deps,bindings:original.bindings,
    code:original.code.replace(new RegExp('\\b'+fn+'\\b','g'),canonical)});
   result[key]=new ShaderModule({name:original.name+'-yaw',deps:[base,this.module],code:key==='envSpecular'?
    `fn ${fn}(R:vec3f,roughness:f32)->vec3f{return ${canonical}(apsEnvironmentDirection(R),roughness);}`:
    `fn ${fn}(N:vec3f)->vec3f{return ${canonical}(apsEnvironmentDirection(N));}`});
  }
  return result;
 }
 dispose(){this.params.buffer?.destroy();this.params.buffer=null;}
}
