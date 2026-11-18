                                                                               
                                                                       
                                                            
export const QUICK_CAMERAS=Object.freeze([
 Object.freeze({label:'全岛',camera:'全岛'}),
 Object.freeze({label:'改造区',camera:'度假区总览'})
]);
export const INTERVENTION_BUTTONS=Object.freeze([
 Object.freeze({state:'before',label:'改造前'}),
 Object.freeze({state:'after',label:'改造后'})
]);

export function availableQuickCameras(document,{legacy=false}={}){
 const cameras=document?.cameras;
 if(legacy||!cameras||typeof cameras!=='object'||Array.isArray(cameras))return [];
 return QUICK_CAMERAS.filter(item=>cameras[item.camera]&&cameras[item.camera].fit!==true).map(item=>({...item}));
}

export function interventionBarState({feature=null,state=null,loaded=false,loading=false}={}){
 const visible=!!feature,ready=visible&&!!loaded&&!loading;
 const current=state??feature?.metadata?.().state??null;
 return {visible,ready,state:current,buttons:INTERVENTION_BUTTONS.map(button=>({...button,
  pressed:current===button.state,disabled:!ready}))};
}

export function quickBarModel({document=null,feature=null,state=null,loaded=false,loading=false,legacy=false}={}){
 const intervention=interventionBarState({feature,state,loaded,loading});
 const cameras=availableQuickCameras(document,{legacy});
 const ready=!!loaded&&!loading;
 return {visible:intervention.visible||cameras.length>0,ready,intervention,
  cameras:cameras.map(item=>({...item,disabled:!ready}))};
}
