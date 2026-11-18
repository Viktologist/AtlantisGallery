                                                                               
                                                                                
                                                                               
                                                                                   
  
                                                                  
                                     
                                      
                                                     
                                                                                
                                                                                 
  
                                                     
                                                                
                                                                           
                                                                               
                                                                          

export const INTERVENTION_UNIFORM_FLOATS=8;
export const INTERVENTION_UNIFORM_BYTES=INTERVENTION_UNIFORM_FLOATS*4;

const finite=value=>typeof value==='number'&&Number.isFinite(value);
const pair=value=>Array.isArray(value)||ArrayBuffer.isView(value);

export function nativeInterventionRegistration(native){
 if(!native||!pair(native.origin)||!pair(native.spacing)||!pair(native.shape))throw Error('Intervention registration requires native.origin/spacing/shape');
 const [originX,originZ]=Array.from(native.origin),[spacingX,spacingZ]=Array.from(native.spacing),[height,width]=Array.from(native.shape);
 if(![originX,originZ,spacingX,spacingZ,width,height].every(finite)||!(spacingX>0)||!(spacingZ>0)||width<2||height<2)throw Error('Invalid native intervention registration');
 return Object.freeze({origin:Object.freeze([originX,originZ]),spacing:Object.freeze([spacingX,spacingZ]),shape:Object.freeze([height,width]),width,height});
}

export function interventionUniforms(registration,{enabled=false,version=0}={}){
 const out=new Float32Array(INTERVENTION_UNIFORM_FLOATS);
 if(!registration)return out;
 out.set(registration.origin,0);out.set(registration.spacing,2);
 out[4]=registration.width;out[5]=registration.height;out[6]=enabled?1:0;out[7]=version>>>0;
 return out;
}

                                                                             
export function sampleInterventionMask(data,width,height,registration,x,z){
 if(!registration||!data||!width||!height)return 0;
 const gx=(x-registration.origin[0])/registration.spacing[0],gz=(z-registration.origin[1])/registration.spacing[1];
 if(!(gx>=0&&gz>=0&&gx<=registration.width-1&&gz<=registration.height-1))return 0;
 const tx=width>1?gx*(width-1)/(registration.width-1):0,tz=height>1?gz*(height-1)/(registration.height-1):0;
 const x0=Math.min(Math.max(Math.floor(tx),0),Math.max(width-2,0)),z0=Math.min(Math.max(Math.floor(tz),0),Math.max(height-2,0));
 const x1=Math.min(x0+1,width-1),z1=Math.min(z0+1,height-1),fx=Math.min(Math.max(tx-x0,0),1),fz=Math.min(Math.max(tz-z0,0),1);
 const a=data[z0*width+x0]??0,b=data[z0*width+x1]??0,c=data[z1*width+x0]??0,d=data[z1*width+x1]??0;
 return (a*(1-fx)+b*fx)*(1-fz)+(c*(1-fx)+d*fx)*fz;
}

export function rootTranslation(elements){
 if(!elements||elements.length<16)throw Error('Native instance matrix must have 16 elements');
 return [elements[12],elements[14]];
}

                                                                             
                                                                  
export function rootBlocked(elements,{data,width,height,registration,enabled=true}={}){
 if(!enabled||!registration||!data)return false;
 const [x,z]=rootTranslation(elements);
 return sampleInterventionMask(data,width,height,registration,x,z)>.5;
}

const textureVersion=texture=>texture?.version??0;
const sameRegistration=(a,b)=>a===b||(!!a&&!!b&&a.origin[0]===b.origin[0]&&a.origin[1]===b.origin[1]&&a.spacing[0]===b.spacing[0]&&a.spacing[1]===b.spacing[1]&&a.width===b.width&&a.height===b.height);

export class VegetationIntervention{
 constructor({device=null,native=null,source=null}={}){
  this.device=device;this.native=native;this.source=null;this.registration=native?nativeInterventionRegistration(native):null;
  this.maskTexture=null;this.heightTexture=null;this.baseHeightTexture=null;this.enabled=false;this.version=0;this.sourceRevision=0;
  this.uniforms=interventionUniforms(this.registration);this.uniformBuffer=null;this.fallbackMask=null;
  this.missingRegistration=false;
  if(source)this.set(source,{native});
 }
 initGPU(device=this.device){
  if(!device)throw Error('Intervention GPU resources require a device');
  this.device=device;
  if(!this.fallbackMask){
   this.fallbackMask=device.createTexture({label:'APS inactive intervention mask',size:[1,1],format:'r32float',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});
   device.queue.writeTexture({texture:this.fallbackMask},new Float32Array([0]),{bytesPerRow:4},[1,1]);
  }
  this.uniformBuffer??=device.createBuffer({label:'APS vegetation intervention registration',size:INTERVENTION_UNIFORM_BYTES,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
  this.writeUniform();return this;
 }
 set(source,{native=null}={}){
  if(native)this.native=native;
  if(!this.native&&source?.native)this.native=source.native;
  const nextRegistration=this.native?nativeInterventionRegistration(this.native):this.registration;
  const maskTexture=source?.maskTexture??null,heightTexture=source?.heightTexture??null,baseHeightTexture=source?.baseHeightTexture??null;
  const enabledFlag=!maskTexture?false:(source?.enabled??source?.after??true)!==false;
  const revision=source?.revision??0;
  const maskChanged=maskTexture!==this.maskTexture||textureVersion(maskTexture)!==textureVersion(this.maskTexture);
  const heightChanged=heightTexture!==this.heightTexture||textureVersion(heightTexture)!==textureVersion(this.heightTexture);
  const enabledChanged=enabledFlag!==this.enabled;
  const registrationChanged=!sameRegistration(this.registration,nextRegistration);
  const revisionChanged=revision!==this.sourceRevision;
  const changed=maskChanged||heightChanged||enabledChanged||registrationChanged||revisionChanged;
  this.registration=nextRegistration;this.source=source;this.baseHeightTexture=baseHeightTexture;
  if(!changed){
   this.missingRegistration=!!maskTexture&&!this.registration;
   return {changed:false,maskChanged:false,heightChanged:false,enabledChanged:false,registrationChanged:false,revisionChanged:false,missingRegistration:this.missingRegistration,version:this.version,enabled:this.enabled};
  }
  this.maskTexture=maskTexture;this.heightTexture=heightTexture;this.baseHeightTexture=baseHeightTexture;this.enabled=enabledFlag;this.sourceRevision=revision;
  this.missingRegistration=!!maskTexture&&!this.registration;
  this.version=(this.version+1)>>>0;
  this.uniforms=interventionUniforms(this.registration,{enabled:this.enabled&&!!this.registration,version:this.version});
  this.writeUniform();
  return {changed,maskChanged,heightChanged,enabledChanged,registrationChanged,revisionChanged,missingRegistration:this.missingRegistration,version:this.version,enabled:this.enabled};
 }
 sync(source,{native=null}={}){return this.set(source,{native});}
 writeUniform(){if(this.uniformBuffer&&this.device)this.device.queue.writeBuffer(this.uniformBuffer,0,this.uniforms);}
 maskView(){
  const texture=this.maskTexture;
  if(texture)return typeof texture.view==='function'?texture.view():texture.createView();
  return this.fallbackMask?.createView()??null;
 }
 heightView(){
  const texture=this.heightTexture;
  if(!texture)return null;
  return typeof texture.view==='function'?texture.view():texture.createView();
 }
 metadata(){
  return {schema:'aps-vegetation-intervention/1',enabled:this.enabled,version:this.version,mask_attached:!!this.maskTexture,height_attached:!!this.heightTexture,base_height_attached:!!this.baseHeightTexture,
   registration:this.registration?{origin:[...this.registration.origin],spacing:[...this.registration.spacing],shape:[...this.registration.shape]}:null,
   uniform:{originSpacing:Array.from(this.uniforms.slice(0,4)),shapeEnabled:Array.from(this.uniforms.slice(4,8))},missing_registration:this.missingRegistration};
 }
 dispose(){this.fallbackMask?.destroy();this.fallbackMask=null;this.uniformBuffer?.destroy();this.uniformBuffer=null;}
}
