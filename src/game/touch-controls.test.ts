import { describe, expect, it } from 'vitest';
import { joystickVector, TouchControls, TouchInput } from './touch-controls';

describe('joystickVector', () => {
  it('preserves partial travel and clamps diagonals to a circular boundary', () => {
    expect(joystickVector(24, 0, 48)).toEqual({ dx: 0.5, dy: 0, x: 24, y: 0 });
    const diagonal = joystickVector(96, 128, 48);
    expect(diagonal.dx).toBeCloseTo(0.6);
    expect(diagonal.dy).toBeCloseTo(0.8);
    expect(diagonal.x).toBeCloseTo(28.8);
    expect(diagonal.y).toBeCloseTo(38.4);
  });

  it('keeps a centered finger inside the movement dead zone', () => {
    expect(joystickVector(0, 0, 48)).toEqual({ dx: 0, dy: 0, x: 0, y: 0 });
    expect(joystickVector(3, 0, 48)).toEqual({ dx: 0, dy: 0, x: 3, y: 0 });
    expect(joystickVector(0, -12, 48)).toEqual({ dx: 0, dy: -0.25, x: 0, y: -12 });
  });

  it.each([
    [0, 0, 0], [10, 20, -4], [NaN, 0, 48], [0, Infinity, 48],
    [1, 2, NaN], [1, 2, Infinity], [Number.MAX_VALUE, Number.MAX_VALUE, 48],
  ])('returns finite neutral input for invalid geometry (%s, %s, %s)', (x, y, radius) => {
    expect(joystickVector(x, y, radius)).toEqual({ dx: 0, dy: 0, x: 0, y: 0 });
  });
});

describe('TouchInput pointer ownership', () => {
  it('lets only the first joystick finger move or release its axes', () => {
    const touch = new TouchInput();
    expect(touch.pressStick(10)).toBe(true);
    expect(touch.pressStick(11)).toBe(false);
    expect(touch.moveStick(11, -1, 0)).toBe(false);
    expect(touch.moveStick(10, 0.5, -0.5)).toBe(true);
    expect(touch.releaseStick(11)).toBe(false);
    expect(touch.input).toEqual({ dx: 0.5, dy: -0.5, clean: false });
    expect(touch.releaseStick(10)).toBe(true);
    expect(touch.input).toEqual({ dx: 0, dy: 0, clean: false });
    expect(touch.pressStick(11)).toBe(true);
  });

  it('keeps cleaning after releasing the joystick finger', () => {
    const touch = new TouchInput();
    touch.pressStick(10);
    touch.moveStick(10, 1, 0);
    touch.pressClean(20);
    touch.releaseStick(10);
    expect(touch.input).toEqual({ dx: 0, dy: 0, clean: true });
    touch.releaseClean(20);
    expect(touch.input.clean).toBe(false);
  });

  it('keeps moving after releasing a cleaning finger pressed first', () => {
    const touch = new TouchInput();
    touch.pressClean(20);
    touch.pressStick(10);
    touch.moveStick(10, 0, -1);
    touch.releaseClean(20);
    expect(touch.input).toEqual({ dx: 0, dy: -1, clean: false });
  });

  it('holds cleaning until all its fingers release and rejects shared ownership', () => {
    const touch = new TouchInput();
    expect(touch.pressClean(20)).toBe(true);
    expect(touch.pressClean(21)).toBe(true);
    expect(touch.pressClean(20)).toBe(false);
    expect(touch.pressStick(20)).toBe(false);
    expect(touch.releaseClean(99)).toBe(false);
    touch.releaseClean(20);
    expect(touch.input.clean).toBe(true);
    touch.releaseClean(21);
    expect(touch.input.clean).toBe(false);
    touch.pressStick(10);
    expect(touch.pressClean(10)).toBe(false);
  });

  it('reset forgets every owner and preserves the input object used by the game loop', () => {
    const touch = new TouchInput();
    const input = touch.input;
    touch.pressStick(10);
    touch.moveStick(10, 1, -1);
    touch.pressClean(20);
    touch.reset();
    expect(touch.input).toBe(input);
    expect(input).toEqual({ dx: 0, dy: 0, clean: false });
    expect(touch.moveStick(10, 1, 0)).toBe(false);
    expect(touch.releaseClean(20)).toBe(false);
    expect(touch.pressStick(20)).toBe(true);
    expect(touch.pressClean(10)).toBe(true);
  });
});

// Node's EventTarget runs the real registered handlers without a DOM dependency.
class ControlElement extends EventTarget {
  style = { transform: '' };
  attributes = new Map<string, string>();
  captures = new Set<number>();
  getBoundingClientRect() {
    return { x: 100, y: 200, left: 100, top: 200, width: 144, height: 144, right: 244, bottom: 344, toJSON: () => ({}) };
  }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  setPointerCapture(id: number) { this.captures.add(id); }
  hasPointerCapture(id: number) { return this.captures.has(id); }
  releasePointerCapture(id: number) {
    this.captures.delete(id);
    pointer(this, 'lostpointercapture', id);
  }
}

function pointer(target: ControlElement, type: string, pointerId: number, options: Partial<PointerEvent> = {}) {
  const event = new Event(type, { cancelable: true });
  Object.assign(event, { pointerId, clientX: 172, clientY: 272, button: 0, pointerType: 'touch', isPrimary: false }, options);
  target.dispatchEvent(event);
  return event;
}

function controls() {
  const stick = new ControlElement();
  const knob = new ControlElement();
  const clean = new ControlElement();
  let active = true;
  let starts = 0;
  const touch = new TouchControls({
    stick: stick as unknown as HTMLElement,
    knob: knob as unknown as HTMLElement,
    clean: clean as unknown as HTMLButtonElement,
    active: () => active,
    onStart: () => { starts++; },
  });
  return { touch, stick, knob, clean, setActive: (value: boolean) => { active = value; }, starts: () => starts };
}

describe('TouchControls pointer bindings', () => {
  it('uses the fixed base center, ignores extra stick fingers and captures travel outside the canvas', () => {
    const { touch, stick, knob, starts } = controls();
    const down = pointer(stick, 'pointerdown', 10, { clientX: 196 });
    expect(touch.input).toEqual({ dx: 0.5, dy: 0, clean: false });
    expect(knob.style.transform).toBe('translate(24px, 0px)');
    expect(stick.captures.has(10)).toBe(true);
    expect(down.defaultPrevented).toBe(true);
    const otherDown = pointer(stick, 'pointerdown', 11, { clientX: 0 });
    const otherMove = pointer(stick, 'pointermove', 11, { clientX: 0 });
    expect(otherDown.defaultPrevented).toBe(false);
    expect(otherMove.defaultPrevented).toBe(false);
    expect(touch.input.dx).toBe(0.5);
    pointer(stick, 'pointermove', 10, { clientX: -1000 });
    expect(touch.input.dx).toBe(-1);
    expect(knob.style.transform).toBe('translate(-48px, 0px)');
    expect(starts()).toBe(1);
  });

  it.each(['pointerup', 'pointercancel', 'lostpointercapture'])('%s clears only its owned movement', event => {
    const { touch, stick, knob, clean } = controls();
    pointer(stick, 'pointerdown', 10, { clientX: 220 });
    pointer(clean, 'pointerdown', 20);
    pointer(stick, event, 11);
    expect(touch.input.dx).toBe(1);
    pointer(stick, event, 10);
    expect(touch.input).toEqual({ dx: 0, dy: 0, clean: true });
    expect(knob.style.transform).toBe('translate(0px, 0px)');
    expect(stick.captures.size).toBe(0);
    expect(clean.getAttribute('aria-pressed')).toBe('true');
  });

  it.each(['pointerup', 'pointercancel', 'lostpointercapture'])('%s releases cleaning without changing movement', event => {
    const { touch, stick, clean } = controls();
    pointer(clean, 'pointerdown', 20);
    pointer(stick, 'pointerdown', 10, { clientY: 224 });
    pointer(clean, event, 20);
    expect(touch.input).toEqual({ dx: 0, dy: -1, clean: false });
    expect(clean.getAttribute('aria-pressed')).toBe('false');
    expect(clean.captures.size).toBe(0);
  });

  it('supports non-primary cleaning fingers and leaves cleaning pressed until its last release', () => {
    const { touch, clean, starts } = controls();
    pointer(clean, 'pointerdown', 20);
    pointer(clean, 'pointerdown', 21);
    pointer(clean, 'pointerup', 20);
    expect(touch.input.clean).toBe(true);
    expect(clean.getAttribute('aria-pressed')).toBe('true');
    pointer(clean, 'pointercancel', 21);
    expect(touch.input.clean).toBe(false);
    expect(clean.getAttribute('aria-pressed')).toBe('false');
    expect(starts()).toBe(2);
  });

  it('ignores inactive and non-left mouse presses without preventing unrelated events', () => {
    const { touch, stick, clean, setActive, starts } = controls();
    setActive(false);
    expect(pointer(stick, 'pointerdown', 10).defaultPrevented).toBe(false);
    expect(pointer(clean, 'pointerdown', 20).defaultPrevented).toBe(false);
    setActive(true);
    expect(pointer(clean, 'pointerdown', 20, { pointerType: 'mouse', button: 2 }).defaultPrevented).toBe(false);
    expect(pointer(stick, 'pointermove', 99).defaultPrevented).toBe(false);
    expect(touch.input).toEqual({ dx: 0, dy: 0, clean: false });
    expect(starts()).toBe(0);
    pointer(stick, 'pointerdown', 10, { pointerType: 'mouse', clientX: 220 });
    expect(touch.input.dx).toBe(1);
    expect(starts()).toBe(1);
  });

  it('reset releases captures, visuals and owners so stale moves cannot restart either control', () => {
    const { touch, stick, knob, clean } = controls();
    pointer(stick, 'pointerdown', 10, { clientX: 220 });
    pointer(clean, 'pointerdown', 20);
    pointer(clean, 'pointerdown', 21);
    touch.reset();
    expect(touch.input).toEqual({ dx: 0, dy: 0, clean: false });
    expect(knob.style.transform).toBe('translate(0px, 0px)');
    expect(clean.getAttribute('aria-pressed')).toBe('false');
    expect(stick.captures.size).toBe(0);
    expect(clean.captures.size).toBe(0);
    pointer(stick, 'pointermove', 10, { clientX: 220 });
    pointer(clean, 'pointerup', 20);
    expect(touch.input).toEqual({ dx: 0, dy: 0, clean: false });
    pointer(stick, 'pointerdown', 20, { clientX: 148 });
    pointer(clean, 'pointerdown', 10);
    expect(touch.input).toEqual({ dx: -0.5, dy: 0, clean: true });
  });
});
