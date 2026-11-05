import { StyleSheet, Text, View, type ViewStyle } from 'react-native';

// ---------------------------------------------------------------------------
// Peekaboo+ ⭐ sticker packs. Every sticker is drawn with plain boxes and text (no pictures, no blur), so it
// gets saved into the photo just like it looks on screen. The looks come from the Peekaboo+ look book
// (docs/peekaboo-plus-preview.html → "Sticker packs"). No googly eyes here – those stay free for everyone.
// ---------------------------------------------------------------------------

type Shape = 'stamp' | 'ticket' | 'speech' | 'seal' | 'tape' | 'pill' | 'neon' | 'burst';

type PlusStickerDef = {
  id: string;
  shape: Shape;
  // Use \n for a new line.
  text: string;
  // The sticker's main color (for neon: the glow color).
  bg: string;
  // Text color (not used by neon, which is always white).
  fg: string;
  // Turn in degrees, when it's different from the shape's usual turn.
  turn?: number;
  // Text size (in picker size), when it's different from the shape's usual size.
  size?: number;
};

export type PlusPack = { id: string; name: string; stickers: PlusStickerDef[] };

const WHITE = '#FFFFFF';
const NAVY = '#1B1428';

export const PLUS_PACKS: PlusPack[] = [
  {
    id: 'main-character',
    name: '✨ Main Character',
    stickers: [
      { id: 'plus-main-character', shape: 'seal', text: 'MAIN\nCHARACTER', bg: '#FF3D8E', fg: WHITE, size: 10 },
      { id: 'plus-npc', shape: 'pill', text: 'NPC 🤖', bg: '#6B5F80', fg: WHITE },
      { id: 'plus-ate', shape: 'stamp', text: 'ATE 💅', bg: '#FF3D8E', fg: WHITE, turn: -6 },
      { id: 'plus-slay', shape: 'neon', text: 'SLAY', bg: '#FF4F9A', fg: WHITE },
      { id: 'plus-ten-out-of-ten', shape: 'seal', text: '10/10', bg: '#F5C400', fg: NAVY },
      { id: 'plus-iconic-behaviour', shape: 'ticket', text: 'ICONIC\nBEHAVIOUR', bg: '#8A4DFF', fg: WHITE },
      { id: 'plus-low-battery', shape: 'tape', text: 'low battery 🪫', bg: '#DFF7EC', fg: NAVY },
      { id: 'plus-unbothered', shape: 'speech', text: 'unbothered 😌', bg: '#FFFFFF', fg: NAVY },
      { id: 'plus-no-notes', shape: 'burst', text: 'NO\nNOTES', bg: '#1E9BEA', fg: WHITE, size: 13 },
      { id: 'plus-it-girl', shape: 'stamp', text: 'IT GIRL', bg: NAVY, fg: '#FFE14D', turn: 5 },
      { id: 'plus-certified', shape: 'pill', text: 'certified ✔', bg: '#1DB97F', fg: WHITE },
      { id: 'plus-vibe', shape: 'neon', text: 'VIBE', bg: '#38B6FF', fg: WHITE },
    ],
  },
  {
    id: 'bestie',
    name: '💞 Bestie Pack',
    stickers: [
      { id: 'plus-bestie', shape: 'seal', text: 'BESTIE', bg: '#FF3D8E', fg: WHITE },
      { id: 'plus-my-person', shape: 'speech', text: 'my person 💞', bg: '#FFD6EA', fg: NAVY },
      { id: 'plus-group-chat', shape: 'ticket', text: 'GROUP\nCHAT', bg: '#1E9BEA', fg: WHITE },
      { id: 'plus-chaos-crew', shape: 'stamp', text: 'CHAOS\nCREW', bg: '#FF7A1F', fg: WHITE, turn: 4 },
      { id: 'plus-partner-in-crime', shape: 'tape', text: 'partner in crime', bg: '#FFF3B0', fg: NAVY },
      { id: 'plus-plus-one', shape: 'pill', text: 'plus one ➕', bg: '#8A4DFF', fg: WHITE },
      { id: 'plus-text-me', shape: 'speech', text: 'text me!! 📱', bg: '#FFFFFF', fg: NAVY },
      { id: 'plus-seen', shape: 'neon', text: 'SEEN ✓✓', bg: '#3DDC97', fg: WHITE },
      { id: 'plus-ride-or-die', shape: 'seal', text: 'RIDE\nOR DIE', bg: NAVY, fg: '#FF4F9A' },
      { id: 'plus-bff', shape: 'burst', text: 'BFF', bg: '#F5C400', fg: NAVY, size: 24 },
      { id: 'plus-inside-joke', shape: 'stamp', text: 'INSIDE\nJOKE 🤫', bg: '#9B5CFF', fg: WHITE, turn: -6 },
      { id: 'plus-admit-two', shape: 'ticket', text: 'ADMIT\n2 🎟️', bg: '#FF3D8E', fg: WHITE },
    ],
  },
  {
    id: 'dare-mode',
    name: '🎯 Dare Mode',
    stickers: [
      { id: 'plus-dare-done', shape: 'stamp', text: 'DARE\nDONE ✅', bg: '#FF7A1F', fg: WHITE, turn: -6 },
      { id: 'plus-no-cap', shape: 'pill', text: 'no cap 🧢', bg: '#1DB97F', fg: WHITE },
      { id: 'plus-iconic', shape: 'stamp', text: 'ICONIC 🔥', bg: '#FF3D8E', fg: WHITE, turn: 4 },
      { id: 'plus-mid', shape: 'stamp', text: 'MID 😬', bg: '#6B5F80', fg: WHITE, turn: -6 },
      { id: 'plus-unhinged', shape: 'stamp', text: 'UN\nHINGED 💀', bg: NAVY, fg: WHITE, turn: -6 },
      { id: 'plus-your-turn', shape: 'speech', text: 'your turn 👉', bg: '#FFFFFF', fg: NAVY },
      { id: 'plus-streak', shape: 'burst', text: 'STREAK', bg: '#F5C400', fg: NAVY, size: 17 },
      { id: 'plus-chicken', shape: 'stamp', text: 'CHICKEN 🐔', bg: '#8A4DFF', fg: WHITE, turn: 6 },
      { id: 'plus-double-dare', shape: 'seal', text: 'DOUBLE\nDARE', bg: '#E8233F', fg: WHITE },
      { id: 'plus-proof', shape: 'tape', text: "proof or it didn't happen", bg: '#FFE1EC', fg: NAVY },
      { id: 'plus-i-did-it', shape: 'neon', text: 'I DID IT', bg: '#FFE14D', fg: WHITE },
      { id: 'plus-legend-status', shape: 'ticket', text: 'LEGEND\nSTATUS', bg: '#1E9BEA', fg: WHITE },
      { id: 'plus-too-easy', shape: 'pill', text: 'too easy 😴', bg: '#38B6FF', fg: WHITE },
      { id: 'plus-dare-me', shape: 'burst', text: 'DARE\nME', bg: '#FF3D8E', fg: WHITE, size: 15 },
      { id: 'plus-respect', shape: 'seal', text: 'RESPECT\n🫡', bg: '#0E7C66', fg: WHITE },
      { id: 'plus-send-it', shape: 'stamp', text: 'SEND IT 🚀', bg: NAVY, fg: '#FF8A3D', turn: -3 },
    ],
  },
  {
    id: 'mood',
    name: '🌙 Mood Pack',
    stickers: [
      { id: 'plus-cant-talk', shape: 'speech', text: "can't talk 🤐", bg: '#FFFFFF', fg: NAVY },
      { id: 'plus-brb', shape: 'pill', text: 'brb ⏳', bg: '#6B5F80', fg: WHITE },
      { id: 'plus-mood', shape: 'neon', text: 'MOOD', bg: '#9B5CFF', fg: WHITE },
      { id: 'plus-off-the-grid', shape: 'tape', text: 'off the grid', bg: '#E7E0FF', fg: NAVY },
      { id: 'plus-nap-time', shape: 'seal', text: 'NAP\nTIME 😴', bg: '#1E3A8A', fg: WHITE },
      { id: 'plus-vibes', shape: 'stamp', text: 'VIBES ✌️', bg: '#3DDC97', fg: '#0E3B33', turn: 4 },
      { id: 'plus-sunday-reset', shape: 'ticket', text: 'SUNDAY\nRESET', bg: '#FF8A3D', fg: WHITE },
      { id: 'plus-omg', shape: 'burst', text: 'OMG', bg: '#FF3D8E', fg: WHITE, size: 22 },
    ],
  },
];

const BY_ID = new Map(PLUS_PACKS.flatMap((pack) => pack.stickers.map((s) => [s.id, s] as const)));

// True for the Peekaboo+ stickers (their names all start with "plus-").
export function isPlusSticker(id: string): boolean {
  return id.startsWith('plus-');
}

// The words on a sticker, for screen readers.
export function plusStickerLabel(id: string): string {
  return (BY_ID.get(id)?.text ?? id).replace(/\n/g, ' ');
}

// Draws one Peekaboo+ sticker. In the picker (`small`) it's drawn at half size.
export function PlusSticker({ id, small = false }: { id: string; small?: boolean }) {
  const def = BY_ID.get(id);
  if (!def) return null;
  // The look book's sizes are the picker size; on the photo everything is twice as big.
  const m = small ? 1 : 2;
  const fontSize = (def.size ?? SHAPE_FONT[def.shape]) * m;
  const text = (color: string, extra?: object) => (
    <Text style={[styles.text, { color, fontSize, lineHeight: Math.round(fontSize * 1.1) }, extra]}>{def.text}</Text>
  );
  const turn = (deg: number): ViewStyle => ({ transform: [{ rotate: `${def.turn ?? deg}deg` }] });

  switch (def.shape) {
    // A rounded label with a white border, a little turned.
    case 'stamp':
      return (
        <View
          style={[
            styles.shadow,
            turn(-6),
            {
              backgroundColor: def.bg,
              paddingVertical: 6 * m,
              paddingHorizontal: 10 * m,
              borderRadius: 12 * m,
              borderWidth: 3 * m,
              borderColor: WHITE,
            },
          ]}>
          {text(def.fg)}
        </View>
      );

    // A ticket: rounded corners and a dashed line inside.
    case 'ticket':
      return (
        <View style={turn(4)}>
          <View style={{ backgroundColor: def.bg, paddingVertical: 10 * m, paddingHorizontal: 14 * m, borderRadius: 6 * m }}>
            <View
              pointerEvents="none"
              style={[
                StyleSheet.absoluteFill,
                {
                  margin: 4 * m,
                  borderRadius: 4 * m,
                  borderWidth: Math.max(1, 1 * m),
                  borderStyle: 'dashed',
                  borderColor: 'rgba(255,255,255,0.6)',
                },
              ]}
            />
            {text(def.fg)}
          </View>
        </View>
      );

    // A speech bubble with a little tail at the bottom left.
    case 'speech':
      return (
        <View style={styles.speechWrap}>
          <View
            style={[
              styles.shadow,
              { backgroundColor: def.bg, maxWidth: 92 * m, paddingVertical: 8 * m, paddingHorizontal: 12 * m, borderRadius: 16 * m },
            ]}>
            {text(def.fg)}
          </View>
          <View
            style={{
              marginLeft: 14 * m,
              marginTop: -1,
              width: 0,
              height: 0,
              borderLeftWidth: 7 * m,
              borderRightWidth: 7 * m,
              borderTopWidth: 7 * m,
              borderLeftColor: 'transparent',
              borderRightColor: 'transparent',
              borderTopColor: def.bg,
            }}
          />
        </View>
      );

    // A round seal: a dashed white edge and a thin ring inside in the text color.
    case 'seal': {
      const box = 78 * m;
      return (
        <View
          style={[
            styles.shadow,
            styles.center,
            turn(-8),
            {
              width: box,
              height: box,
              borderRadius: box / 2,
              backgroundColor: def.bg,
              borderWidth: 3 * m,
              borderStyle: 'dashed',
              borderColor: 'rgba(255,255,255,0.8)',
            },
          ]}>
          <View
            pointerEvents="none"
            style={[StyleSheet.absoluteFill, { margin: 3 * m, borderRadius: box / 2, borderWidth: 3 * m, borderColor: def.fg }]}
          />
          {text(def.fg)}
        </View>
      );
    }

    // A strip of tape, a little skewed and turned.
    case 'tape':
      return (
        <View
          style={[
            styles.shadow,
            {
              backgroundColor: def.bg,
              maxWidth: 92 * m,
              paddingVertical: 6 * m,
              paddingHorizontal: 10 * m,
              borderRadius: 2 * m,
              transform: [{ rotate: `${def.turn ?? -4}deg` }, { skewX: '-6deg' }],
            },
          ]}>
          {text(def.fg, { fontWeight: '800' })}
        </View>
      );

    case 'pill':
      return (
        <View
          style={[
            styles.shadow,
            turn(3),
            { backgroundColor: def.bg, paddingVertical: 6 * m, paddingHorizontal: 14 * m, borderRadius: 999 },
          ]}>
          {text(def.fg, { fontWeight: '800' })}
        </View>
      );

    // A neon sign: a dark box with a glowing border and glowing white words. The glow is a soft see-through
    // ring around the box (plus a shadow), so it still shows when the sticker is saved into the photo.
    case 'neon':
      return (
        <View style={{ padding: 3 * m, borderRadius: 13 * m, backgroundColor: `${def.bg}40` }}>
          <View
            style={[
              styles.neonGlow,
              {
                shadowColor: def.bg,
                shadowRadius: 8 * m,
                paddingVertical: 4 * m,
                paddingHorizontal: 10 * m,
                borderRadius: 10 * m,
                borderWidth: 2 * m,
                borderColor: def.bg,
              },
            ]}>
            <View
              pointerEvents="none"
              style={[StyleSheet.absoluteFill, { borderRadius: 8 * m, borderWidth: 3 * m, borderColor: `${def.bg}55` }]}
            />
            {text(WHITE, { textShadowColor: def.bg, textShadowOffset: { width: 0, height: 0 }, textShadowRadius: 8 * m })}
          </View>
        </View>
      );

    // A star burst: three turned rounded squares on top of each other make a 12-point star.
    case 'burst': {
      const box = 74 * m;
      const side = box * 0.7;
      return (
        <View style={[styles.center, { width: box, height: box }]}>
          {[0, 30, 60].map((deg) => (
            <View
              key={deg}
              style={{
                position: 'absolute',
                width: side,
                height: side,
                borderRadius: 4 * m,
                backgroundColor: def.bg,
                transform: [{ rotate: `${deg}deg` }],
              }}
            />
          ))}
          {text(def.fg)}
        </View>
      );
    }
  }
}

// The usual text size of each shape, in picker size.
const SHAPE_FONT: Record<Shape, number> = {
  stamp: 15,
  ticket: 13,
  speech: 13,
  seal: 12,
  tape: 12,
  pill: 14,
  neon: 20,
  burst: 22,
};

const styles = StyleSheet.create({
  text: {
    fontWeight: '900',
    textAlign: 'center',
  },
  center: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  shadow: {
    shadowColor: '#000000',
    shadowOpacity: 0.2,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 3 },
    elevation: 4,
  },
  speechWrap: {
    alignItems: 'flex-start',
  },
  neonGlow: {
    backgroundColor: '#120C1C',
    shadowOpacity: 0.9,
    shadowOffset: { width: 0, height: 0 },
    elevation: 6,
  },
});
