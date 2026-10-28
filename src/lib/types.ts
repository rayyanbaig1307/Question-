// Shapes of the rows stored in Supabase (see supabase/migrations).

export type Profile = {
  id: string;
  username: string;
  display_name: string;
  bio: string;
  avatar_path: string | null;
  is_private: boolean;
  location_sharing: boolean;
  created_at: string;
  updated_at: string;
};

export type Post = {
  id: string;
  user_id: string;
  media_path: string;
  caption: string;
  // Set when this post was someone's answer to the Daily Dare (the day, like "2026-10-28").
  dare_day: string | null;
  // Peekaboo drop posts: the day of the drop, how many seconds after the drop it was posted,
  // and a tiny blurry preview shown to friends who haven't posted their own drop yet.
  drop_day: string | null;
  drop_late_seconds: number | null;
  blur_path: string | null;
  created_at: string;
};

export type PostWithAuthor = Post & { author: Profile | null };

export type Story = {
  id: string;
  user_id: string;
  media_path: string;
  created_at: string;
  expires_at: string;
};

export type ReportContentType = 'user' | 'post' | 'story' | 'message' | 'comment';
