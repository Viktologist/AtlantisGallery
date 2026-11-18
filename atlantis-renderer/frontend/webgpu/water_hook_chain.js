                                                                         
                                                                          
export function unlinkWaterHook(renderer, target, replacement) {
  if (!renderer || !target) return;
  if (renderer.onBeforeWater === target) {
    renderer.onBeforeWater = replacement ?? null;
    return;
  }
  let hook = renderer.onBeforeWater;
  const visited = new Set();
  while (hook && !visited.has(hook)) {
    visited.add(hook);
    if (!hook.oceanOwner && !hook.apsInlandOwner && !hook.apsPoolOwner) return;
    if (hook.base === target) {
      hook.base = replacement ?? null;
      if (hook.apsInlandOwner) hook.apsInlandOwner.previousBeforeWater = hook.base;
      return;
    }
    hook = hook.base;
  }
}
