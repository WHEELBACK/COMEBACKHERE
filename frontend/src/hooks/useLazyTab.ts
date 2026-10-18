import { lazy, Suspense, ReactNode, ComponentType } from 'react';
import { Skeleton } from '../components/Skeleton';

export function lazyTab<P extends object>(
  importFn: () => Promise<{ default: ComponentType<P> }>
): ComponentType<P> {
  const LazyComponent = lazy(importFn);
  return (props: P) => (
    <Suspense fallback={<Skeleton />}>
      <LazyComponent {...props} />
    </Suspense>
  ) as ComponentType<P>;
}
