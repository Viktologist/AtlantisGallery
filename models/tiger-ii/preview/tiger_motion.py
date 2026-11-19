"""Portable game vehicle motion. Python standard library only; metres/radians/seconds.

Flat-ground differential drive and procedural closed-path tracks, not a contact
simulation. Hosts supply inputs, draw local matrices and choose their camera.
"""
import bisect
import copy
import math


def clamp(x, lo, hi):
    return max(lo, min(hi, x))


def wrap(x):
    return math.atan2(math.sin(x), math.cos(x))


def approach(x, target, amount):
    return x + clamp(target - x, -amount, amount)


def matrix(position=(0, 0, 0), axis=(0, 0, 1), angle=0):
    x, y, z = axis
    c, s, t = math.cos(angle), math.sin(angle), 1 - math.cos(angle)
    return [t*x*x+c, t*x*y+s*z, t*x*z-s*y, 0,
            t*x*y-s*z, t*y*y+c, t*y*z+s*x, 0,
            t*x*z+s*y, t*y*z-s*x, t*z*z+c, 0,
            *position, 1]


def multiply(a, b):
    return [sum(a[k*4+r] * b[c*4+k] for k in range(4))
            for c in range(4) for r in range(4)]


class Vehicle:
    def __init__(self, config):
        self.config = copy.deepcopy(config)
        self.path = config['path_xz']
        self.arc = [0.0]
        for a, b in zip(self.path, self.path[1:] + self.path[:1]):
            self.arc.append(self.arc[-1] + math.hypot(b[0]-a[0], b[1]-a[1]))
        self.reset()

    def reset(self):
        self.state = dict(time=0., x=0., y=0., yaw=0., left_speed=0., right_speed=0.,
                          left_distance=0., right_distance=0., turret=0., elevation=0., joints={})
        self.inputs = dict(throttle=0., steer=0., aim_yaw=0., elevation=0., enabled=False)

    def save(self):
        return copy.deepcopy(dict(schema='atlantis-vehicle-state/1', state=self.state, inputs=self.inputs))

    def restore(self, saved):
        if saved.get('schema') != 'atlantis-vehicle-state/1':
            raise ValueError('Unsupported vehicle state')
        candidate = copy.deepcopy(saved)
        for value in list(candidate['state'].values()) + list(candidate['inputs'].values()):
            if isinstance(value, (float, int)) and not math.isfinite(value):
                raise ValueError('State contains non-finite value')
        self.state, self.inputs = candidate['state'], candidate['inputs']

    def advance(self, dt):
        if not isinstance(dt, (int, float)) or not math.isfinite(dt) or dt < 0 or dt > .25:
            raise ValueError('dt must be finite and in [0, .25] seconds')
        # Substeps give identical limits in browser and Isaac, including long frames.
        count = max(1, math.ceil(dt / (1/120)))
        for _ in range(count):
            self._advance(dt/count)

    def _advance(self, dt):
        c, s, i = self.config, self.state, self.inputs
        throttle = clamp(float(i['throttle']), -1, 1) if i['enabled'] else 0
        steer = clamp(float(i['steer']), -1, 1) if i['enabled'] else 0
        left, right = throttle-steer, throttle+steer
        scale = max(1., abs(left), abs(right))
        speeds = []
        for side, demand in zip(('left', 'right'), (left/scale, right/scale)):
            target = demand * (c['forward_speed'] if demand >= 0 else c['reverse_speed'])
            old = s[side+'_speed']
            rate = c['acceleration'] if old*target >= 0 and abs(target) > abs(old) else c['braking']
            new = approach(old, target, rate*dt)
            distance = (old+new)*.5*dt
            s[side+'_speed'] = new
            s[side+'_distance'] += distance
            speeds.append(distance)
        ds = (speeds[0]+speeds[1])*.5
        dyaw = (speeds[1]-speeds[0])/c['track_gauge']
        # Exact constant-curvature midpoint integration, stable at zero turn.
        factor = math.sin(dyaw*.5)/(dyaw*.5) if abs(dyaw) > 1e-10 else 1.
        s['x'] += ds*factor*math.cos(s['yaw']+dyaw*.5)
        s['y'] += ds*factor*math.sin(s['yaw']+dyaw*.5)
        s['yaw'] = wrap(s['yaw']+dyaw)
        error = wrap(float(i['aim_yaw'])-s['yaw']-s['turret'])
        s['turret'] = wrap(s['turret'] + clamp(error*3., -c['turret_rate'], c['turret_rate'])*dt)
        goal = clamp(float(i['elevation']), c['gun_min'], c['gun_max'])
        s['elevation'] = approach(s['elevation'], goal, c['gun_rate']*dt)
        for name, target in i.get('joints', {}).items():
            joint = c['hinges'].get(name)
            if joint:
                s['joints'][name] = approach(s['joints'].get(name, 0), clamp(target, *joint['limits']), joint['speed']*dt)
        s['time'] += dt

    def point(self, distance):
        d = distance % self.arc[-1]
        j = min(len(self.path)-1, bisect.bisect_right(self.arc, d)-1)
        a, b = self.path[j], self.path[(j+1) % len(self.path)]
        u = (d-self.arc[j]) / max(1e-12, self.arc[j+1]-self.arc[j])
        return [a[k]+(b[k]-a[k])*u for k in (0, 1)]

    def poses(self):
        c, s = self.config, self.state
        out = {'hull': matrix((s['x'], s['y'], c['ground_lift']), angle=s['yaw'])}
        out['turret_yaw'] = multiply(c['rest']['turret_yaw'], matrix(angle=s['turret']))
        out['gun_elevation'] = multiply(c['rest']['gun_elevation'], matrix(axis=(0, 1, 0), angle=-s['elevation']))
        for wheel in c['wheels']:
            side = 'left' if wheel['side'] == 'L' else 'right'
            out[wheel['name']] = multiply(wheel['rest'], matrix(axis=(0, 1, 0), angle=s[side+'_distance']/wheel['radius']))
        for name, hinge in c['hinges'].items():
            angle = s['joints'].get(name, 0.)
            out[name] = multiply(c['rest'][name], matrix(axis=hinge['axis'], angle=angle))
        for side, label in (('left', 'L'), ('right', 'R')):
            phase = s[side+'_distance']
            for link in c['links'][label]:
                a, b = self.point(link['start']+phase), self.point(link['end']+phase)
                dx, dz = b[0]-a[0], b[1]-a[1]
                length = math.hypot(dx, dz)
                tx, tz = dx/length, dz/length
                out[link['name']] = [tx, 0, tz, 0, 0, 1, 0, 0, -tz, 0, tx, 0,
                                     (a[0]+b[0])*.5, 0, (a[1]+b[1])*.5, 1]
        return out

    def snapshot(self):
        return dict(schema='atlantis-vehicle-frame/1', state=copy.deepcopy(self.state), matrices=self.poses())

    def step(self, events, elapsed):
        for name, value in events:
            if name == 'reset':
                self.reset()
            elif name == 'input':
                for key in ('throttle', 'steer', 'aim_yaw', 'elevation', 'enabled'):
                    if key in value:
                        self.inputs[key] = value[key]
            elif name == 'joint':
                self.inputs.setdefault('joints', {})[value['name']] = float(value['angle'])
            elif name == 'restore':
                self.restore(value)
        self.advance(elapsed)
        return self.snapshot()


def create_runtime(config):
    return Vehicle(config)
