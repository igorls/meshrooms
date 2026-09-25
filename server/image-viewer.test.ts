import { expect, test } from 'bun:test';
import { imageViews } from '../src/prototype/Collaboration';

const desktop = { width: 1400, height: 800 }, phone = { width: 358, height: 700 };

test('a long page or log opens at the viewer width instead of shrinking to a sliver', () => {
  // The full-page phone screenshot from the room: fitting it whole made it 7% of its size.
  expect(imageViews({ width: 780, height: 11004 }, desktop)).toEqual({ start: 'width', other: 'fit' });
  // On a phone the width view is still scaled down, so the other view is actual size, not a whole-page sliver.
  expect(imageViews({ width: 780, height: 11004 }, phone)).toEqual({ start: 'width', other: 'actual' });
  expect(imageViews({ width: 1080, height: 2400 }, desktop)).toEqual({ start: 'width', other: 'fit' });
});

test('ordinary images still open whole, with actual size one click away when they were scaled down', () => {
  expect(imageViews({ width: 1440, height: 900 }, desktop)).toEqual({ start: 'fit', other: 'actual' });
  expect(imageViews({ width: 1080, height: 2400 }, phone)).toEqual({ start: 'fit', other: 'actual' });
  // Nothing to switch to when the image already shows at its own size.
  expect(imageViews({ width: 600, height: 400 }, desktop)).toEqual({ start: 'fit' });
});
