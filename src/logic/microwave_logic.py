"""Pure microwave state machine.

Semantic port of input/microwave_logic.mjs.  No DOM, rendering or glTF
dependency: the viewer adapter owns all rendering.

Units: every public duration is milliseconds.  The four-digit entry buffer is
interpreted as MMSS (130 -> 1:30); digits append up to four, shifting the
oldest, and start() validates the joined value (non-zero, seconds <= 59).
D1: 9959 -> 99:59; 5999 is invalid and keeps its input.
D2R: display priority is cooking/paused remaining, non-empty input, running
     kitchen timer, saved clock, then all off.  Colon is on for cooking,
     paused, the running timer and the saved clock; pure input has no colon.
D3: the kitchen timer runs independently of cooking and the door.
D4: door_open is an event; the runtime moves the real articulation joint.
D5: a saved clock advances by tick() in every state, including idle and
    door-open; cooking remaining decreases only while cooking with the door
    closed.
"""

import math
import re

MAX_REMAINING_MS = 5_999_000  # 99:59
ADD_30_MS = 30_000
POWER_DISPLAY_MS = 1_500
DEFROST_POWER_PCT = 30
POWER_LEVELS_PCT = (100, 90, 80, 70, 60, 50, 40, 30, 20, 10)

# Values mirrored from input/interaction_contract.json /behavior/presets and
# /behavior/presets_policy.start (immediate start, door must be closed).
PRESETS = {
    'preset_baked_potato': {'seconds': 240, 'powerPct': 100},
    'preset_popcorn': {'seconds': 150, 'powerPct': 100},
    'preset_pizza': {'seconds': 45, 'powerPct': 100},
    'preset_beverage': {'seconds': 90, 'powerPct': 100},
    'preset_frozen_dinner': {'seconds': 240, 'powerPct': 100},
    'preset_reheat': {'seconds': 120, 'powerPct': 80},
}

# Seven-segment contract copied from the design display font.  Kept here so
# both the logic tests and the runtime renderer share one mapping.
SEGMENT_FONT = {
    '0': 'abcdef',
    '1': 'bc',
    '2': 'abged',
    '3': 'abgcd',
    '4': 'fgbc',
    '5': 'afgcd',
    '6': 'afgecd',
    '7': 'abc',
    '8': 'abcdefg',
    '9': 'abcdfg',
    'P': 'abefg',
    'L': 'def',
    'H': 'bcefg',
    ' ': '',
    '-': 'g',
}

_NUMBER_PATTERN = re.compile(r'[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?\Z')
_HEX_PATTERN = re.compile(r'[+-]?0[xX][0-9a-fA-F]+\Z')
_BIN_PATTERN = re.compile(r'[+-]?0[bB][01]+\Z')
_OCT_PATTERN = re.compile(r'[+-]?0[oO][0-7]+\Z')
_DIGIT_ACTION = re.compile(r'digit_([0-9])$')
_NON_ASCII_DIGITS = re.compile(r'[^0-9]')


def _js_number(value):
    """Number(value) for the JSON-scalar inputs the state machine accepts."""
    if value is None:
        return 0.0
    if isinstance(value, bool):
        return 1.0 if value else 0.0
    if isinstance(value, (int, float)):
        try:
            return float(value)
        except OverflowError:
            return math.inf if value > 0 else -math.inf
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return 0.0
        if text in ('Infinity', '+Infinity'):
            return math.inf
        if text == '-Infinity':
            return -math.inf
        try:
            if _HEX_PATTERN.match(text):
                return float(int(text, 16))
            if _BIN_PATTERN.match(text):
                return float(int(text, 2))
            if _OCT_PATTERN.match(text):
                return float(int(text, 8))
            if _NUMBER_PATTERN.match(text):
                return float(text)
        except (ValueError, OverflowError):
            return math.nan
        return math.nan
    return math.nan


def _js_string(value):
    """String(value) for the scalar inputs used by dispatch/initialDigits."""
    if value is None:
        return 'null'
    if isinstance(value, bool):
        return 'true' if value else 'false'
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        if math.isnan(value):
            return 'NaN'
        if math.isinf(value):
            return 'Infinity' if value > 0 else '-Infinity'
        if value.is_integer():
            return str(int(value))
        return repr(value)
    if isinstance(value, str):
        return value
    if isinstance(value, (list, tuple)):
        return ','.join('' if item is None else _js_string(item) for item in value)
    if isinstance(value, dict):
        return '[object Object]'
    return str(value)


def _js_truthy(value):
    if value is None:
        return False
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0 and not math.isnan(value)
    if isinstance(value, str):
        return len(value) > 0
    return True


def _is_js_integer(value):
    if isinstance(value, bool):
        return False
    if isinstance(value, int):
        return True
    if isinstance(value, float):
        return math.isfinite(value) and value.is_integer()
    return False


def parse_digits(digits):
    if not digits:
        return {'minutes': 0, 'seconds': 0, 'totalMs': 0, 'empty': True}
    raw = ''.join(str(digit) for digit in digits)
    seconds = int(raw[-2:].rjust(2, '0'))
    minutes = int(raw[:-2]) if raw[:-2] else 0
    return {
        'minutes': minutes,
        'seconds': seconds,
        'totalMs': (minutes * 60 + seconds) * 1000,
        'empty': False,
    }


def format_milliseconds(ms):
    finite = isinstance(ms, (int, float)) and not isinstance(ms, bool) and math.isfinite(ms)
    whole_seconds = max(0, math.ceil((ms if finite else 0) / 1000))
    minutes = whole_seconds // 60
    seconds = whole_seconds % 60
    return [
        str(minutes // 10) if minutes >= 10 else ' ',
        str(minutes % 10),
        str(seconds // 10),
        str(seconds % 10),
    ]


# Raw keyed input is right-aligned so invalid values still show exactly what
# was keyed (D1: 99 -> "99", 5999 -> "5999").
def align_digits(digits):
    return list(''.join(str(digit) for digit in digits[-4:]).rjust(4, ' '))


def clock_digits(minutes):
    hours = minutes // 60
    mm = minutes % 60
    return [
        str(hours // 10),
        str(hours % 10),
        str(mm // 10),
        str(mm % 10),
    ]


def power_digits(pct):
    return align_digits(list(_js_string(pct)))


def rejected(reason, mode):
    return {'ok': False, 'reason': reason, 'mode': mode}


class Microwave:
    """One independent microwave controller.

    ``initial_digits`` is an optional MMSS digit buffer supplied by a caller
    that has an explicit contract value.  The shipped interaction contract has
    no initial display field, so omitting it produces the blank display.
    """

    def __init__(self, initial_digits=None):
        self._mode = 'idle'
        self._entered = []
        self._remaining_ms = 0
        self._door_open = False
        # A cleared/stopped unit with no active display is all off.
        # Time Cook selects the time-entry path; digits already type MMSS in idle.
        self._entry_mode = None
        self._power_pct = 100
        self._cook_power_pct = 100
        self._clock_base_min = None
        self._clock_accum_ms = 0
        self._power_display_ms = 0
        self._timer_remaining_ms = 0
        self._timer_running = False
        self._timer_done = False

        if initial_digits is not None:
            if isinstance(initial_digits, (list, tuple)):
                text = ''.join('' if item is None else _js_string(item) for item in initial_digits)
            else:
                text = _js_string(initial_digits)
            digits = [int(ch) for ch in _NON_ASCII_DIGITS.sub('', text)[-4:]]
            if digits and parse_digits(digits)['seconds'] <= 59:
                self._entered = digits

    def _clock_digit_allowed(self, value):
        nxt = self._entered + [value]
        if len(nxt) == 1:
            return value <= 2
        if len(nxt) == 2:
            return int(''.join(str(d) for d in nxt)) <= 23
        if len(nxt) == 3:
            return value <= 5
        if len(nxt) == 4:
            return int(''.join(str(d) for d in nxt[2:])) <= 59
        return False

    def digit(self, d):
        value = _js_number(d) if isinstance(d, str) else d
        if not _is_js_integer(value) or value < 0 or value > 9:
            return rejected('digit', self._mode)
        if self._mode != 'idle':
            return rejected('busy', self._mode)
        value = int(value)
        if self._entry_mode == 'clock':
            if len(self._entered) >= 4 or not self._clock_digit_allowed(value):
                return rejected('clock-range', self._mode)
            nxt = self._entered + [value]
        elif self._entry_mode == 'weight_defrost':
            if len(self._entered) >= 2:
                return rejected('weight-range', self._mode)
            nxt = self._entered + [value]
        else:
            nxt = self._entered + [value]
            if len(nxt) > 4:
                nxt.pop(0)
        self._entered = nxt
        return {
            'ok': True,
            'digits': list(self._entered),
            'mode': self._mode,
            'entryMode': self._entry_mode,
        }

    def clear(self):
        self._mode = 'idle'
        self._entered = []
        self._remaining_ms = 0
        self._entry_mode = None
        self._power_display_ms = 0
        self._timer_remaining_ms = 0
        self._timer_running = False
        self._timer_done = False
        return {'ok': True, 'mode': self._mode, 'display': 'off'}

    def stop(self):
        return self.clear()

    def _begin_entry(self, kind):
        if self._mode != 'idle':
            return rejected('busy', self._mode)
        if self._timer_running:
            return rejected('busy', self._mode)
        if self._entry_mode != kind:
            self._entered = []
        self._entry_mode = kind
        self._power_display_ms = 0
        return {'ok': True, 'mode': self._mode, 'entryMode': self._entry_mode}

    def timeCook(self):
        return self._begin_entry('time_cook')

    def timeDefrost(self):
        return self._begin_entry('time_defrost')

    def kitchenTimer(self):
        return self._begin_entry('kitchen_timer')

    def weightDefrost(self):
        return self._begin_entry('weight_defrost')

    def _save_clock(self):
        if len(self._entered) != 4:
            return rejected('invalid', self._mode)
        hours = int(''.join(str(d) for d in self._entered[:2]))
        minutes = int(''.join(str(d) for d in self._entered[2:]))
        if hours > 23 or minutes > 59:
            return rejected('invalid', self._mode)
        self._clock_base_min = hours * 60 + minutes
        self._clock_accum_ms = 0
        self._entered = []
        self._entry_mode = None
        return {
            'ok': True,
            'reason': 'clock_set',
            'mode': self._mode,
            'clockMinutes': self._clock_base_min,
        }

    def clock(self):
        if self._mode != 'idle':
            return rejected('busy', self._mode)
        if self._entry_mode == 'clock':
            return self._save_clock()
        if self._timer_running:
            return rejected('busy', self._mode)
        self._entry_mode = 'clock'
        self._entered = []
        self._power_display_ms = 0
        return {
            'ok': True,
            'reason': 'clock_entry',
            'mode': self._mode,
            'entryMode': self._entry_mode,
        }

    def powerLevel(self):
        if self._mode != 'idle' or self._timer_running:
            return rejected('busy', self._mode)
        index = POWER_LEVELS_PCT.index(self._power_pct)
        self._power_pct = POWER_LEVELS_PCT[(index + 1) % len(POWER_LEVELS_PCT)]
        self._power_display_ms = POWER_DISPLAY_MS
        return {
            'ok': True,
            'reason': 'power',
            'mode': self._mode,
            'powerPct': self._power_pct,
            'powerDisplayMs': self._power_display_ms,
        }

    def _start_timer(self):
        if not self._entered:
            return rejected('empty', self._mode)
        parsed = parse_digits(self._entered)
        if parsed['totalMs'] <= 0 or parsed['seconds'] > 59:
            return rejected('invalid', self._mode)
        self._timer_remaining_ms = min(MAX_REMAINING_MS, parsed['totalMs'])
        self._timer_running = True
        self._timer_done = False
        self._mode = 'idle'
        self._entered = []
        self._entry_mode = None
        return {
            'ok': True,
            'reason': 'timer_started',
            'mode': self._mode,
            'timerRemainingMs': self._timer_remaining_ms,
        }

    def _start_preset(self, action):
        preset = PRESETS.get(action)
        if not preset:
            return rejected('unknown-action', self._mode)
        if self._mode != 'idle':
            return rejected('busy', self._mode)
        if self._door_open:
            return rejected('door-open', self._mode)
        self._remaining_ms = preset['seconds'] * 1000
        self._cook_power_pct = preset['powerPct']
        self._mode = 'cooking'
        self._entered = []
        self._entry_mode = None
        self._power_display_ms = 0
        return {
            'ok': True,
            'reason': 'preset',
            'mode': self._mode,
            'remainingMs': self._remaining_ms,
            'cookPowerPct': self._cook_power_pct,
            'preset': action,
        }

    def start(self):
        # Clock entry saves without heating, including with the door open.
        if self._entry_mode == 'clock':
            return self._save_clock()
        # The kitchen timer is non-heating and keeps running with the door open.
        if self._entry_mode == 'kitchen_timer':
            return self._start_timer()
        if self._door_open:
            return rejected('door-open', self._mode)
        if self._mode == 'cooking':
            self._mode = 'paused'
            return {'ok': True, 'reason': 'paused', 'mode': self._mode, 'remainingMs': self._remaining_ms}
        if self._mode == 'paused':
            if self._remaining_ms <= 0:
                return rejected('empty', self._mode)
            self._mode = 'cooking'
            return {
                'ok': True,
                'reason': 'resumed',
                'mode': self._mode,
                'remainingMs': self._remaining_ms,
                'cookPowerPct': self._cook_power_pct,
            }
        if self._timer_running:
            return rejected('busy', self._mode)
        if not self._entered:
            return rejected('empty', self._mode)
        if self._entry_mode == 'weight_defrost':
            ounces = int(''.join(str(d) for d in self._entered))
            if not (1 <= ounces <= 99):
                return rejected('invalid', self._mode)
            # Math.round(ounces * 22.5 / 5) * 5, nonnegative.
            seconds = math.floor((ounces * 22.5) / 5 + 0.5) * 5
            self._remaining_ms = min(MAX_REMAINING_MS, seconds * 1000)
            self._cook_power_pct = DEFROST_POWER_PCT
        else:
            parsed = parse_digits(self._entered)
            if parsed['totalMs'] <= 0 or parsed['seconds'] > 59:
                return rejected('invalid', self._mode)
            self._remaining_ms = min(MAX_REMAINING_MS, parsed['totalMs'])
            self._cook_power_pct = (
                DEFROST_POWER_PCT if self._entry_mode == 'time_defrost' else self._power_pct
            )
        self._mode = 'cooking'
        self._entered = []
        self._entry_mode = None
        return {
            'ok': True,
            'reason': 'started',
            'mode': self._mode,
            'remainingMs': self._remaining_ms,
            'cookPowerPct': self._cook_power_pct,
        }

    def pause(self):
        if self._mode != 'cooking':
            return rejected('paused' if self._mode == 'paused' else 'idle', self._mode)
        self._mode = 'paused'
        return {'ok': True, 'mode': self._mode, 'remainingMs': self._remaining_ms}

    def add30(self):
        if self._door_open:
            return rejected('door-open', self._mode)
        if self._timer_running:
            self._timer_remaining_ms = min(MAX_REMAINING_MS, self._timer_remaining_ms + ADD_30_MS)
            return {
                'ok': True,
                'reason': 'timer_added',
                'mode': self._mode,
                'remainingMs': self._remaining_ms,
                'timerRemainingMs': self._timer_remaining_ms,
            }
        if self._mode == 'idle':
            self._mode = 'cooking'
            self._remaining_ms = ADD_30_MS
            self._cook_power_pct = 100
            self._entered = []
            self._entry_mode = None
            self._power_display_ms = 0
        else:
            self._remaining_ms = min(MAX_REMAINING_MS, self._remaining_ms + ADD_30_MS)
        return {'ok': True, 'mode': self._mode, 'remainingMs': self._remaining_ms}

    def setDoorOpen(self, open):
        nxt = _js_truthy(open)
        if nxt == self._door_open:
            return {'ok': True, 'mode': self._mode, 'doorOpen': self._door_open}
        self._door_open = nxt
        # Opening during heating pauses in the same transition and keeps the
        # time.  Closing never resumes: Start/Pause is required.  The timer is
        # untouched.
        if self._door_open and self._mode == 'cooking':
            self._mode = 'paused'
        return {'ok': True, 'mode': self._mode, 'doorOpen': self._door_open}

    # D4: this only reports the requested event and never mutates mode,
    # doorOpen or remainingMs.  The runtime owns the real articulation
    # instance and asserts the logic interlock with setDoorOpen(true).
    def openDoor(self):
        return {'ok': True, 'event': 'door_open', 'changed': not self._door_open}

    def tick(self, ms):
        delta = _js_number(ms)
        if not math.isfinite(delta) or delta <= 0:
            return {
                'ok': False,
                'reason': 'duration',
                'mode': self._mode,
                'remainingMs': self._remaining_ms,
                'timerRemainingMs': self._timer_remaining_ms,
                'timerRunning': self._timer_running,
                'timerDone': self._timer_done,
            }
        # D5: the saved wall clock advances in every state, including idle and
        # while the door is open.
        if self._clock_base_min is not None:
            self._clock_accum_ms += delta
        if self._power_display_ms > 0:
            self._power_display_ms = max(0, self._power_display_ms - delta)
        timer_ticked = False
        if self._timer_running:
            timer_ticked = True
            self._timer_remaining_ms = max(0, self._timer_remaining_ms - delta)
            if self._timer_remaining_ms <= 0:
                self._timer_remaining_ms = 0
                self._timer_running = False
                self._timer_done = True
        if self._mode == 'cooking':
            if self._door_open:
                return {
                    'ok': False,
                    'reason': 'door-open',
                    'mode': self._mode,
                    'remainingMs': self._remaining_ms,
                    'timerRemainingMs': self._timer_remaining_ms,
                    'timerRunning': self._timer_running,
                    'timerDone': self._timer_done,
                }
            self._remaining_ms = max(0, self._remaining_ms - delta)
            if self._remaining_ms <= 0:
                self._remaining_ms = 0
                self._mode = 'idle'
                self._entered = []
                self._entry_mode = None
            return {
                'ok': True,
                'mode': self._mode,
                'remainingMs': self._remaining_ms,
                'timerRemainingMs': self._timer_remaining_ms,
                'timerRunning': self._timer_running,
                'timerDone': self._timer_done,
            }
        if timer_ticked:
            return {
                'ok': True,
                'mode': self._mode,
                'remainingMs': self._remaining_ms,
                'timerRemainingMs': self._timer_remaining_ms,
                'timerRunning': self._timer_running,
                'timerDone': self._timer_done,
            }
        return {
            'ok': False,
            'reason': 'not-cooking',
            'mode': self._mode,
            'remainingMs': self._remaining_ms,
            'timerRemainingMs': self._timer_remaining_ms,
            'timerRunning': self._timer_running,
            'timerDone': self._timer_done,
        }

    # D2R priority: cooking/paused, non-empty input, running timer, saved
    # clock, then off.  The brief power-level overlay stays visible below input
    # and the running timer but above the idle clock.
    def display(self):
        if self._mode == 'cooking' or self._mode == 'paused':
            return {
                'digits': format_milliseconds(self._remaining_ms),
                'colon': True,
                'clock': False,
                'reason': self._mode,
            }
        if self._entered:
            if self._entry_mode == 'clock':
                reason = 'clock_entry'
            elif self._entry_mode == 'weight_defrost':
                reason = 'weight_entry'
            elif self._entry_mode == 'kitchen_timer':
                reason = 'timer_entry'
            else:
                reason = 'entry'
            return {
                'digits': align_digits(self._entered),
                'colon': False,
                'clock': self._entry_mode == 'clock',
                'reason': reason,
            }
        if self._timer_running:
            return {
                'digits': format_milliseconds(self._timer_remaining_ms),
                'colon': True,
                'clock': False,
                'reason': 'timer',
            }
        if self._power_display_ms > 0:
            return {
                'digits': power_digits(self._power_pct),
                'colon': False,
                'clock': False,
                'reason': 'power',
            }
        if self._clock_base_min is not None:
            shown_minutes = (self._clock_base_min + math.floor(self._clock_accum_ms / 60000)) % 1440
            return {
                'digits': clock_digits(shown_minutes),
                'colon': True,
                'clock': True,
                'reason': 'clock',
            }
        return {'digits': [' ', ' ', ' ', ' '], 'colon': False, 'clock': False, 'reason': 'blank'}

    # All 26 physical actions resolve here; the runtime passes the node's
    # aps_action straight through and records the returned object.
    def dispatch(self, action):
        name = '' if action is None else _js_string(action)
        digit_match = _DIGIT_ACTION.match(name)
        if digit_match:
            result = self.digit(int(digit_match.group(1)))
        elif name == 'start_pause':
            result = self.start()
        elif name == 'stop_clear':
            result = self.stop()
        elif name == 'add_30_sec':
            result = self.add30()
        elif name == 'time_cook':
            result = self.timeCook()
        elif name == 'time_defrost':
            result = self.timeDefrost()
        elif name == 'kitchen_timer':
            result = self.kitchenTimer()
        elif name == 'weight_defrost':
            result = self.weightDefrost()
        elif name == 'power_level':
            result = self.powerLevel()
        elif name == 'clock':
            result = self.clock()
        elif name == 'door_open':
            result = self.openDoor()
        elif name in PRESETS:
            result = self._start_preset(name)
        else:
            result = rejected('unknown-action', self._mode)
        output = dict(result)
        output['action'] = name
        return output

    def snapshot(self):
        return {
            'mode': self._mode,
            'entered': list(self._entered),
            'remainingMs': self._remaining_ms,
            'doorOpen': self._door_open,
            'entryMode': self._entry_mode,
            'powerPct': self._power_pct,
            'cookPowerPct': self._cook_power_pct,
            'clockMinutes': self._clock_base_min,
            'clockAccumMs': self._clock_accum_ms,
            'powerDisplayMs': self._power_display_ms,
            'timerRemainingMs': self._timer_remaining_ms,
            'timerRunning': self._timer_running,
            'timerDone': self._timer_done,
        }

    @property
    def mode(self):
        return self._mode

    @property
    def entered(self):
        return list(self._entered)

    @property
    def remainingMs(self):
        return self._remaining_ms

    @property
    def doorOpen(self):
        return self._door_open

    @property
    def entryMode(self):
        return self._entry_mode

    @property
    def powerPct(self):
        return self._power_pct

    @property
    def cookPowerPct(self):
        return self._cook_power_pct

    @property
    def clockMinutes(self):
        return self._clock_base_min

    @property
    def clockAccumMs(self):
        return self._clock_accum_ms

    @property
    def powerDisplayMs(self):
        return self._power_display_ms

    @property
    def timerRemainingMs(self):
        return self._timer_remaining_ms

    @property
    def timerRunning(self):
        return self._timer_running

    @property
    def timerDone(self):
        return self._timer_done
