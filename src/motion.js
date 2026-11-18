import { Quaternion, Vector3 } from 'three';
import { PythonLogic } from './python-logic.js';

const finite = Number.isFinite;
const vector = value => Array.isArray(value) && value.length === 3 && value.every(finite);
const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
const list = value => Array.isArray(value) ? value : [];

export class MotionRuntime {
  constructor(root, panel, spec = {}) {
    this.root = root;
    this.panel = panel;
    this.joints = new Map();
    this.buttons = new Map();
    this.targets = new Map();
    this.frames = [];
    this.errors = [];
    this.events = new EventTarget();
    if (spec.schema && !['atlantis-gallery-interactions/1', 'atlantis-gallery-interactions/2'].includes(spec.schema)) {
      this.errors.push('Unsupported interaction schema version');
      return;
    }
    for (const joint of list(spec.joints)) this.addJoint(joint);
    for (const button of list(spec.buttons)) this.addButton(button);
    if (spec.logic) this.addLogic(spec.logic);
  }

  resolve(selector) {
    if (typeof selector !== 'string' || !selector) throw Error('Missing part path');
    const matches = [];
    this.root.traverse(node => {
      if (!selector.startsWith('/')) {
        if (node.name === selector) matches.push(node);
        return;
      }
      const parts = [];
      for (let item = node; item && item !== this.root; item = item.parent) {
        if (item.name) parts.unshift(item.name);
      }
      if (node !== this.root && '/' + parts.join('/') === selector) matches.push(node);
    });
    if (matches.length !== 1) throw Error(matches.length ? `Multiple parts match ${selector}` : `Part not found (${selector})`);
    return matches[0];
  }

  addJoint(config) {
    try {
      const { id, kind, limits, axis = [0, 1, 0], pivot = [0, 0, 0], initial = 0, speed = 1.5 } = config;
      if (!id || this.joints.has(id) || !['rotation', 'translation', 'spin'].includes(kind)
          || !vector(axis) || !axis.some(Boolean) || !vector(pivot) || !finite(initial) || !finite(speed) || speed <= 0
          || (kind !== 'spin' && (!Array.isArray(limits) || limits.length !== 2 || !limits.every(finite) || limits[0] >= limits[1]))) {
        throw Error('Invalid joint parameters');
      }
      const node = this.resolve(config.node);
      if ([...this.joints.values()].some(joint => joint.node === node)) throw Error('Multiple joints are bound to the same part');
      if (node.matrixAutoUpdate) node.updateMatrix();
      const position = new Vector3(), rotation = new Quaternion(), scale = new Vector3();
      node.matrix.decompose(position, rotation, scale);
      const [min, max] = limits ?? [-Infinity, Infinity];
      const state = {
        node, kind, speed, min, max, position, rotation, scale,
        axis: new Vector3(...axis).normalize(), pivot: new Vector3(...pivot).multiply(scale),
        value: kind === 'spin' ? 0 : clamp(initial, min, max),
        velocity: kind === 'spin' ? initial : 0,
        delta: new Quaternion(), offset: new Vector3(),
      };
      state.target = state.value;
      this.joints.set(id, state);
      if (config.slider !== false && kind !== 'spin') {
        const label = document.createElement('label');
        label.className = 'slider';
        const title = document.createElement('span');
        title.textContent = config.label || id;
        const input = document.createElement('input');
        input.type = 'range';
        input.min = min;
        input.max = max;
        input.step = (max - min) / 500;
        input.addEventListener('input', () => {
          state.value = state.target = Number(input.value);
          this.apply(state);
        });
        state.input = input;
        label.append(title, input);
        this.panel.append(label);
      }
      this.apply(state);
    } catch (error) {
      this.errors.push(`Joint ${config?.id || '?'} (${error.message})`);
    }
  }

  action(config) {
    const joint = this.joints.get(config.joint);
    const fits = v => joint && finite(v) && v >= joint.min && v <= joint.max;
    switch (config.type) {
      case 'set':
        if (joint?.kind !== 'spin' && fits(config.value)) return () => { joint.target = config.value; };
        break;
      case 'toggle': {
        const [a, b] = Array.isArray(config.values) ? config.values : [];
        if (joint?.kind !== 'spin' && fits(a) && fits(b) && a !== b) {
          return () => { joint.target = Math.abs(joint.target - a) <= Math.abs(joint.target - b) ? b : a; };
        }
        break;
      }
      case 'spin':
        if (joint?.kind === 'spin' && finite(config.value)) return () => { joint.velocity = config.value; };
        break;
      case 'visible': {
        const node = this.resolve(config.node);
        if (typeof config.value === 'boolean') return () => { node.visible = config.value; };
        break;
      }
      case 'emit':
        if (typeof config.event === 'string' && config.event) {
          return () => this.emit(config.event, config.value);
        }
        break;
    }
    throw Error(`Invalid action (${config.type || '?'})`);
  }

  emit(event, value) {
    this.events.dispatchEvent(new CustomEvent(event, { detail: value }));
    this.root.dispatchEvent({ type: 'atlantis:emit', event, value });
    this.logic?.event(event, value);
  }

  addButton(config) {
    try {
      if (!config.id || this.buttons.has(config.id)) throw Error('Missing or duplicate button ID');
      const actions = (config.actions ?? [{ ...config, type: config.action }]).map(action => this.action(action));
      if (!actions.length) throw Error('Missing button action');
      const target = config.node ? this.resolve(config.node) : null;
      if (target && this.targets.has(target)) throw Error('Multiple buttons are bound to the same part');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'interaction-button';
      button.textContent = config.label || config.id;
      const invoke = () => { for (const action of actions) action(); };
      button.addEventListener('click', invoke);
      this.buttons.set(config.id, { invoke, button });
      if (target) this.targets.set(target, invoke);
      this.panel.append(button);
    } catch (error) {
      this.errors.push(`Button ${config?.id || '?'} (${error.message})`);
    }
  }

  addLogic(config) {
    try {
      const values = list(config.bindings).map(binding => {
        const joint = this.joints.get(binding.joint);
        if (typeof binding.state !== 'string' || !binding.state ||
            ![binding.equals, binding.on, binding.off].every(value => value === undefined || ['number','string','boolean'].includes(typeof value))) {
          throw Error('Invalid Python state binding');
        }
        if (binding.type === 'visible') {
          const node = this.resolve(binding.node);
          return snapshot => { node.visible = Object.hasOwn(binding, 'equals') ? snapshot[binding.state] === binding.equals : Boolean(snapshot[binding.state]); };
        }
        if (!joint) throw Error(`Joint not found (${binding.joint})`);
        if (binding.type === 'spin' && joint.kind === 'spin' && finite(binding.on) && finite(binding.off ?? 0)) {
          return snapshot => { joint.velocity = snapshot[binding.state] === binding.equals ? binding.on : binding.off ?? 0; };
        }
        if (binding.type === 'set' && joint.kind !== 'spin' && finite(binding.on) && finite(binding.off)) {
          return snapshot => {
            const value = snapshot[binding.state] === binding.equals ? binding.on : binding.off;
            joint.target = clamp(value, joint.min, joint.max);
          };
        }
        throw Error('Invalid Python state binding');
      });
      if (config.display) {
        this.display = document.createElement('output');
        this.display.className = 'motion-display';
        this.display.setAttribute('aria-label', config.display === true ? 'Model display' : String(config.display));
        this.panel.prepend(this.display);
      }
      this.logic = new PythonLogic(config.profile, snapshot => {
        for (const update of values) update(snapshot);
        if (this.display) this.display.textContent = snapshot.display;
      }, error => this.panel.dispatchEvent(new CustomEvent('motionerror', { bubbles: true, detail: error })));
    } catch (error) {
      this.display?.remove();
      this.errors.push(`Interaction logic (${error.message})`);
    }
  }

  apply(state) {
    const { node, kind, position, rotation, scale, value, axis, pivot, delta, offset } = state;
    node.position.copy(position);
    node.quaternion.copy(rotation);
    node.scale.copy(scale);
    if (kind === 'rotation' || kind === 'spin') {
      delta.setFromAxisAngle(axis, value);
      node.quaternion.multiply(delta);
      offset.copy(pivot).applyQuaternion(delta).negate().add(pivot).applyQuaternion(rotation);
      node.position.add(offset);
    } else {
      offset.copy(axis).applyQuaternion(rotation);
      node.position.addScaledVector(offset, value);
    }
    node.updateMatrix();
    if (state.input) state.input.value = String(value);
  }

  update(dt) {
    this.logic?.update();
    for (const state of this.joints.values()) {
      if (state.kind === 'spin') {
        if (!state.velocity) continue;
        state.value = (state.value + state.velocity * dt) % (2 * Math.PI);
      } else {
        const remaining = state.target - state.value;
        if (Math.abs(remaining) < 1e-7) continue;
        state.value += Math.sign(remaining) * Math.min(Math.abs(remaining), state.speed * dt);
      }
      this.apply(state);
    }
  }

  dispose() {
    this.logic?.dispose();
  }
}
