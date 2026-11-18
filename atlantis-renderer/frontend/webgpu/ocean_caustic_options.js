                                                                             
                                                                                  
export const CAUSTIC_CASCADE_OPTIONS=Object.freeze([
 {mask:1,label:'第 1 层 · 512m（最粗）'},
 {mask:2,label:'第 2 层 · 128m'},
 {mask:4,label:'第 3 层 · 32m'},
 {mask:8,label:'第 4 层 · 8m（最细）'},
 {mask:3,label:'叠加 1–2 层 · 512 + 128m'},
 {mask:7,label:'叠加 1–3 层 · 512 + 128 + 32m'},
 {mask:15,label:'叠加全部 4 层'}
]);
export const CAUSTIC_ACCEPTED_SETTINGS=Object.freeze({cascadeMask:15,minimumStep:0.15});
                                                                
export function causticCascadeMask(value=CAUSTIC_ACCEPTED_SETTINGS.cascadeMask){return value;}
                                                           
export const CAUSTIC_FILTER_OPTIONS=Object.freeze([
 {step:1/128,label:'原始细节 · 不额外柔化'},
 {step:0.05,label:'轻度柔化 · 5cm'},
 {step:0.15,label:'中度柔化 · 15cm'},
 {step:0.5,label:'强柔化 · 50cm（之前的限制）'}
]);
export function causticMinimumStep(value=CAUSTIC_ACCEPTED_SETTINGS.minimumStep){return value;}
export function mountCausticFilterControl(viewer,anchor,publish){
 const label=document.createElement('label');label.textContent='焦散柔化';
 const select=document.createElement('select');select.id='caustic-filter';
 const step=viewer.ocean?.caustics?.params.get('minimumStep')??CAUSTIC_ACCEPTED_SETTINGS.minimumStep;
 for(const option of CAUSTIC_FILTER_OPTIONS){const e=document.createElement('option');e.value=option.step;e.textContent=option.label;select.append(e);}
 if(!CAUSTIC_FILTER_OPTIONS.some(o=>o.step===step)){const e=document.createElement('option');e.value=step;e.textContent='场景指定柔化';select.append(e);}
 select.value=step;select.title='FFT 层叠加之后的额外空间柔化；原始细节仍按画面像素过滤';
 label.append(select);anchor.after(label);label.hidden=!viewer.ocean;
 select.onchange=()=>{viewer.ocean?.setCausticMinimumStep(Number(select.value));publish();};return select;
}
export function mountCausticCascadeControl(viewer,anchor,publish){
 const label=document.createElement('label');label.textContent='焦散 FFT';
 const select=document.createElement('select');select.id='caustic-fft';
 for(const {mask,label} of CAUSTIC_CASCADE_OPTIONS){const option=document.createElement('option');option.value=mask;option.textContent=label;select.append(option);}
 const mask=viewer.ocean?.caustics?.params.get('cascadeMask')??CAUSTIC_ACCEPTED_SETTINGS.cascadeMask;
 if(!CAUSTIC_CASCADE_OPTIONS.some(option=>option.mask===mask)){const option=document.createElement('option');option.value=mask;option.textContent='场景指定组合';select.append(option);}
 select.value=mask;select.title='只选择焦散使用的 FFT 层；保持水面运动';label.append(select);anchor.after(label);label.hidden=!viewer.ocean;
 select.onchange=()=>{viewer.ocean?.setCausticCascadeMask(Number(select.value));publish();};
 return select;
}
