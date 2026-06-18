import { motion, useReducedMotion } from 'motion/react';
import clsx from 'clsx';
import { ScreenshotFrame } from './screenshot-frame';
import { useScrollParallax } from '@/lib/use-scroll-parallax';
import { useGyroTilt } from '@/lib/use-gyro-tilt';
import { useTiltOnHover } from '@/lib/use-tilt-on-hover';
import { EFFECTS } from '@/lib/animation-config';

interface FloatingFrameProps {
  src: string;
  alt: string;
  className?: string;
  parallaxIntensity?: number;
}

export function FloatingFrame({ src, alt, className, parallaxIntensity }: FloatingFrameProps) {
  const prefersReduced = useReducedMotion();
  const { ref: parallaxRef, y } = useScrollParallax<HTMLDivElement>();
  const tilt = useTiltOnHover<HTMLDivElement>();
  const gyro = useGyroTilt();

  const parallaxEnabled = EFFECTS.parallaxLift.enabled && !prefersReduced;
  const gyroActive = gyro.rotateX !== 0 || gyro.rotateY !== 0;

  return (
    <motion.div
      ref={parallaxRef}
      style={{ y }}
      className={clsx('will-change-transform', className)}
    >
      <motion.div
        ref={tilt.ref}
        {...tilt.handlers}
        style={tilt.style}
        animate={
          gyroActive
            ? { rotateX: gyro.rotateX, rotateY: gyro.rotateY }
            : undefined
        }
        transition={
          gyroActive
            ? { type: 'spring', stiffness: 200, damping: 25 }
            : undefined
        }
      >
        <ScreenshotFrame
          src={src}
          alt={alt}
          className={parallaxEnabled ? 'shadow-2xl drop-shadow-xl' : undefined}
        />
      </motion.div>
    </motion.div>
  );
}
