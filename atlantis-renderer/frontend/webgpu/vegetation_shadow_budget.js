export function vegetationShadowBudget(value={}){
 const result={lodScale:2,minLOD:1,grassStart:4,grassEnd:8,grassLevels:1,grassRefresh:1,...value};
 if(!(Number.isFinite(result.lodScale)&&result.lodScale>=1)||!Number.isInteger(result.minLOD)||result.minLOD<0||result.minLOD>2||
 !Number.isFinite(result.grassStart)||!Number.isFinite(result.grassEnd)||result.grassStart<0||result.grassEnd<=result.grassStart||
 !Number.isInteger(result.grassLevels)||result.grassLevels<0||result.grassLevels>4||!(Number.isFinite(result.grassRefresh)&&result.grassRefresh>0))throw Error('Invalid vegetation shadow budget');
 return result;
}
