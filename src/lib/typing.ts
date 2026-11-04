import type { RealtimeChannel } from '@supabase/supabase-js';
import { useCallback, useEffect, useRef, useState } from 'react';

import { supabase } from './supabase';

// How often to repeat "I'm typing" while you type, and how long the other person's "typing…" lasts without news.
const SEND_EVERY_MS = 2500;
const HIDE_AFTER_MS = 4000;

// "Typing…" in a chat: tells your friend when you're typing, and tells you when they are.
// It goes through a private live channel that only the two of you can join (see the database rules).
export function useTyping(me: string, friend: string, enabled: boolean) {
  const [friendTyping, setFriendTyping] = useState(false);
  const channel = useRef<RealtimeChannel | null>(null);
  const lastSent = useRef(0);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const topic = `typing:${[me, friend].sort().join(':')}`;
    let joined: RealtimeChannel | null = null;
    let cancelled = false;

    (async () => {
      // Private channels check who you are, so hand over your login first.
      await supabase.realtime.setAuth();
      if (cancelled) return;
      joined = supabase
        .channel(topic, { config: { private: true, broadcast: { self: false } } })
        .on('broadcast', { event: 'typing' }, ({ payload }) => {
          if (payload?.userId !== friend) return;
          if (hideTimer.current) clearTimeout(hideTimer.current);
          setFriendTyping(payload.typing === true);
          // If we don't hear from them for a few seconds, they stopped.
          if (payload.typing === true) hideTimer.current = setTimeout(() => setFriendTyping(false), HIDE_AFTER_MS);
        })
        .subscribe((status) => {
          if (status === 'CHANNEL_ERROR') console.warn('Typing channel could not connect');
        });
      channel.current = joined;
    })().catch((error) => console.warn('Typing channel failed', error));

    return () => {
      cancelled = true;
      if (hideTimer.current) clearTimeout(hideTimer.current);
      channel.current = null;
      lastSent.current = 0;
      if (joined) supabase.removeChannel(joined);
    };
  }, [me, friend, enabled]);

  // Call this whenever your message box changes.
  const onTextChange = useCallback(
    (text: string) => {
      const live = channel.current;
      if (!live) return;
      if (text.trim() === '') {
        // You cleared the box (or sent the message): stop showing "typing…" right away.
        if (lastSent.current !== 0) {
          lastSent.current = 0;
          live.send({ type: 'broadcast', event: 'typing', payload: { userId: me, typing: false } });
        }
        return;
      }
      const now = Date.now();
      if (now - lastSent.current > SEND_EVERY_MS) {
        lastSent.current = now;
        live.send({ type: 'broadcast', event: 'typing', payload: { userId: me, typing: true } });
      }
    },
    [me],
  );

  // When their message arrives, the "typing…" bubble should go away straight away.
  const clearFriendTyping = useCallback(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    setFriendTyping(false);
  }, []);

  return { friendTyping: enabled && friendTyping, onTextChange, clearFriendTyping };
}

// "Typing…" in a group chat: who in the group is typing right now (their ids), and a function to call when your
// message box changes. Private live channel  typing-group:<group id>  – only the group's members can join.
export function useGroupTyping(me: string, groupId: string, enabled: boolean) {
  const [typing, setTyping] = useState<string[]>([]);
  const channel = useRef<RealtimeChannel | null>(null);
  const lastSent = useRef(0);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    if (!enabled) return;
    const topic = `typing-group:${groupId}`;
    const hideTimers = timers.current;
    let joined: RealtimeChannel | null = null;
    let cancelled = false;
    const stop = (userId: string) => {
      const timer = hideTimers.get(userId);
      if (timer) clearTimeout(timer);
      hideTimers.delete(userId);
      setTyping((current) => current.filter((id) => id !== userId));
    };

    (async () => {
      await supabase.realtime.setAuth();
      if (cancelled) return;
      joined = supabase
        .channel(topic, { config: { private: true, broadcast: { self: false } } })
        .on('broadcast', { event: 'typing' }, ({ payload }) => {
          const userId = payload?.userId as string | undefined;
          if (!userId || userId === me) return;
          if (payload.typing !== true) {
            stop(userId);
            return;
          }
          const old = hideTimers.get(userId);
          if (old) clearTimeout(old);
          hideTimers.set(userId, setTimeout(() => stop(userId), HIDE_AFTER_MS));
          setTyping((current) => (current.includes(userId) ? current : [...current, userId]));
        })
        .subscribe((status) => {
          if (status === 'CHANNEL_ERROR') console.warn('Group typing channel could not connect');
        });
      channel.current = joined;
    })().catch((error) => console.warn('Group typing channel failed', error));

    return () => {
      cancelled = true;
      hideTimers.forEach((timer) => clearTimeout(timer));
      hideTimers.clear();
      channel.current = null;
      lastSent.current = 0;
      if (joined) supabase.removeChannel(joined);
    };
  }, [me, groupId, enabled]);

  const onTextChange = useCallback(
    (text: string) => {
      const live = channel.current;
      if (!live) return;
      if (text.trim() === '') {
        if (lastSent.current !== 0) {
          lastSent.current = 0;
          live.send({ type: 'broadcast', event: 'typing', payload: { userId: me, typing: false } });
        }
        return;
      }
      const now = Date.now();
      if (now - lastSent.current > SEND_EVERY_MS) {
        lastSent.current = now;
        live.send({ type: 'broadcast', event: 'typing', payload: { userId: me, typing: true } });
      }
    },
    [me],
  );

  // A message from them arrived: they're not typing any more.
  const clearTyping = useCallback((userId: string) => {
    const timer = timers.current.get(userId);
    if (timer) clearTimeout(timer);
    timers.current.delete(userId);
    setTyping((current) => current.filter((id) => id !== userId));
  }, []);

  return { typing: enabled ? typing : [], onTextChange, clearTyping };
}
