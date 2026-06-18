import { useRef, useMemo, type MouseEvent } from 'react';
import { useMotionValue, useSpring, useReducedMotion, type MotionStyle } from 'motion/react';
import { EFFECTS } from '@/lib/animation-config';

interface UseTiltOnHoverReturn<T extends HTMLElement = HTMLElement> {
  ref: React.RefObject<T | null>;
  style: MotionStyle;
  handlers: {
    onMouseMove: (e: MouseEvent) => void;
    onMouseLeave: () => void;
  };
}

const EMPTY_HANDLERS = {
  onMouseMove: () => {},
  onMouseLeave: () => {},
};

export function useTiltOnHover<T extends HTMLElement = HTMLElement>(): UseTiltOnHoverReturn<T> {
  const ref = useRef<T | null>(null);
  const prefersReduced = useReducedMotion();

  const { enabled, maxDegrees, perspective } = EFFECTS.hoverTilt;
  // Don't gate on touch detection — Windows 11 touchscreen laptops report
  // ontouchstart yet still use a mouse. Hover tilt only fires on mousemove
  // events so there's no conflict with touch input.
  const isActive = enabled && !prefersReduced;

  const rotateXValue = useMotionValue(0);
  const rotateYValue = useMotionValue(0);

  const springConfig = { stiffness: 300, damping: 20 };
  const smoothX = useSpring(rotateXValue, springConfig);
  const smoothY = useSpring(rotateYValue, springConfig);

  const style: MotionStyle = useMemo(() => {
    if (!isActive) return {};
    return {
      perspective,
      rotateX: smoothX,
      rotateY: smoothY,
      transformStyle: 'preserve-3d' as const,
    };
  }, [isActive, perspective, smoothX, smoothY]);

  const handlers = useMemo(() => {
    if (!isActive) return EMPTY_HANDLERS;

    return {
      onMouseMove: (e: MouseEvent) => {
        const el = ref.current;
        if (!el) return;

        const rect = el.getBoundingClientRect();
        // Normalized position from -0.5 to +0.5
        const normalizedX = (e.clientX - rect.left) / rect.width - 0.5;
        const normalizedY = (e.clientY - rect.top) / rect.height - 0.5;

        // rotateX is driven by Y position (tilts forward/back)
        // rotateY is driven by X position (tilts left/right)
        // Negate rotateX so top of card tilts toward viewer
        rotateXValue.set(-normalizedY * maxDegrees);
        rotateYValue.set(normalizedX * maxDegrees);
      },
      onMouseLeave: () => {
        rotateXValue.set(0);
        rotateYValue.set(0);
      },
    };
  }, [isActive, maxDegrees, rotateXValue, rotateYValue]);

  return { ref, style, handlers };
}
