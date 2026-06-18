import { useRef } from 'react';
import { useScroll, useTransform, useReducedMotion, type MotionValue } from 'motion/react';
import { EFFECTS } from '@/lib/animation-config';

interface UseScrollParallaxReturn<T extends HTMLElement = HTMLElement> {
  ref: React.RefObject<T | null>;
  y: MotionValue<number>;
}

export function useScrollParallax<T extends HTMLElement = HTMLElement>(): UseScrollParallaxReturn<T> {
  const ref = useRef<T | null>(null);
  const prefersReduced = useReducedMotion();

  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ['start end', 'end start'],
  });

  const { enabled, intensity } = EFFECTS.parallaxLift;
  const maxOffset = 50 * intensity;
  const isActive = enabled && !prefersReduced;

  const y = useTransform(
    scrollYProgress,
    [0, 1],
    isActive ? [maxOffset, -maxOffset] : [0, 0],
  );

  return { ref, y };
}
