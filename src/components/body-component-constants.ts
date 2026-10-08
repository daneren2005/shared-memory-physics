export const SHAPE_RECTANGLE = 1;
export const SHAPE_CIRCLE = 2;
export const SHAPE_CAPSULE = 3;
export const SHAPE_POLYGON = 4;
export const DEFAULT_COLLIDE_CATEGORY = 1;
export const DEFAULT_COLLIDE_MASK = 0xFFFFFFFF;
export const BODY_FLAGS_INDEX = 0;
export const BODY_CATEGORY_INDEX = 1;
export const BODY_MASK_INDEX = 2;
export const BODY_SIZE = 3;
// Shape occupies the low three bits; boolean flags occupy the remaining bits.
export const BODY_SHAPE_MASK = 0b111;
export const BODY_SENSOR_FLAG = 0b1000;
export const BODY_CCD_FLAG = 0b10000;
// Runtime-only flag: defer removal until the final interpolation segment has played.
export const BODY_DYING_FLAG = 0b100000;
export const BODY_BLOCKS_PATH_FLAG = 0b1000000;
