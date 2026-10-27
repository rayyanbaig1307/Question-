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
