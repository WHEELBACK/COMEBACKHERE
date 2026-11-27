import { Suspense, lazy } from 'react';

const RevenueChart = lazy(() => import('./RevenueChart'));
const TrafficChart = lazy(() => import('./TrafficChart'));
const ConversionChart = lazy(() => import('./ConversionChart'));

function ChartSkeleton({ height = 280 }: { height?: number }) {
  return (
    <div
      className="animate-pulse rounded-lg bg-gray-200 dark:bg-gray-700"
      style={{ height }}
      role="status"
      aria-label="Loading chart"
    >
      <span className="sr-only">Loading chart…</span>
    </div>
  );
}

export default function AnalyticsDashboard() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Analytics</h1>

      <section className="rounded-xl bg-white p-4 shadow dark:bg-gray-800">
        <h2 className="mb-4 text-lg font-medium">Revenue</h2>
        <Suspense fallback={<ChartSkeleton />}>
          <RevenueChart />
        </Suspense>
      </section>

      <section className="rounded-xl bg-white p-4 shadow dark:bg-gray-800">
        <h2 className="mb-4 text-lg font-medium">Traffic</h2>
        <Suspense fallback={<ChartSkeleton />}>
          <TrafficChart />
        </Suspense>
      </section>

      <section className="rounded-xl bg-white p-4 shadow dark:bg-gray-800">
        <h2 className="mb-4 text-lg font-medium">Conversion</h2>
        <Suspense fallback={<ChartSkeleton />}>
          <ConversionChart />
        </Suspense>
      </section>
    </div>
  );
}
