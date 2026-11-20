import { useCallback, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { FloatingEmoji } from '@/components/FloatingEmoji';
import { HeartDrawLimit } from '@/lib/liveHearts';

type Heart = { id: number; index: number };

// The ❤️ hearts floating up the side of a live. `add(n)` draws up to n hearts – at most 8 a second, so a flood
// never slows the phone down (extra hearts are just not drawn).
export function useFloatingHearts() {
  const [hearts, setHearts] = useState<Heart[]>([]);
  const next = useRef(0);
  const limit = useRef(new HeartDrawLimit());
  const add = useCallback((count: number) => {
    const n = limit.current.take(count, Date.now());
    if (n <= 0) return;
    setHearts((now) => {
      const more = Array.from({ length: n }, () => {
        next.current += 1;
        return { id: next.current, index: next.current % 6 };
      });
      // Never more than 24 on screen at once.
      return [...now, ...more].slice(-24);
    });
  }, []);
  const done = useCallback((id: number) => setHearts((now) => now.filter((heart) => heart.id !== id)), []);
  return { hearts, add, done };
}

export function LiveHearts({ hearts, onDone }: { hearts: Heart[]; onDone: (id: number) => void }) {
  return (
    <View style={styles.layer} pointerEvents="none">
      {hearts.map((heart) => (
        <HeartFloat key={heart.id} heart={heart} onDone={onDone} />
      ))}
    </View>
  );
}

function HeartFloat({ heart, onDone }: { heart: Heart; onDone: (id: number) => void }) {
  const finished = useCallback(() => onDone(heart.id), [onDone, heart.id]);
  return <FloatingEmoji emoji="❤️" index={heart.index} rise={260} size={30} onDone={finished} />;
}

const styles = StyleSheet.create({
  layer: {
    position: 'absolute',
    right: 40,
    bottom: 140,
    width: 1,
    height: 1,
    alignItems: 'center',
  },
});
