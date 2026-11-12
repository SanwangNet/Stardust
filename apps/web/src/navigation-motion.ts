export const navigationMotion = {
  easing: "cubic-bezier(0.2, 0, 0, 1)",
  pageDurationMs: 260,
  navigationDurationMs: 220,
  staggerIntervalMs: 24,
  minimumStaggerDurationMs: 96,
  contentEnterPx: 24,
  contentExitPx: 20,
  sidebarEnterPx: 12,
  sidebarExitPx: 10,
  submenuDurationMs: 180,
} as const;

export type NavigationDirection = -1 | 1;

export function getNavigationDirection(fromIndex: number, toIndex: number): NavigationDirection {
  return toIndex < fromIndex ? -1 : 1;
}

export function getStaggerTiming(index: number): { delay: number; duration: number } {
  const latestStart = Math.max(0, navigationMotion.pageDurationMs - navigationMotion.minimumStaggerDurationMs);
  const delay = Math.min(Math.max(0, index) * navigationMotion.staggerIntervalMs, latestStart);
  return { delay, duration: navigationMotion.pageDurationMs - delay };
}

type AnimatedProperties = "translate" | "transform" | "opacity" | "width" | "height";
type MotionOptions = {
  token: number;
  duration: number;
  delay?: number;
  properties: AnimatedProperties[];
  onFinish?: () => void;
};
type ActiveAnimation = {
  animation: Animation;
  freeze: () => void;
};

export class NavigationMotion {
  private sequence = 0;
  private readonly active = new Map<Animation, ActiveAnimation>();
  private readonly reduceMotion: MediaQueryList;

  constructor(private readonly root: HTMLElement = document.documentElement) {
    this.reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    this.root.style.setProperty("--motion-ease", navigationMotion.easing);
    this.root.style.setProperty("--motion-page-duration", `${navigationMotion.pageDurationMs}ms`);
    this.root.style.setProperty("--motion-navigation-duration", `${navigationMotion.navigationDurationMs}ms`);
    this.root.style.setProperty("--motion-stagger-interval", `${navigationMotion.staggerIntervalMs}ms`);
    this.root.style.setProperty("--motion-submenu-duration", `${navigationMotion.submenuDurationMs}ms`);
    this.reduceMotion.addEventListener("change", (event) => {
      if (event.matches) this.finishActive();
    });
  }

  begin(): number {
    this.sequence += 1;
    for (const active of this.active.values()) {
      active.freeze();
      active.animation.cancel();
    }
    this.active.clear();
    return this.sequence;
  }

  isCurrent(token: number): boolean {
    return token === this.sequence;
  }

  isReducedMotion(): boolean {
    return this.reduceMotion.matches;
  }

  animate(element: HTMLElement, frames: Keyframe[], options: MotionOptions): Promise<boolean> {
    const finalFrame = frames.at(-1);
    if (!this.isCurrent(options.token)) return Promise.resolve(false);
    if (this.reduceMotion.matches || options.duration <= 0 || typeof element.animate !== "function") {
      if (finalFrame) this.applyFrame(element, finalFrame, options.properties);
      options.onFinish?.();
      return Promise.resolve(true);
    }

    let animation: Animation;
    try {
      animation = element.animate(frames, {
        duration: options.duration,
        delay: options.delay ?? 0,
        easing: navigationMotion.easing,
        fill: "both",
      });
    } catch {
      if (finalFrame) this.applyFrame(element, finalFrame, options.properties);
      options.onFinish?.();
      return Promise.resolve(true);
    }

    const freeze = (): void => {
      const computed = getComputedStyle(element);
      for (const property of options.properties) {
        element.style.setProperty(property, computed.getPropertyValue(property));
      }
    };
    this.active.set(animation, { animation, freeze });

    return new Promise((resolve) => {
      animation.onfinish = () => {
        this.active.delete(animation);
        if (this.isCurrent(options.token)) {
          if (finalFrame) this.applyFrame(element, finalFrame, options.properties);
          options.onFinish?.();
          animation.cancel();
          resolve(true);
        } else {
          resolve(false);
        }
      };
      animation.oncancel = () => {
        this.active.delete(animation);
        resolve(false);
      };
    });
  }

  finishActive(): void {
    for (const { animation } of this.active.values()) {
      try {
        animation.finish();
      } catch {
        animation.cancel();
      }
    }
  }

  private applyFrame(element: HTMLElement, frame: Keyframe, properties: AnimatedProperties[]): void {
    for (const property of properties) {
      const value = frame[property];
      if (value !== undefined && value !== null) element.style.setProperty(property, String(value));
    }
  }
}
