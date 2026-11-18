export function validateVegetationLOD(mode){
  if(!['auto',0,1,2].includes(mode))throw Error('Vegetation LOD must be auto, 0, 1 or 2');
  return mode;
}

                                                                        
export function vegetationLODMask(mode,residentMask){
  validateVegetationLOD(mode);
  if(!Number.isInteger(residentMask)||residentMask<1||residentMask>7)throw Error('Invalid resident vegetation LOD mask');
  if(mode==='auto')return residentMask;
  for(let level=mode;level<3;level++)if(residentMask&(1<<level))return 1<<level;
  for(let level=mode-1;level>=0;level--)if(residentMask&(1<<level))return 1<<level;
}
