import { Suspense, lazy } from 'react';

const AnalyticsDashboard = lazy(() => import('../components/analytics/AnalyticsDashboard'));

function ChartSkeleton({ height = 320 }: { height?: number }) {
  return (
    <div
      className="animate-pulse rounded-lg bg-gray-200 dark:bg-gray-700"
      style={{ height }}
      role="status"
      aria-label="Loading chart"
    />
  );
}

function AnalyticsSkeleton() {
  return (
    <div className="space-y-6 p-6">
      <div className="h-8 w-1/3 animate-pulse rounded bg-gray-200 dark:bg-gray-700" />
      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        <ChartSkeleton />
        <ChartSkeleton />
        <ChartSkeleton />
        <ChartSkeleton />
      </div>
    </div>
  );
}

export default function AnalyticsPage() {
  return (
    <Suspense fallback={<AnalyticsSkeleton />}>
      <AnalyticsDashboard />
    </Suspense>
  );
}
