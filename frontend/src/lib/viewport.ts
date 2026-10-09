import { useEffect, useState } from "react";

/**
 * The part of the screen not covered by the on-screen keyboard.
 * Chrome (with interactive-widget=overlays-content) and iOS Safari both shrink
 * the visual viewport instead of the page; iOS also pans it (offsetTop).
 */
export function useVisualViewport() {
  const read = () => {
    const vv = window.visualViewport;
    return { height: vv?.height ?? window.innerHeight, top: vv?.offsetTop ?? 0 };
  };
  const [state, setState] = useState(read);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => setState(read());
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, []);
  return state;
}
