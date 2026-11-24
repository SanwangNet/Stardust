/** Disabled by default; emits geometry and lifecycle only, never page content. */
export function createNavigationDiagnostics(
  enabled: () => boolean,
  output: (event: string, data: Record<string, unknown>) => void,
  now: () => number,
) {
  return {
    enabled,
    log(event: string, data: Record<string, unknown> = {}): void {
      if (enabled()) output(event, { time: Math.round(now() * 10) / 10, ...data });
    },
    watch(name: string, animation: Animation, data: Record<string, unknown> = {}, measure?: () => Record<string, unknown>): void {
      if (!enabled()) return;
      const start=now(); output("animation-start", { time:Math.round(start*10)/10, name, timing:animation.effect?.getTiming(), ...data });
      const finalLayout = () => { try { return measure?.() ?? {}; } catch { return { measurement:"unavailable" }; } };
      void animation.finished.then(
        () => { if (enabled()) output("animation-finish", { time:Math.round(now()*10)/10, elapsed:Math.round((now()-start)*10)/10, name, ...finalLayout() }); },
        () => { if (enabled()) output("animation-cancel", { time:Math.round(now()*10)/10, elapsed:Math.round((now()-start)*10)/10, name, ...finalLayout() }); },
      );
    },
  };
}
