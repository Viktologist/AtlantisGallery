import {ShaderModule} from '../../vendor/tidewater/src/engine/gpu/Shader.js';
import {SceneLighting} from '../../vendor/tidewater/src/engine/render/wgsl/lighting.js';

                                                                              
                                                                              
export const receiverShadowModule=new ShaderModule({name:'apsReceiverShadowPolicy',code:''});
Object.defineProperty(receiverShadowModule,'code',{get(){
 const hook=SceneLighting.hooks.directModulation;
 const supported=hook&&/fn\s+apsHookReceiverShadow\(/.test(hook.code);
 return `fn apsReceiverSunShadow(P:vec3f,visibility:f32)->f32{return ${supported?'apsHookReceiverShadow(P,visibility)':'visibility'};}`;
}});
