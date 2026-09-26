import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { detectImage, validateMetadata, MAX_IMAGE_BYTES } from '../src/delivery.ts';

test('one valid metadata record and optional note', () => {
  assert.equal(validateMetadata({ day: 'Monday', subsidiary: 'ARCO', headline: 'A', caption: 'B' }).headline, 'A');
  assert.throws(() => validateMetadata({ day: 'Monday', subsidiary: 'ARCO', headline: '', caption: 'B' }), /invalid_headline/);
});

test('accepts supported signatures and rejects oversized or unknown images', () => {
  assert.equal(detectImage(Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0])).extension, 'png');
  assert.equal(detectImage(Buffer.from([255,216,255,0,0,0,0,0,0,0,255,217])).extension, 'jpg');
  assert.equal(detectImage(Buffer.from('RIFF\0\0\0\0WEBP')).extension, 'webp');
  assert.throws(() => detectImage(Buffer.alloc(MAX_IMAGE_BYTES + 1)), /invalid_image_size/);
  assert.throws(() => detectImage(Buffer.from('unrecognized image bytes')), /unsupported_image/);
});
