// "5m", "3h", "2d" style short times, like Snapchat/Instagram.
export function timeAgo(iso: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return 'now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.floor(days / 7);
  if (weeks < 52) return `${weeks}w`;
  return `${Math.floor(days / 365)}y`;
}

// "23h left" for stories.
export function timeLeft(iso: string): string {
  const minutes = Math.max(0, Math.floor((new Date(iso).getTime() - Date.now()) / 60000));
  if (minutes < 60) return `${minutes}m left`;
  return `${Math.floor(minutes / 60)}h left`;
}
