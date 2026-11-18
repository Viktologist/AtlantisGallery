export function dailyCloudSlots(hour){
  if(!Number.isFinite(hour))throw new TypeError('Cloud time must be finite');
  const position=((hour%24)+24)%24*2,first=Math.floor(position);
  return {first,second:(first+1)%48,weight:position-first};
}
export function cloudGeometryKey(weather,field){
  return JSON.stringify(['sun-volume-128-capped64-v1',field.resolution,field.slices,field.spans,
    ...['cloudCoverage','cloudDensity','cloudAltitude','cloudThickness','cloudSeed','cloudTime','groundHeight'].map(k=>weather[k])]);
}
