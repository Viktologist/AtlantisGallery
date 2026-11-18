                                
  
                                                                       
                                                                             
                                                                              
                                                                             
  
                                                                             
                                                                                
                                                                            

export const SHADOW_POLICY_SCHEMA='aps-shadow-caster-policy/1';
export const SHADOW_CASTER_MOTION=Object.freeze({STATIC:'static',DYNAMIC:'dynamic'});

function componentLabel(component){
  return component?.id??component?.name??component?.constructor?.name??'component';
}

                                                                              
                                                                              
                                                                                 
                                                                            
export function componentShadowMotion(component,viewer=null){
  if(component==null)return null;
  const declared=component.shadowCasterMotion??component.shadow_caster_motion??component.userData?.shadowCasterMotion;
  if(declared==='static'||declared==='dynamic')return declared;
  if(component.lightingOnly===true||component.shadowCaster===false)return 'static';
  if(viewer?.indoorLPV===component)return 'static';
  if(viewer?.boundedWaters?.has?.(component))return 'static';
                                                                    
  return 'dynamic';
}

function declaresDynamicShadow(asset){
  return asset?.dynamicShadow===true||asset?.userData?.dynamicShadow===true;
}

export function shadowCasterPolicy(viewer=null){
  const reasons=[],staticComponents=[];
  if(declaresDynamicShadow(viewer?.meshAsset))reasons.push('mesh_asset_dynamic');
  for(const asset of viewer?.meshCompanions??[])if(declaresDynamicShadow(asset))reasons.push('mesh_companion_dynamic:'+componentLabel(asset));
  for(const component of viewer?.components??[]){
    if(componentShadowMotion(component,viewer)==='dynamic')reasons.push('component_dynamic:'+componentLabel(component));
    else staticComponents.push(componentLabel(component));
  }
  return {schema:SHADOW_POLICY_SCHEMA,dynamic:reasons.length>0,reasons,static_components:staticComponents};
}
