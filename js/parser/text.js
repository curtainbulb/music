const GENRE_SRC = [
 ['CLASSIC ROCK / BRITISH INVASION','The Beatles|The Rolling Stones|The Kinks|The Who|The Animals|The Yardbirds|Led Zeppelin|Queen|Eagles|Fleetwood Mac|Creedence Clearwater Revival|Rod Stewart|Dire Straits|Steve Miller Band|Boston|Electric Light Orchestra|Tom Petty and the Heartbreakers|Bruce Springsteen|Crosby, Stills, Nash & Young|The Beach Boys|Bad Company|Free'],
 ['FOLK ROCK','Bob Dylan|The Byrds|Buffalo Springfield|Simon & Garfunkel|Joni Mitchell|Neil Young|The Band|Fairport Convention|Nick Drake|John Martyn|Cat Stevens|James Taylor'],
 ['PSYCHEDELIC ROCK','The Jimi Hendrix Experience|Jimi Hendrix|The Doors|Jefferson Airplane|The Velvet Underground|Cream|Grateful Dead|The 13th Floor Elevators|Love|Captain Beefheart|Syd Barrett'],
 ['SOUTHERN ROCK','The Allman Brothers Band|Lynyrd Skynyrd|ZZ Top|The Marshall Tucker Band|Wet Willie|Charlie Daniels Band'],
 ['PUB ROCK','Dr. Feelgood|Graham Parker and the Rumour|Nick Lowe|Brinsley Schwarz|Eddie and the Hot Rods|Ian Dury'],
 ['KRAUTROCK','Can|Neu!|Faust|Kraftwerk|Tangerine Dream|Cluster|Amon Düül II'],
 ['PROGRESSIVE ROCK','King Crimson|Pink Floyd|Yes|Genesis|Jethro Tull|Emerson, Lake & Palmer|Rush|Van der Graaf Generator|Gentle Giant|Camel'],
 ['GLAM ROCK','David Bowie|T. Rex|Roxy Music|New York Dolls|Mott the Hoople|Iggy Pop|Sweet'],
 ['HARD ROCK','Deep Purple|Aerosmith|AC/DC|Van Halen|Guns N\' Roses|Whitesnake|Alice Cooper|Ted Nugent|Heart'],
 ['ARENA ROCK','Journey|Foreigner|Bon Jovi|Def Leppard|REO Speedwagon|Styx|Kansas|Asia'],
 ['HEAVY METAL','Black Sabbath|Judas Priest|Motörhead|Iron Maiden|Saxon|Dio|Ozzy Osbourne'],
 ['GLAM METAL','Mötley Crüe|Poison|Warrant|Ratt|Cinderella|Skid Row|Twisted Sister|Winger'],
 ['THRASH METAL','Metallica|Slayer|Megadeth|Anthrax|Testament|Exodus|Overkill'],
 ['GROOVE METAL','Pantera|White Zombie|Sepultura'],
 ['DEATH METAL','Death|Morbid Angel|Obituary|Cannibal Corpse|Deicide|Suffocation|Entombed|Dismember|At the Gates|Carcass'],
 ['BLACK METAL','Venom|Bathory|Celtic Frost|Mayhem|Darkthrone|Emperor|Burzum|Gorgoroth|Immortal|Enslaved|Satyricon'],
 ['DOOM METAL','Saint Vitus|Candlemass|Cathedral|My Dying Bride|Pentagram|The Obsessed'],
 ['STONER ROCK / DESERT ROCK','Kyuss|Queens of the Stone Age|Sleep|Monster Magnet|Fu Manchu|Electric Wizard|Clutch'],
 ['SLUDGE METAL','Melvins|Eyehategod|Crowbar|Acid Bath|Mastodon'],
 ['POWER METAL','Helloween|Blind Guardian|Gamma Ray|Stratovarius|Rhapsody'],
 ['PROGRESSIVE METAL','Queensrÿche|Dream Theater|Tool|Opeth|Fates Warning'],
 ['SYMPHONIC METAL','Nightwish|Within Temptation|Evanescence|Therion|Epica'],
 ['GOTHIC METAL','Paradise Lost|Type O Negative|HIM|The 69 Eyes|Anathema'],
 ['METALCORE','Converge|Killswitch Engage|Avenged Sevenfold|As I Lay Dying|Underoath'],
 ['INDUSTRIAL METAL','Ministry|Nine Inch Nails|Rammstein|Marilyn Manson|KMFDM|Fear Factory|Rob Zombie|Skinny Puppy|Throbbing Gristle|Killing Joke|Coil|Einstürzende Neubauten|Front 242'],
 ['NU METAL','Korn|Limp Bizkit|Slipknot|Linkin Park|System of a Down|Deftones|Mudvayne|Staind'],
 ['PUNK','The Stooges|Ramones|Sex Pistols|The Clash|Patti Smith|Television|Buzzcocks|The Damned|The Jam|X-Ray Spex|Stiff Little Fingers|The Undertones|Sham 69'],
 ['HARDCORE PUNK','Black Flag|Minor Threat|Bad Brains|Dead Kennedys|Hüsker Dü|Minutemen|Circle Jerks|Germs|Fear|Adolescents|Descendents|Misfits|Suicidal Tendencies|7 Seconds|Youth of Today'],
 ['POST-PUNK','Joy Division|Wire|Talking Heads|Gang of Four|Public Image Ltd|The Fall|Siouxsie and the Banshees|Magazine|The Raincoats|Young Marble Giants|The Pop Group|Scritti Politti|Orange Juice'],
 ['GOTHIC ROCK','Bauhaus|The Cure|The Sisters of Mercy|Fields of the Nephilim|Christian Death|The Mission|Alien Sex Fiend'],
 ['NEW WAVE / SYNTH POP','Blondie|The Cars|Devo|The Police|Elvis Costello and the Attractions|Elvis Costello|Gary Numan|Depeche Mode|New Order|The Human League|Duran Duran|Tears for Fears|Eurythmics|OMD|Soft Cell|Yazoo|Pet Shop Boys|Erasure|a-ha|Howard Jones'],
 ['COLLEGE ROCK / ALTERNATIVE ROCK','R.E.M.|The Replacements|The Smiths|Pixies|Sonic Youth|Jane\'s Addiction|Radiohead|Beck|Weezer|The Flaming Lips|Smashing Pumpkins|Liz Phair|Alanis Morissette|Hole|PJ Harvey|Tori Amos'],
 ['FUNK ROCK','Red Hot Chili Peppers|Living Colour|Faith No More|Fishbone|Mr. Bungle'],
 ['GRUNGE','Mudhoney|Nirvana|Pearl Jam|Soundgarden|Alice in Chains|Stone Temple Pilots|Screaming Trees|L7|Babes in Toyland'],
 ['NOISE ROCK','Big Black|The Jesus Lizard|Butthole Surfers|Shellac|Unwound|Drive Like Jehu'],
 ['SHOEGAZE / DREAM POP','My Bloody Valentine|Ride|Slowdive|Lush|Chapterhouse|Pale Saints|Cocteau Twins|Mazzy Star|Galaxie 500|Low'],
 ['GARAGE ROCK REVIVAL','The White Stripes|The Strokes|The Hives|The Vines|The Libertines|Yeah Yeah Yeahs|TV on the Radio'],
 ['BRITPOP','Suede|Blur|Oasis|Pulp|Elastica|Supergrass|Sleeper'],
 ['RAP ROCK / RAP METAL','Beastie Boys|Run-D.M.C.|Rage Against the Machine'],
 ['INDIE ROCK','Pavement|Built to Spill|Modest Mouse|Guided by Voices|Sebadoh|Dinosaur Jr.|Interpol|Arcade Fire|Death Cab for Cutie|The Shins|Spoon|Wilco'],
 ['MATH ROCK','Slint|Don Caballero|Gastr del Sol|June of 44'],
 ['POST-ROCK','Talk Talk|Tortoise|Godspeed You! Black Emperor|Mogwai|Explosions in the Sky|Sigur Rós|Calexico|Labradford'],
 ['POST-HARDCORE / EMO','Fugazi|At the Drive-In|Refused|Hot Snakes|Thursday|Sunny Day Real Estate|The Promise Ring|Get Up Kids|Jimmy Eat World|Dashboard Confessional|My Chemical Romance|Fall Out Boy'],
 ['ROOTS ROCK / HEARTLAND ROCK','Tom Waits|John Mellencamp|Los Lobos|Steve Earle'],
 ['REGGAE / SKA PUNK','The Specials|Madness|English Beat|No Doubt|Reel Big Fish|Less Than Jake|Sublime'],
 ['AMBIENT / SPACE ROCK','Brian Eno|Hawkwind|Spiritualized|Spacemen 3'],
 ['COUNTRY ROCK / AMERICANA','Gram Parsons|Emmylou Harris|Townes Van Zandt|Lucinda Williams|Uncle Tupelo|Whiskeytown|Ryan Adams'],
 ['NEW AMERICANA / INDIE FOLK','Elliott Smith|Iron & Wine|Sufjan Stevens|Devendra Banhart|Neutral Milk Hotel'],
 ['DANCE PUNK / POST-PUNK REVIVAL','LCD Soundsystem|!!!|The Rapture|Radio 4|Le Tigre'],
];
export const UNSORTED = 'UNSORTED';

export function norm(s){
  return String(s).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase()
    .replace(/&/g,' and ').replace(/[^a-z0-9]+/g,' ').trim().replace(/^the /,'');
}
const ARTIST_GENRE = new Map();
for (const [sec, list] of GENRE_SRC) for (const n of list.split('|')) { const k = norm(n); if (k && !ARTIST_GENRE.has(k)) ARTIST_GENRE.set(k, sec); }

export function cleanHeading(s){
  return s.replace(/\*\*|__/g,'').replace(/[:#\s]+$/,'').replace(/^[\s#]+/,'').replace(/\s+/g,' ').trim().toUpperCase();
}
/* "[x] Sub — Artist - Title (1999)" -> {artist,title,year,sub,owned} | null */
export function parseEntry(raw){
  let s = raw.replace(/\*\*|__|`/g,'').trim(), owned = null, m = s.match(/^\[( |x|X)\]\s*/);
  if (m){ owned = m[1] !== ' '; s = s.slice(m[0].length); }
  let sub = null; const i = s.indexOf(' \u2014 ');
  if (i > 0){ const pre = s.slice(0,i), rest = s.slice(i+3);
    if (!/ [-\u2013] /.test(pre) && / [-\u2013] /.test(rest)){ sub = pre.trim(); s = rest.trim(); } }
  let year = null; m = s.match(/\s*\((\d{4})\)\s*$/);
  if (m){ year = +m[1]; s = s.slice(0, m.index); }
  const sep = s.search(/ [-\u2013] /);
  if (sep < 1) return null;
  const artist = s.slice(0,sep).trim(), title = s.slice(sep+3).trim();
  return artist && title ? {artist, title, year, sub, owned} : null;
}
export function parseAlbums(text){
  const rows = [], skipped = []; let section = null, hadHeadings = false;
  String(text).replace(/^\uFEFF/,'').split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim(); if (!line) return;
    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(line) || /^<!--.*-->$/.test(line)) return;
    const b = line.match(/^(?:[*+\u2022\u00b7-]|\d+[.)])\s+(.+)$/);
    if (b){ const e = parseEntry(b[1]);
      if (e) rows.push({...e, section}); else skipped.push({n:i+1, text:line, reason:'unrecognised line'});
      return; }
    const h = line.match(/^#{1,6}\s+(.+)$/);
    if (!h && /\(\d{4}\)\s*$/.test(line)){ const e = parseEntry(line); if (e){ rows.push({...e, section}); return; } }
    const name = cleanHeading(h ? h[1] : line);
    if (name){ section = name; hadHeadings = true; }
  });
  return finalize(rows, skipped, hadHeadings);
}
export function finalize(rows, skipped = [], hadHeadings = false){
  const learned = new Map();            // artist -> Map(section -> count), from headed rows in this same file
  for (const r of rows) if (r.section){ const k = norm(r.artist); const m = learned.get(k) || new Map(); m.set(r.section, (m.get(r.section)||0)+1); learned.set(k, m); }
  const seen = new Set(), albums = [];
  rows.forEach((r) => {
    const id = norm(r.artist) + '|' + norm(r.title) + '|' + (r.year || '');
    if (seen.has(id)){ skipped.push({n:0, text:`${r.artist} - ${r.title}${r.year?` (${r.year})`:''}`, reason:'duplicate'}); return; }
    seen.add(id);
    let sec = r.section, inferred = false;
    if (!sec){
      const l = learned.get(norm(r.artist));
      if (l) sec = [...l.entries()].sort((a,b)=>b[1]-a[1])[0][0];
      else sec = ARTIST_GENRE.get(norm(r.artist)) || UNSORTED;
      inferred = true;
    }
    const album = {id, artist:r.artist, title:r.title, year:r.year, section:sec, sub:r.sub, mdOwned:r.owned === true, inferred};
    if (r.notes && String(r.notes).trim()) album.notes = String(r.notes).trim();
    albums.push(album);
  });
  return {albums, skipped, hadHeadings};
}
