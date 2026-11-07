const csvCell = (v) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

export function toMarkdown(albums, isOwned) {
  const bySection = new Map();
  for (const a of albums) (bySection.get(a.section) ?? bySection.set(a.section, []).get(a.section)).push(a);
  return [...bySection].map(([sec, list]) => `## ${sec}\n${list.map((a) => `- [${isOwned(a) ? 'x' : ' '}] ${a.artist} - ${a.title}${a.year ? ` (${a.year})` : ''}`).join('\n')}`).join('\n\n') + '\n';
}

export function toCsv(albums, isOwned) {
  const lines = albums.map((a) => [a.artist, a.title, a.year ?? '', a.section, isOwned(a) ? 'yes' : 'no'].map((v) => csvCell(String(v))).join(','));
  return ['artist,title,year,genre,owned', ...lines].join('\n') + '\n';
}

/** Schema: {version:1, sections:[{name, albums:[{artist,title,year,owned,notes?}]}]}. parseJson also accepts a bare array. */
export function toJson(albums, isOwned) {
  const sections = new Map();
  for (const a of albums) (sections.get(a.section) ?? sections.set(a.section, []).get(a.section)).push({ artist: a.artist, title: a.title, year: a.year, owned: isOwned(a) });
  return JSON.stringify({ version: 1, sections: [...sections].map(([name, list]) => ({ name, albums: list })) }, null, 2);
}

/** Ownership-only file for moving between devices: {version:1, owned:{id:1|0}}. */
export const ownershipToJson = (ownMap) => JSON.stringify({ version: 1, owned: ownMap });
export function ownershipFromJson(text) {
  const data = JSON.parse(text);
  if (!data || typeof data.owned !== 'object') throw new Error('not an ownership file');
  return Object.fromEntries(Object.entries(data.owned).filter(([, v]) => v === 0 || v === 1));
}
