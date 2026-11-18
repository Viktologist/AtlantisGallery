                                                                              
                                                                                
                                                                               
export function fillModelMaterialPalette(prototypes,buffer){
  const ranges=new Map();let size=0;
  for(const model of prototypes){const partCount=model.parts.length;ranges.set(model.signature,{offset:size,partCount});size+=model.instances.length*partCount;}
                                                                                 
  if(size>16777216)throw Error('Model material palette exceeds exact f32 draw-offset range');
  const data=new Uint32Array(Math.max(1,size));
  for(const model of prototypes){const range=ranges.get(model.signature);model.instances.forEach((instance,i)=>{
    if(instance.source_parts.length!==range.partCount)throw Error('Model material palette part count differs from native occurrence');
    instance.source_parts.forEach((part,slot)=>{if(!Number.isInteger(part.materialId)||part.materialId<0||part.materialId>4294967295)throw Error('Invalid native palette material ID');data[range.offset+i*range.partCount+slot]=part.materialId;});
  });}
  buffer.count=data.length;buffer.byteLength=Math.max(16,data.byteLength);buffer.pendingData=data;
  return {data,ranges,entries:size};
}
