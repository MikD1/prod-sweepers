import type { GameInput } from './types';

const DEAD_ZONE = 0.12;
const KNOB_RADIUS = 24;

/** Converts displacement from the fixed stick center to bounded movement and knob travel. */
export function joystickVector(x: number, y: number, radius: number) {
  const distance = Math.hypot(x, y);
  if (!Number.isFinite(distance) || !Number.isFinite(radius) || radius <= 0) {
    return { dx: 0, dy: 0, x: 0, y: 0 };
  }
  const divisor = Math.max(radius, distance);
  const dx = x / divisor;
  const dy = y / divisor;
  const insideDeadZone = distance / radius < DEAD_ZONE;
  return { dx: insideDeadZone ? 0 : dx, dy: insideDeadZone ? 0 : dy, x: dx * radius, y: dy * radius };
}

/** Pointer ownership stays separate from the DOM so one finger cannot release another. */
export class TouchInput {
  readonly input: GameInput = { dx: 0, dy: 0, clean: false };
  private stickPointer: number | null = null;
  private readonly cleaningPointers = new Set<number>();

  pressStick(pointerId: number): boolean {
    if (this.stickPointer !== null || this.cleaningPointers.has(pointerId)) return false;
    this.stickPointer = pointerId;
    return true;
  }

  moveStick(pointerId: number, dx: number, dy: number): boolean {
    if (this.stickPointer !== pointerId) return false;
    const vector = joystickVector(dx, dy, 1);
    this.input.dx = vector.dx;
    this.input.dy = vector.dy;
    return true;
  }

  releaseStick(pointerId: number): boolean {
    if (this.stickPointer !== pointerId) return false;
    this.stickPointer = null;
    this.input.dx = this.input.dy = 0;
    return true;
  }

  pressClean(pointerId: number): boolean {
    if (this.stickPointer === pointerId || this.cleaningPointers.has(pointerId)) return false;
    this.cleaningPointers.add(pointerId);
    this.input.clean = true;
    return true;
  }

  releaseClean(pointerId: number): boolean {
    if (!this.cleaningPointers.delete(pointerId)) return false;
    this.input.clean = this.cleaningPointers.size > 0;
    return true;
  }

  reset(): void {
    this.stickPointer = null;
    this.cleaningPointers.clear();
    this.input.dx = this.input.dy = 0;
    this.input.clean = false;
  }
}

export interface TouchControlsOptions {
  stick: HTMLElement;
  knob: HTMLElement;
  clean: HTMLButtonElement;
  active: () => boolean;
  onStart?: () => void;
}

export class TouchControls {
  private readonly state = new TouchInput();
  readonly input = this.state.input;
  private readonly captures = new Map<number, HTMLElement>();
  private knobX = 0;
  private knobY = 0;

  constructor(private readonly options: TouchControlsOptions) {
    options.stick.addEventListener('pointerdown', event => {
      if (!this.accepts(event) || !this.state.pressStick(event.pointerId)) return;
      event.preventDefault();
      this.capture(options.stick, event.pointerId);
      this.moveStick(event);
      options.onStart?.();
    });
    options.stick.addEventListener('pointermove', event => this.moveStick(event));
    options.clean.addEventListener('pointerdown', event => {
      if (!this.accepts(event) || !this.state.pressClean(event.pointerId)) return;
      event.preventDefault();
      this.capture(options.clean, event.pointerId);
      this.render();
      options.onStart?.();
    });
    options.clean.addEventListener('pointermove', event => {
      if (this.captures.get(event.pointerId) === options.clean) event.preventDefault();
    });
    for (const name of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) {
      options.stick.addEventListener(name, event => {
        if (!this.state.releaseStick(event.pointerId)) return;
        event.preventDefault();
        this.knobX = this.knobY = 0;
        this.releaseCapture(event.pointerId);
        this.render();
      });
      options.clean.addEventListener(name, event => {
        if (!this.state.releaseClean(event.pointerId)) return;
        event.preventDefault();
        this.releaseCapture(event.pointerId);
        this.render();
      });
    }
    this.render();
  }

  reset(): void {
    this.state.reset();
    this.knobX = this.knobY = 0;
    this.render();
    for (const pointerId of this.captures.keys()) this.releaseCapture(pointerId);
  }

  private accepts(event: PointerEvent): boolean {
    return this.options.active() && event.button === 0;
  }

  private moveStick(event: PointerEvent): void {
    const rect = this.options.stick.getBoundingClientRect();
    const vector = joystickVector(
      event.clientX - rect.left - rect.width / 2,
      event.clientY - rect.top - rect.height / 2,
      Math.min(rect.width, rect.height) / 2 - KNOB_RADIUS,
    );
    if (!this.state.moveStick(event.pointerId, vector.dx, vector.dy)) return;
    event.preventDefault();
    this.knobX = vector.x;
    this.knobY = vector.y;
    this.render();
  }

  private capture(element: HTMLElement, pointerId: number): void {
    this.captures.set(pointerId, element);
    // A synthetic event or a pointer already canceled by the browser may not be capturable.
    try { element.setPointerCapture(pointerId); } catch { /* Reset/release still clears ownership. */ }
  }

  private releaseCapture(pointerId: number): void {
    const element = this.captures.get(pointerId);
    this.captures.delete(pointerId);
    if (element?.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId);
  }

  private render(): void {
    this.options.knob.style.transform = `translate(${this.knobX}px, ${this.knobY}px)`;
    this.options.clean.setAttribute('aria-pressed', String(this.input.clean));
  }
}
