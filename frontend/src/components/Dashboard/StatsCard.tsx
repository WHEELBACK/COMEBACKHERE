import { Skeleton } from "../Skeleton";
import "./StatsCard.css";

interface StatsCardProps {
  title: string;
  value: string | null | undefined;
  variant?: "default" | "success" | "warning" | "danger";
}

export default function StatsCard({ title, value, variant = "default" }: StatsCardProps) {
  return (
    <div className={`stats-card stats-card--${variant}`}>
      <h3 className="stats-card-title">{title}</h3>
      {value == null ? (
        <Skeleton
          width="60%"
          height="32px"
          aria-label={`Loading ${title}`}
          className="stats-card-skeleton"
        />
      ) : (
        <p className="stats-card-value">{value}</p>
      )}
    </div>
  );
}
