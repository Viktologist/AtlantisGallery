import {ShaderModule} from '../../vendor/tidewater/src/engine/webgpu.js';

                                                                              
                                                                        
                                                                         
export const NORMAL_GUARD_WGSL=          `
fn apsConsistentNormal(n:vec3f,N:vec3f,V:vec3f,L:vec3f)->vec3f {
 let viewOpposite=dot(n,V)*dot(N,V)<0.0;
 let lightOpposite=dot(n,L)*dot(N,L)<0.0;
 return select(n,N,viewOpposite||lightOpposite);
}
`;
export const normalGuardModule=new ShaderModule({name:'aps-normal-hemisphere-guard',code:NORMAL_GUARD_WGSL});
