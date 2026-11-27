import React from 'react';

interface ChartSkeletonProps {
  /** Height of the chart placeholder area. */
  height?: number | string;
  /** Optional title shown above the skeleton bars. */
  title?: string;
  /** Number of placeholder bars to render. */
  bars?: number;
  className?: string;
}

/**
 * Skeleton fallback shown while an analytics chart chunk is being downloaded
 * via React.lazy / Suspense. Keeps layout stable and avoids content shift.
 */
const ChartSkeleton: React.FC<ChartSkeletonProps> = ({
  height = 320,
  title,
  bars = 7,
  className = '',
}) => {
  const barHeights = [45, 70, 55, 85, 60, 75, 50, 65, 40, 80];

  return (
    <div
      className={`animate-pulse rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800 ${className}`}
      role="status"
      aria-busy="true"
      aria-live="polite"
    >
      <span className="sr-only">Loading chart…</span>
      {title && (
        <div className="mb-4 h-4 w-1/3 rounded bg-gray-200 dark:bg-gray-700" />
      )}
      <div
        className="flex items-end justify-between gap-2"
        style={{ height }}
      >
        {Array.from({ length: bars }).map((_, index) => (
          <div
            key={index}
            className="flex-1 rounded-t bg-gray-200 dark:bg-gray-700"
            style={{ height: `${barHeights[index % barHeights.length]}%` }}
          />
        ))}
      </div>
    </div>
  );
};

export default ChartSkeleton;
