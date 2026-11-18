                                                                            
export function normalizeRenderScale(value=1) {
  if(!Number.isFinite(value)||value<1||value>2)throw RangeError('renderScale must be between 1 and 2');
  return value;
}
export function renderResolution(width,height,pixelRatio=1,renderScale=1,maxDimension=8192) {
  normalizeRenderScale(renderScale);
  if(![width,height,pixelRatio,maxDimension].every(Number.isFinite)||width<0||height<0||pixelRatio<=0||maxDimension<1)throw RangeError('Invalid render dimensions');
  const cssWidth=Math.max(1,width),cssHeight=Math.max(1,height);
  const requestedRatio=pixelRatio*renderScale;
  const ratio=Math.min(requestedRatio,maxDimension/cssWidth,maxDimension/cssHeight);
  return {width:Math.max(1,Math.floor(cssWidth*ratio)),height:Math.max(1,Math.floor(cssHeight*ratio)),cssWidth,cssHeight,requestedRatio,ratio,limited:ratio<requestedRatio};
}
