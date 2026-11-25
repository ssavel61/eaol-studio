// Release-copy rules. Everything show-specific (links, newsletter, cadence,
// required chapter segments) comes from show.config.json; see show_config.mjs.
import { loadShowConfig, websiteHosts } from './show_config.mjs';

export const RELEASE_POLICY = 'generic-v1';
export const RELEASE_COPY_VERSION = 'generic-r1';

export function episodeNumber(episode) {
  const number = episode?.episode_assembly?.naming?.episode_number ?? episode?.naming?.episode_number
    ?? /^ep(\d+)(?:_|$)/.exec(episode?.slug || episode?.source_slug || '')?.[1];
  return Number.isInteger(Number(number)) && Number(number) > 0 ? Number(number) : null;
}

// Adds campaign tags to a link on the show's own website. Other hosts are refused.
export function websiteLink(value, source, number, config = loadShowConfig()) {
  const u = new URL(value);
  if (u.protocol !== 'https:' || !websiteHosts(config).includes(u.hostname) || u.username || u.password) {
    throw Error('Use an HTTPS link on the configured show website');
  }
  u.searchParams.set('utm_source', source);
  u.searchParams.set('utm_medium', config.release.utm_medium);
  u.searchParams.set('utm_campaign', `ep${String(number).padStart(3, '0')}`);
  return u.href;
}

const escapeRegExp = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function validateShortTitle(title, config = loadShowConfig()) {
  if (!title?.trim() || title.length > 100) throw Error('Use a topic-only title of 1–100 characters');
  const showName = new RegExp(escapeRegExp(config.show_name).replace(/\s+/g, '\\s*'), 'i');
  if (/#|\b(?:episode|ep\.?\s*\d)|\.mp4\b|\bep\d{2,}\b/i.test(title) || showName.test(title)) {
    throw Error('Short-video titles must be topic-only: no hashtags, show name, episode number or export filename');
  }
  return title;
}

export function chapterTitleWarnings(chapters) {
  return chapters.filter(c => c.title.length > 45).map(c => ({
    code: 'chapter_title_display_check', title: c.title, characters: c.title.length,
    message: 'Over the 45-character readability target. Preserve the approved segment/topic title and check actual platform display; do not silently shorten it.',
  }));
}

export function validateChapterTitleAuthority(chapters, approvedTitles) {
  if (!Array.isArray(approvedTitles) || !approvedTitles.length || chapters.length !== approvedTitles.length)
    throw Error('Supply the approved segment/topic title for every chapter');
  chapters.forEach((c, i) => {
    if (c.title !== approvedTitles[i]) throw Error(`Chapter ${i + 1} must retain its approved segment/topic title`);
  });
  return chapterTitleWarnings(chapters);
}

// Optional stricter chapter rules for a show with recurring segments. They apply
// only when release.chapters.enforce_from_episode is set and the episode number
// has reached it. The prefixes may appear in any order, but each must be used once
// by the opening chapters.
export function validateReleaseChapters(chapters, durationMs, number, config = loadShowConfig()) {
  const rules = config.release.chapters;
  if (!rules.enforce_from_episode || !number || number < rules.enforce_from_episode) return;
  if (chapters.length < rules.min_count || chapters.length > 100) throw Error(`Add at least ${rules.min_count} chapters`);
  if (chapters[0].start_ms !== 0) throw Error('The first segment must start at 00:00');
  const prefixes = rules.required_segment_prefixes;
  const normalize = value => String(value).replaceAll("'", '’');
  const used = new Set();
  for (const [i, c] of chapters.entries()) {
    if (!c.title?.trim() || c.title.length > 100) throw Error('Chapter titles must be 1–100 characters');
    if (i < prefixes.length) {
      const match = prefixes.find(prefix => normalize(c.title).startsWith(`${normalize(prefix)}:`));
      if (!match || used.has(match)) throw Error(`Chapter ${i + 1} must start with one of the configured segment names, each used once: ${prefixes.join(', ')}`);
      used.add(match);
    }
    if ((chapters[i + 1]?.start_ms ?? durationMs) - c.start_ms < rules.min_duration_seconds * 1000) {
      throw Error(`Every chapter must last at least ${rules.min_duration_seconds} seconds`);
    }
  }
}

const html = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function youtubeVideoId(value) {
  const u = new URL(value);
  if (u.protocol !== 'https:' || u.username || u.password) throw Error('Use an HTTPS YouTube watch URL');
  const id = u.hostname === 'youtu.be' ? u.pathname.slice(1)
    : ['www.youtube.com', 'youtube.com'].includes(u.hostname) && u.pathname === '/watch' ? u.searchParams.get('v') : null;
  if (!/^[\w-]{11}$/.test(id || '')) throw Error('Use a YouTube watch URL, not a Shorts or channel URL');
  return id;
}

export function buildReleaseCopy(input, config = loadShowConfig()) {
  const n = Number(input.episode_number);
  if (!Number.isInteger(n) || n < 1 || n > 9999) throw Error('Enter the real episode number');
  const title = String(input.title || '').trim(), summary = String(input.summary || '').trim();
  if (!title || title.length > 180 || !summary || summary.length > 3500) throw Error('Enter the topic-first title and a summary of up to 3,500 characters');
  if (/^(?:Episode|Ep\.)\s*\d|\|\s*Ep\./i.test(title)) throw Error('Enter the canonical title without episode numbering');
  const youtubeTitle = `${title} | Ep. ${n}`;
  if (youtubeTitle.length > 100) throw Error('The complete YouTube title must be within 100 characters');
  const yt = String(input.youtube_url || '').trim();
  if (yt) youtubeVideoId(yt);
  const pinned = String(input.pinned_comment || '').trim(), endVideo = String(input.end_screen_video_url || '').trim(), endPlaylist = String(input.end_screen_playlist_url || '').trim();
  if (pinned.length > 1000) throw Error('Keep the pinned-comment draft within 1,000 characters');
  if (endVideo) { const id = youtubeVideoId(endVideo); if (yt && id === youtubeVideoId(yt)) throw Error('The end screen must point to a different full episode'); }
  if (endPlaylist) {
    const u = new URL(endPlaylist);
    if (u.protocol !== 'https:' || u.username || u.password || !['youtube.com', 'www.youtube.com'].includes(u.hostname) || u.pathname !== '/playlist' || !/^[\w-]{10,80}$/.test(u.searchParams.get('list') || '')) throw Error('Use the full podcast playlist URL for the end screen');
  }
  const sources = String(input.article_urls || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  for (const value of sources) { const u = new URL(value); if (u.protocol !== 'https:' || u.username || u.password) throw Error('Article links must use HTTPS without embedded credentials'); }
  const chapters = String(input.chapters || '').trim();
  const { links } = config, ownHosts = websiteHosts(config);
  const own = value => ownHosts.includes(new URL(value).hostname);
  const tagged = (value, source) => (own(value) ? websiteLink(value, source, n, config) : value);
  const listen = [
    links.apple_podcasts && ['Listen and follow on Apple Podcasts', links.apple_podcasts],
    links.spotify && ['Listen and follow on Spotify', links.spotify],
  ].filter(Boolean);
  const newsletter = links.newsletter ? [`Subscribe to ${links.newsletter_name || 'the newsletter'}`, links.newsletter] : null;
  const youtube = [
    summary,
    [`Explore the podcast: ${tagged(links.website, 'youtube')}`, newsletter && `${newsletter[0]}: ${tagged(newsletter[1], 'youtube')}`].filter(Boolean).join('\n'),
    ...sources.map(u => `Discussed in this episode: ${tagged(u, 'youtube')}`),
    listen.map(([label, url]) => `${label}: ${url}`).join('\n'),
    chapters,
    config.release.cadence_line,
  ].filter(Boolean).join('\n\n');
  const link = (label, url) => `<p><a href="${html(url)}">${html(label)}</a></p>`;
  const feed = `<p>${html(summary).replaceAll('\n', '<br>')}</p>`
    + (newsletter ? link(newsletter[0], tagged(newsletter[1], 'podcast_feed')) : '')
    + (yt ? link('Watch this episode on YouTube', yt) : '<p>[Add this episode’s YouTube link before scheduling]</p>')
    + listen.map(([label, url]) => link(label, url)).join('')
    + link('Explore the podcast', tagged(links.website, 'podcast_feed'))
    + sources.map(u => link('Discussed in this episode', tagged(u, 'podcast_feed'))).join('')
    + (chapters ? `<p>${html(chapters).replaceAll('\n', '<br>')}</p>` : '');
  if (feed.length > 4000) throw Error(`Show-notes HTML is ${feed.length} characters; shorten it to 4,000 or fewer`);
  const missing = [...(!yt ? ['Add the scheduled YouTube URL'] : []), ...(!chapters ? ['Add approved chapters'] : []), ...(!pinned ? ['Draft the channel’s pinned question'] : []), ...(!endVideo ? ['Choose the previous or next full episode for the end screen'] : []), ...(!endPlaylist ? ['Add the podcast playlist URL for the end screen'] : [])];
  return {
    policy: RELEASE_POLICY, generator_version: RELEASE_COPY_VERSION,
    titles: { canonical: title, youtube: youtubeTitle, podcast_rss: title },
    youtube_description: youtube, spotify_html: feed, spotify_characters: feed.length,
    chapter_warnings: chapterTitleWarnings(chapters.split(/\r?\n/).filter(Boolean).map(line => ({ title: line.replace(/^\d{1,3}:\d{2}(?::\d{2})?\s+/, '') }))),
    pinned_comment: pinned,
    end_screen: { duration_seconds: 20, subscribe: true, video_url: endVideo, playlist_url: endPlaylist, verify: 'Confirm the video is a full episode, the playlist is the show’s podcast playlist, and the outro leaves room for all three elements.' },
    missing, pending: [...missing, 'Approve the title, copy and exact platform upload separately'], editorial_approval: 'pending', publication_authorized: false,
  };
}
