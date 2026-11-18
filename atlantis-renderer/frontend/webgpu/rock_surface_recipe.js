                                                                                 
import {rockSurfaceConfig as plates,createRockSurfaceWGSL as plateWGSL} from './rock_plate_surface.js';
import {lygiaRockConfig,createLygiaRockWGSL} from './rock_lygia_surface.js';
export const rockSurfaceConfig=input=>input?.schema==='aps-rock-lygia/1'?lygiaRockConfig(input):plates(input);
export const createRockSurfaceWGSL=input=>input?.schema==='aps-rock-lygia/1'?createLygiaRockWGSL(input):plateWGSL(input);
