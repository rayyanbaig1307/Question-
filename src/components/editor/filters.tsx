import { StyleSheet, View, type ViewStyle } from 'react-native';

type Blend = NonNullable<ViewStyle['mixBlendMode']>;

// A color filter is a few see-through color layers laid over the photo, each mixed in a different way
// (like the blend modes in photo apps). Swipe left/right on a photo to change it.
export type PhotoFilter = {
  name: string;
  layers: { color: string; blend: Blend; opacity: number }[];
};

export const FILTERS: PhotoFilter[] = [
  { name: 'No filter', layers: [] },
  {
    name: 'Bubblegum 🍬',
    layers: [
      { color: '#FF4F9A', blend: 'soft-light', opacity: 0.6 },
      { color: '#FFD1E6', blend: 'screen', opacity: 0.12 },
    ],
  },
  { name: 'Grape 🍇', layers: [{ color: '#9B5CFF', blend: 'color', opacity: 0.35 }] },
  {
    name: 'Sunny ☀️',
    layers: [
      { color: '#FFB347', blend: 'soft-light', opacity: 0.65 },
      { color: '#FFE14D', blend: 'multiply', opacity: 0.12 },
    ],
  },
  { name: 'Ocean 🌊', layers: [{ color: '#38B6FF', blend: 'soft-light', opacity: 0.65 }] },
  {
    name: 'Noir 🖤',
    layers: [
      { color: '#808080', blend: 'saturation', opacity: 1 },
      { color: '#000000', blend: 'soft-light', opacity: 0.3 },
    ],
  },
  {
    name: 'Vintage 📼',
    layers: [
      { color: '#808080', blend: 'saturation', opacity: 0.55 },
      { color: '#C08552', blend: 'multiply', opacity: 0.3 },
      { color: '#FFF3D6', blend: 'screen', opacity: 0.15 },
    ],
  },
];

// The color layers of one filter, filling whatever they're placed in (on top of the photo).
export function FilterLayers({ filter }: { filter: PhotoFilter }) {
  return (
    <>
      {filter.layers.map((layer, index) => (
        <View
          key={index}
          pointerEvents="none"
          style={[StyleSheet.absoluteFill, { backgroundColor: layer.color, opacity: layer.opacity, mixBlendMode: layer.blend }]}
        />
      ))}
    </>
  );
}
