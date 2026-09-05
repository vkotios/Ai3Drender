import type { EnvironmentSettings, PropKind } from '@/lib/types';

/**
 * Exhibition booth presets.
 *
 * `hdriPreset` names a drei <Environment preset>, which supplies image-based
 * lighting - the single biggest factor in whether a furniture render reads as
 * photographic rather than as CG.
 */
export interface BoothPreset {
  id: string;
  name: string;
  description: string;
  environment: Omit<EnvironmentSettings, 'presetId'>;
  /** Props that suit this treatment, offered as one-click additions. */
  suggestedProps: PropKind[];
}

const base = {
  boothWidth: 8,
  boothDepth: 6,
  boothHeight: 3.4,
  walls: { back: true, left: true, right: false },
  showGrid: false,
} as const;

export const BOOTH_PRESETS: BoothPreset[] = [
  {
    id: 'gallery_white',
    name: 'Gallery White',
    description:
      'Neutral white stand with polished concrete. The default for catalogue photography - ' +
      'shows true material colour with nothing bouncing coloured light back onto the piece.',
    environment: {
      ...base,
      floorMaterialId: 'polished_concrete',
      floorColorHex: '#C9C6C0',
      wallColorHex: '#F2F0EC',
      hdriPreset: 'studio',
      hdriIntensity: 0.9,
      ambientIntensity: 0.35,
      backgroundColorHex: '#EDEBE6',
    },
    suggestedProps: ['plinth', 'planter'],
  },
  {
    id: 'warm_oak_loft',
    name: 'Warm Oak Loft',
    description:
      'Oak flooring against putty walls. Flatters walnut, oak and wool upholstery; the warm ' +
      'bounce is unkind to cool greys.',
    environment: {
      ...base,
      floorMaterialId: 'oak_plank',
      floorColorHex: '#B08554',
      wallColorHex: '#E4DED2',
      hdriPreset: 'apartment',
      hdriIntensity: 1,
      ambientIntensity: 0.3,
      backgroundColorHex: '#DED7C9',
    },
    suggestedProps: ['rug', 'side_table', 'planter'],
  },
  {
    id: 'dark_luxe',
    name: 'Dark Luxe',
    description:
      'Charcoal stand with directional accent lighting. High-contrast; best for leather, ' +
      'brass and dark timber where you want the silhouette to carry the image.',
    environment: {
      ...base,
      walls: { back: true, left: true, right: true },
      floorMaterialId: 'dark_stone',
      floorColorHex: '#2E2C2A',
      wallColorHex: '#1F1E1D',
      hdriPreset: 'night',
      hdriIntensity: 0.55,
      ambientIntensity: 0.12,
      backgroundColorHex: '#141414',
    },
    suggestedProps: ['plinth', 'floor_lamp', 'partition'],
  },
  {
    id: 'nordic_light',
    name: 'Nordic Light',
    description:
      'Pale ash floor, soft daylight from one side. Long soft shadows read well on ' +
      'sculptural seating.',
    environment: {
      ...base,
      walls: { back: true, left: false, right: false },
      floorMaterialId: 'ash_plank',
      floorColorHex: '#D8CFC0',
      wallColorHex: '#F5F3EF',
      hdriPreset: 'dawn',
      hdriIntensity: 1.15,
      ambientIntensity: 0.4,
      backgroundColorHex: '#EFECE6',
    },
    suggestedProps: ['rug', 'planter'],
  },
  {
    id: 'showroom_grid',
    name: 'Showroom Grid',
    description:
      'Open-plan showroom floor with the layout grid visible. A working view for checking ' +
      'circulation and clearances rather than a hero shot.',
    environment: {
      ...base,
      walls: { back: false, left: false, right: false },
      showGrid: true,
      floorMaterialId: 'sealed_screed',
      floorColorHex: '#B9B7B2',
      wallColorHex: '#FFFFFF',
      hdriPreset: 'warehouse',
      hdriIntensity: 0.85,
      ambientIntensity: 0.5,
      backgroundColorHex: '#E6E5E2',
    },
    suggestedProps: ['partition'],
  },
];

export const DEFAULT_PRESET_ID = 'gallery_white';

export function getPreset(id: string): BoothPreset {
  return BOOTH_PRESETS.find((p) => p.id === id) ?? BOOTH_PRESETS[0];
}

/** Physical description of the staging props, in metres. */
export const PROP_DEFINITIONS: Record<
  PropKind,
  { label: string; size: [number, number, number]; colorHex: string; roughness: number }
> = {
  plinth: { label: 'Plinth', size: [1.2, 0.35, 1.2], colorHex: '#EDEAE4', roughness: 0.75 },
  rug: { label: 'Rug', size: [3, 0.02, 2], colorHex: '#9C9382', roughness: 0.95 },
  partition: { label: 'Partition', size: [2.4, 2.4, 0.08], colorHex: '#DAD6CE', roughness: 0.8 },
  planter: { label: 'Planter', size: [0.5, 0.6, 0.5], colorHex: '#6E6B64', roughness: 0.7 },
  side_table: { label: 'Side table', size: [0.5, 0.5, 0.5], colorHex: '#4A3E33', roughness: 0.5 },
  floor_lamp: { label: 'Floor lamp', size: [0.35, 1.6, 0.35], colorHex: '#2A2A2D', roughness: 0.4 },
};
