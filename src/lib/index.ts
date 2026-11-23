export { Slicer, Piece, type SliceableOptions, type SlicerOptions, type CutEvent } from './slicer.ts';
export { cut, type CutResult } from './cut.ts';
export { solidFromGeometry, geometryFromSolid, measure, openEdges, invert, type Solid } from './solid.ts';
export { noiseTexture, noise3, fbm3, cells3 } from './noise.ts';
export { cutPreview, withCutPreview, marbleInside, stoneInside, woodInside, bambooInside, melonInside, orangeInside, appleInside, metalInside, plainInside } from './inside.ts';
