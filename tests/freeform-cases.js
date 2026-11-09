import { parseFreeformQuery, resolveFreeform } from '../js/parser/freeform.js';

const eq = (a, b, msg) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); };
const crate = [
  { id: '1', artist: 'The Beatles', title: 'Abbey Road', year: 1969, section: 'ROCK' },
  { id: '2', artist: 'Joy Division', title: 'Unknown Pleasures', year: 1979, section: 'POST-PUNK' },
];

export const freeformCases = [
  ['parseFreeformQuery: "Artist - Title (Year)" is read straight', () => {
    const [q] = parseFreeformQuery('The Beatles - Abbey Road (1969)');
    eq(q, { artist: 'The Beatles', title: 'Abbey Road', year: 1969 }, 'artist-title-year');
  }],
  ['parseFreeformQuery: also offers the reversed "Title - Artist" reading', () => {
    const qs = parseFreeformQuery('Abbey Road - The Beatles');
    eq(qs.some((q) => q.artist === 'The Beatles' && q.title === 'Abbey Road'), true, 'reversed reading present');
  }],
  ['parseFreeformQuery: "Title by Artist" reversed form', () => {
    const [q] = parseFreeformQuery('Abbey Road by The Beatles');
    eq(q, { artist: 'The Beatles', title: 'Abbey Road', year: null }, 'by-form');
  }],
  ['parseFreeformQuery: colon separator', () => {
    const qs = parseFreeformQuery('Joy Division: Unknown Pleasures');
    eq(qs[0], { artist: 'Joy Division', title: 'Unknown Pleasures', year: null }, 'colon');
  }],
  ['parseFreeformQuery: mixed/odd case is passed through untouched', () => {
    const [q] = parseFreeformQuery('tHe bEatles - Abbey Road');
    eq(q.artist, 'tHe bEatles', 'left as typed when case is mixed');
  }],
  ['parseFreeformQuery: ALL CAPS gets smart-cased', () => {
    const [q] = parseFreeformQuery('THE BEATLES - ABBEY ROAD');
    eq(q, { artist: 'The Beatles', title: 'Abbey Road', year: null }, 'caps normalised');
  }],
  ['parseFreeformQuery: no separator falls back to a title-only guess, never throws', () => {
    const qs = parseFreeformQuery('justanalbumnameiguess');
    eq(qs.length, 1, 'one candidate'); eq(qs[0].artist, null, 'no artist guess');
  }],
  ['parseFreeformQuery: empty/whitespace input returns no candidates', () => {
    eq(parseFreeformQuery('   '), [], 'empty');
  }],
  ['resolveFreeform: picks the reading that actually matches the crate', () => {
    const { album, query } = resolveFreeform('unknown pleasures - joy division', crate);
    eq(album && album.id, '2', 'matched by id'); eq(query.artist, 'Joy Division', 'used the matching reading (all-lowercase input gets smart-cased)');
  }],
  ['resolveFreeform: no crate match still returns a usable query for an AI seed', () => {
    const { album, query } = resolveFreeform('Some Band - Some Album', crate);
    eq(album, null, 'no match'); eq(query.title, 'Some Album', 'query still usable');
  }],
];
