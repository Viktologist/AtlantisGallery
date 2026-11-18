import {buildPlantLODs} from './plant_lod_builder.js';
self.onmessage=async ({data})=>{try{const result=await buildPlantLODs(data.buffer,{required:true,sourceSHA:data.sourceSHA});self.postMessage({id:data.id,...result},[result.buffer]);}catch(e){self.postMessage({id:data.id,error:e?.message??String(e)});}};
